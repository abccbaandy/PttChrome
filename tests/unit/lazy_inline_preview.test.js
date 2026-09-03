// 好讀自動開圖的延遲載入／遠離卸載（src/render/inline_preview_slot.js ＋
// src/js/lazy_media.js）。
//
// 背景：好讀把整篇累積成一長頁並對每個連結掛 inline 預覽。實錄的 EZsoft 長文有
// 287 個圖片連結，舊行為是一累積到就全部解析＋下載＋解碼、到離開文章前永不釋放
// —— 已解碼的點陣圖是「記憶體吃滿」的最大宗。
//
// 這裡守護的重點是**連 requestPreview() 都不能先呼叫**：它一被呼叫就開始解析網址
// （imgur 無副檔名的還會發兩個 HEAD 探測），所以單純給 <img> 加 loading="lazy"
// 沒有用，延遲必須做在整個預覽元件的掛載上。

import {
  nextLazyState,
  recordSlotAspect,
  recordSlotHeight,
  slotFloorHeight,
  LAZY_MOUNT_MARGIN_PX,
  LAZY_UNMOUNT_MARGIN_PX,
} from "../../src/js/lazy_media";

const spies = vi.hoisted(() => ({ requestPreview: 0 }));

vi.mock("../../src/components/ImagePreviewer", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    requestPreview: (href) => {
      ++spies.requestPreview;
      return actual.requestPreview(href);
    },
  };
});

const {
  createInlinePreviewSlot,
  invalidateInlinePreviewHeights,
  resetLazyObserversForTest,
  SIZE_MEMO_MAX,
} = await import("../../src/render/inline_preview_slot");

// 舊版是 React 元件 + PreviewSizeModeContext；純 JS 版是一個 slot 物件，尺寸模式
// 由 ScreenController 直接呼叫 setSizeMode() 廣播。掛進 document 好讓 .remove()
// 與 offsetHeight 的覆寫行為與真實情境一致。
function mountSlot(href, sizeMode) {
  const slot = createInlinePreviewSlot(href, sizeMode);
  document.body.appendChild(slot.el);
  liveSlots.push(slot);
  return slot;
}
const liveSlots = [];
function destroySlots() {
  while (liveSlots.length) {
    const s = liveSlots.pop();
    s.destroy();
    s.el.remove();
  }
}

// 假 IntersectionObserver：記下每個 root margin 建立的 observer，測試自己決定
// 什麼時候回報相交/不相交。
const observers = [];
class FakeIO {
  constructor(cb, opts) {
    this.cb = cb;
    this.rootMargin = opts && opts.rootMargin;
    this.targets = new Set();
    observers.push(this);
  }
  observe(el) {
    this.targets.add(el);
  }
  unobserve(el) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
  emit(isIntersecting) {
    this.cb(
      Array.from(this.targets).map((target) => ({ target, isIntersecting })),
      this,
    );
  }
}

// 假 ResizeObserver：媒體載入完成／點圖改尺寸時，元件靠它把「這個模式下的實際高度」
// 記起來。測試自己決定什麼時候回報尺寸變化。
const sizeObservers = [];
class FakeRO {
  constructor(cb) {
    this.cb = cb;
    this.targets = new Set();
    sizeObservers.push(this);
  }
  observe(el) {
    this.targets.add(el);
  }
  unobserve(el) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
  emit() {
    this.cb(
      Array.from(this.targets).map((target) => ({ target })),
      this,
    );
  }
}

const resized = () => sizeObservers[sizeObservers.length - 1];

const near = () =>
  observers.find((o) => o.rootMargin.startsWith(String(LAZY_MOUNT_MARGIN_PX)));
const far = () =>
  observers.find((o) =>
    o.rootMargin.startsWith(String(LAZY_UNMOUNT_MARGIN_PX)),
  );

describe("nextLazyState / recordSlotHeight（純決策）", () => {
  test("尚未掛載且接近視野 ⇒ mount", () => {
    expect(nextLazyState({ mounted: false, near: true, far: false })).toBe(
      "mount",
    );
  });
  test("已掛載且遠離視野 ⇒ unmount", () => {
    expect(nextLazyState({ mounted: true, near: false, far: true })).toBe(
      "unmount",
    );
  });
  test("遲滯區（離開視野但還沒到卸載邊界）⇒ keep", () => {
    expect(nextLazyState({ mounted: true, near: false, far: false })).toBe(
      "keep",
    );
  });
  test("尚未掛載又還沒接近 ⇒ keep（不會為了卸載而掛載）", () => {
    expect(nextLazyState({ mounted: false, near: false, far: true })).toBe(
      "keep",
    );
  });
  test("卸載邊界必須遠大於掛載邊界，否則會來回重載", () => {
    expect(LAZY_UNMOUNT_MARGIN_PX).toBeGreaterThan(LAZY_MOUNT_MARGIN_PX * 2);
  });
  test("量不到高度（還沒載完就被捲過去）⇒ 保留舊值，不要歸零", () => {
    const prev = { normal: 320 };
    expect(recordSlotHeight(prev, "normal", 0, true)).toBe(prev);
    expect(recordSlotHeight(prev, "normal", 480, true)).toEqual({
      normal: 480,
    });
  });
  test("值沒變 ⇒ 回傳同一個物件（ResizeObserver 高頻呼叫，靠參考相同 bail out）", () => {
    const prev = { normal: 320 };
    expect(recordSlotHeight(prev, "normal", 320, true)).toBe(prev);
  });
  // 使用者實測（ptt-debug-20260812-010606）：每篇文章「※ 文章網址」那行底下都多出
  // 一塊約 65px 的空白，推文區被往下推。成因＝該行的 URL（PTT 文章 HTML 頁，不是
  // 媒體）也掛了預覽 slot，捲過去時顯示「讀取中…」指示器，判定非媒體後內容消失，
  // 但卸載當下量到的正是那個指示器的高度 → 被釘進 min-height 變成永久空白。
  // 釘高度的唯一正當理由是「真的有媒體、卸載後會塌陷」；loading/error/非媒體都不算。
  test("slot 內沒有真媒體（讀取中／載入失敗／根本不是媒體）⇒ 不得記高度", () => {
    expect(recordSlotHeight(null, "normal", 65, false)).toBe(null);
    // 已經記過的真實高度不因一次 no-media 量測被覆寫
    const prev = { normal: 570 };
    expect(recordSlotHeight(prev, "normal", 65, false)).toBe(prev);
  });

  // 使用者實測（ptt-debug-20260815-112407）：放大 → 往下捲 → 縮小 → 捲回上方。
  // 兩個症狀同源，都是「同一張圖在兩種模式下高度差好幾倍」：
  //   1. 不分模式套用 ⇒ 放大態的高度留到縮小態＝空白（第一版回報）
  //   2. 模式不符就丟掉 ⇒ 佔位盒塌陷，往上捲時圖撐開把上方內容推走＝跳頁（第二版回報）
  // 正解是兩種模式各記一組實測值，切過去就換一組。
  describe("分模式記高度", () => {
    test("兩種模式各記各的，互不覆寫", () => {
      let p = recordSlotHeight(null, "normal", 570, true);
      p = recordSlotHeight(p, "enlarged", 908, true);
      expect(p).toEqual({ normal: 570, enlarged: 908 });
      expect(slotFloorHeight(p, "normal")).toBe(570);
      expect(slotFloorHeight(p, "enlarged")).toBe(908);
    });
    test("只有另一種模式量過 ⇒ 這個模式不套（沒有值可用，不得拿別的模式的頂替）", () => {
      const p = recordSlotHeight(null, "enlarged", 908, true);
      expect(slotFloorHeight(p, "normal")).toBeUndefined();
    });
    test("從未量過／高度無效 ⇒ 不套", () => {
      expect(slotFloorHeight(null, "normal")).toBeUndefined();
      expect(slotFloorHeight({ normal: 0 }, "normal")).toBeUndefined();
    });
  });

  // 分模式記高度仍有缺口：使用者往下捲時那幾張圖**只**在放大態載入過，normal 高度
  // 從沒機會被量到 ⇒ 點縮小再往上捲照樣塌陷。原尺寸與模式無關，記一次就兩種模式
  // 都能用（替身盒交給 CSS 用同一組規則算高度）。
  describe("recordSlotAspect（原尺寸）", () => {
    test("單一媒體 ⇒ 記下原尺寸", () => {
      expect(recordSlotAspect(null, 1, 800, 600)).toEqual({ w: 800, h: 600 });
    });
    test("值沒變 ⇒ 回傳同一個物件", () => {
      const prev = { w: 800, h: 600 };
      expect(recordSlotAspect(prev, 1, 800, 600)).toBe(prev);
    });
    test("相簿（多媒體）⇒ 不記（單一比例代表不了整盒）", () => {
      expect(recordSlotAspect(null, 3, 800, 600)).toBe(null);
    });
    test("拿不到原尺寸（iframe／尚未載入）⇒ 不記", () => {
      expect(recordSlotAspect(null, 1, 0, 0)).toBe(null);
      const prev = { w: 800, h: 600 };
      expect(recordSlotAspect(prev, 1, 0, 0)).toBe(prev);
    });
  });
});

// ------------------------------------------------------------------ 疊層佔位
// slot 的 DOM 是三層（見 src/render/inline_preview_slot.js 檔頭）：
//   .inlinePreviewSlot           display:grid（**runtime 永不寫 inline style**）
//     .inlinePreviewContent      真內容（React root / 真圖 / 讀取中指示器）
//     .inlinePreviewSpacer       佔位高度（min-height）＋替身盒
// 兩層疊在同一個 grid area ⇒ slot 高度 = max(內容, 佔位)。jsdom 沒有排版，所以這裡
// 用 laidOutHeight() 把那條 CSS 合約模型化（真瀏覽器端由 offline e2e 守）。
const contentOf = (slotEl) => slotEl.querySelector(".inlinePreviewContent");
const spacerOf = (slotEl) => slotEl.querySelector(".inlinePreviewSpacer");
// 寫進 spacer 的佔位高度（＝舊版寫在 slot 自己 min-height 上的那個值）。
const floorOf = (slotEl) => spacerOf(slotEl).style.minHeight;
const contentKids = (slotEl) => contentOf(slotEl).children.length;

function fakeHeight(node, height) {
  Object.defineProperty(node, "offsetHeight", {
    configurable: true,
    value: height,
  });
}

// grid 疊層的高度合約：max(內容, max(spacer 的 min-height, 替身盒))。
function laidOutHeight(slotEl) {
  const spacer = spacerOf(slotEl);
  const ghost = spacer.querySelector(".inlinePreviewGhost");
  return Math.max(
    contentOf(slotEl).offsetHeight,
    parseInt(spacer.style.minHeight, 10) || 0,
    ghost ? ghost.offsetHeight : 0,
  );
}

describe("延遲載入佔位盒（掛載/卸載）", () => {
  const HREF = "https://i.imgur.com/abcdefg.jpg";

  beforeEach(() => {
    observers.length = 0;
    sizeObservers.length = 0;
    spies.requestPreview = 0;
    resetLazyObserversForTest();
    global.IntersectionObserver = FakeIO;
    global.ResizeObserver = FakeRO;
  });

  afterEach(() => {
    destroySlots();
    delete global.IntersectionObserver;
    delete global.ResizeObserver;
    resetLazyObserversForTest();
  });

  test("還沒進入視野 ⇒ 佔位盒是空的，且 requestPreview 一次都沒被呼叫", () => {
    const slot = mountSlot(HREF).el;
    expect(slot).not.toBeNull();
    expect(contentKids(slot)).toBe(0);
    expect(spies.requestPreview).toBe(0);
  });

  test("接近視野 ⇒ 掛上預覽（此時才解析網址）", () => {
    const slot = mountSlot(HREF).el;
    near().emit(true);
    expect(spies.requestPreview).toBe(1);
    expect(contentKids(slot)).toBeGreaterThan(0);
  });

  // jsdom 沒有排版也沒有網路：offsetHeight 恆為 0，ImagePreviewer 也停在「讀取中」。
  // 釘高度的前提是「slot 內真的有媒體、卸載後會塌陷」，所以要複現該情境就得把兩件
  // 事都做出來：偽造高度 ＋ 放一個真媒體節點（React 只管自己 render 的 children，
  // 手動 append 的節點不會被卸載動作移除，正好模擬「圖已經載出來了」）。
  function fakeLoadedMedia(slot, height, natural) {
    fakeHeight(contentOf(slot), height);
    const img = document.createElement("img");
    img.className = "easyReadingImg hyperLinkPreview";
    if (natural) {
      // jsdom 不解碼圖片 ⇒ naturalWidth/Height 恆為 0，要自己給。
      Object.defineProperty(img, "naturalWidth", { value: natural.w });
      Object.defineProperty(img, "naturalHeight", { value: natural.h });
    }
    // 「已經佔到版面」的判準（hasLoadedMedia）：載入完成前的 <img> 是 display:none，
    // 那時量到的是「讀取中…」指示器的高度，不能記。
    fakeHeight(img, height);
    contentOf(slot).appendChild(img);
    return img;
  }

  // 內容層的高度（讀取中指示器／載入失敗提示／真圖都走這裡）。
  const setContentHeight = (slot, height) => fakeHeight(contentOf(slot), height);

  // 改變 slot（與其內媒體）當下的高度，模擬點圖放大／縮小造成的尺寸變化。
  function resizeTo(slot, height) {
    fakeHeight(contentOf(slot), height);
    const img = slot.querySelector("img");
    if (img) fakeHeight(img, height);
  }

  test("遠離視野 ⇒ 卸載，並把卸載前的高度釘進佔位盒（閱讀位置不位移）", () => {
    const slot = mountSlot(HREF).el;
    near().emit(true);
    
    const img = fakeLoadedMedia(slot, 420);
    far().emit(false);
    img.remove(); // 媒體隨卸載消失
    expect(contentKids(slot)).toBe(0);
    // 佔位高度寫在 spacer，**不是** slot 自己（那會抑制瀏覽器的捲動補償）。
    expect(floorOf(slot)).toBe("420px");
    expect(slot.getAttribute("style")).toBeNull();
  });

  test("捲回來 ⇒ 重新掛載，佔位高度保留", () => {
    const slot = mountSlot(HREF).el;
    near().emit(true);
    const img = fakeLoadedMedia(slot, 420);
    far().emit(false);
    img.remove();
    expect(contentKids(slot)).toBe(0);
    far().emit(true); // 回到卸載邊界之內
    near().emit(true);
    expect(contentKids(slot)).toBeGreaterThan(0);
    expect(floorOf(slot)).toBe("420px");
  });

  // 症狀級回歸（使用者實測 ptt-debug-20260815-112407）。完整走一遍回報的動線：
  //   縮小態看過這張圖 → 點圖放大 → 往下捲到卸載 → 點縮小 → 再往上捲。
  // 兩個症狀都在最後一步現形，且互為代價，必須同時擋下：
  //   (1) 佔位盒沿用放大態的高度 ⇒ 圖片下方一塊約等於放大後高度的空白
  //   (2) 佔位盒歸零 ⇒ 往上捲時圖一張張掛回來撐開，把上方內容推走 ⇒ 跳頁
  // 正解：兩種模式各記一組實測高度，切回去就用那一組。
  test("放大→捲遠→縮小：佔位盒換用縮小態的高度（不留空白，也不塌陷）", () => {
    const handle = mountSlot(HREF, "normal");
    const slot = handle.el;
    const rerender = (mode) => handle.setSizeMode(mode);
    
    near().emit(true);
    // 縮小態把圖載出來 → 這個模式的高度被記下（關鍵：不必等到卸載）
    fakeLoadedMedia(slot, 570);
    resized().emit();

    // 點圖放大：同一張圖變成 908
    rerender("enlarged");
    resizeTo(slot, 908);
    resized().emit();
    expect(floorOf(slot)).toBe("908px");

    // 往下捲到卸載（放大態）
    const img = slot.querySelector("img");
    far().emit(false);
    img.remove();
    expect(contentKids(slot)).toBe(0);
    expect(floorOf(slot)).toBe("908px");

    // 點縮小 ⇒ 換用縮小態量到的 570：不是 908（空白），也不是 0（塌陷→跳頁）
    rerender("normal");
    expect(floorOf(slot)).toBe("570px");

    // 切回放大 ⇒ 回到 908
    rerender("enlarged");
    expect(floorOf(slot)).toBe("908px");
  });

  // 使用者往下捲時，那幾張圖**只**在放大態載入過 ⇒ normal 高度沒機會被量到。
  // 這時不得拿放大態的值頂替（＝空白），也不能什麼都不放（＝塌陷跳頁）：要留下同比例
  // 的替身盒，讓 CSS 用真圖那組規則算出縮小態該有的高度。
  test("只在放大態量過 ⇒ 切到縮小態改由替身盒佔位（不套放大態高度）", () => {
    const handle = mountSlot(HREF, "enlarged");
    const slot = handle.el;
    const rerender = (mode) => handle.setSizeMode(mode);
    
    near().emit(true);
    const img = fakeLoadedMedia(slot, 908, { w: 800, h: 600 });
    resized().emit();
    expect(floorOf(slot)).toBe("908px");

    far().emit(false); // 往下捲到卸載
    img.remove();
    rerender("normal"); // 點縮小
    expect(floorOf(slot)).toBe("");

    // 替身盒住在 spacer 裡（不是內容層）：疊層取 max，掛載時才不會塌陷。
    const ghost = spacerOf(slot).querySelector(".inlinePreviewGhost");
    expect(ghost).not.toBeNull();
    // 關鍵：掛的是跟真圖同一個 class，高度才會由同一組 CSS 規則算出來。
    expect(ghost.classList.contains("easyReadingImg")).toBe(true);
    expect(ghost.style.aspectRatio).toBe("800 / 600");
    expect(ghost.style.getPropertyValue("--ghost-w")).toBe("800px");
  });

  // 替身盒的存活條件是「**內容裡有沒有真的佔到版面的媒體**」，不是「有沒有掛載」。
  // 舊版在 mount() 當下就把替身盒拿掉，可是那一刻 content 只有 56px 的「讀取中…」
  // 指示器 —— 圖還要解析網址＋下載＋解碼才會出現（imgur 台灣連線常 stall，產品端
  // 又沒有載入 timeout）⇒ 一次 438px 的塌陷。疊層之後替身盒繼續頂在 spacer 裡，
  // 直到真圖佔到版面才讓位。
  test("替身盒頂到真圖佔到版面為止：掛載當下不讓位（那時只有讀取中指示器）", () => {
    const slot = mountSlot(HREF).el;
    near().emit(true);
    const img = fakeLoadedMedia(slot, 570, { w: 800, h: 600 });
    resized().emit();
    expect(slot.querySelector(".inlinePreviewGhost")).toBeNull();

    far().emit(false);
    img.remove();
    expect(slot.querySelector(".inlinePreviewGhost")).not.toBeNull();

    // 捲回來重新掛載：content 只有「讀取中…」⇒ 替身盒**不得**在這時退場。
    far().emit(true);
    near().emit(true);
    setContentHeight(slot, 56);
    resized().emit();
    expect(slot.querySelector(".inlinePreviewGhost")).not.toBeNull();

    // 真圖畫出來了 ⇒ 讓位。
    fakeLoadedMedia(slot, 570, { w: 800, h: 600 });
    resized().emit();
    expect(slot.querySelector(".inlinePreviewGhost")).toBeNull();
  });

  // 載入完成前 <img> 已在 DOM 裡但 display:none，量到的是「讀取中…」指示器的高度。
  // 記進去就是假空白（同 ask-urlline-blank 那個 65px 實例）。
  test("媒體還沒載完（img 尚未佔到版面）⇒ 尺寸回報不得記高度", () => {
    const slot = mountSlot(HREF).el;
    near().emit(true);
    setContentHeight(slot, 65); // 「讀取中…」指示器
    const img = document.createElement("img");
    img.className = "easyReadingImg hyperLinkPreview";
    fakeHeight(img, 0);
    contentOf(slot).appendChild(img);
    resized().emit();
    expect(floorOf(slot)).toBe("");
  });

  // 症狀級回歸（使用者實測：每篇文章推文區前面多一塊空白）。
  // 「※ 文章網址」那行的 URL 是 PTT 文章 HTML 頁，不是媒體：捲過去只會顯示
  // 「讀取中…」指示器，判定後內容消失。卸載時**不得**把那個指示器的高度釘住，
  // 否則變成永久假空白，而且非媒體連結永遠不會再長出內容來填它。
  test("非媒體連結（slot 內只有讀取中指示器）卸載 ⇒ 不留 min-height", () => {
    const slot = mountSlot("https://www.ptt.cc/bbs/ask/M.1786465191.A.DBD.html").el;
    near().emit(true);
    
    // 「讀取中…」指示器撐出的高度（實測 65px），slot 內沒有任何媒體元素。
    setContentHeight(slot, 65);
    expect(slot.querySelector("img, video, iframe")).toBeNull();
    far().emit(false);
    expect(floorOf(slot)).toBe("");
    // 也不得留下替身盒（從沒載成功過 ⇒ 沒有 aspect ⇒ 永遠不會長出內容來填）。
    expect(slot.querySelector(".inlinePreviewGhost")).toBeNull();
  });

  // ---------------------------------------------------------------------
  // 症狀級回歸（使用者回報 2026-09-03）：「多圖時在讀圖，按 PgUp 卻捲不上去，甚至
  // 來回跳」。根因不是捲動計算，是**我們自己把瀏覽器的捲動補償關掉了**：
  // 佔位高度寫在 slot 自己的 min-height 上，而讀者停在圖片中間時捲動錨點就在那個
  // slot 裡 ⇒ 命中 CSS Scroll Anchoring 的 suppression trigger ⇒ 當幀不補償 ⇒
  // 上方 slot 一塌陷（替身盒 494 → 讀取中 56，實測 438px＝一次 PgUp 的 76.6%）
  // 讀者就被整整推走那麼多，兩張圖吃掉一整次 PgUp。
  // 修法（B2）：grid 疊層，佔位高度改寫在 spacer（**兄弟**節點），slot/content 全程
  // 零 inline style ⇒ 補償照常生效；順帶讓替身盒撐過整個載入中，掛載當幀不塌陷。
  // 真瀏覽器端的守護在 tests/e2e/offline/easy_reading_scroll_jump.offline.spec.js。

  test("掛載那一刻高度不得塌陷（替身盒讓位給讀取中指示器＝438px 的來源）", () => {
    const handle = mountSlot(HREF, "enlarged");
    const slot = handle.el;

    // 放大態看過這張圖（量到 aspect），往下捲卸載，再點縮小 ——
    // normal 這格從沒量過 ⇒ pinned 為空，佔位完全靠替身盒。這正是既有測試
    // 「只在放大態量過 ⇒ 切到縮小態改由替身盒佔位」的收尾狀態。
    near().emit(true);
    const img = fakeLoadedMedia(slot, 908, { w: 800, h: 600 });
    resized().emit();
    far().emit(false);
    img.remove();
    handle.setSizeMode("normal");
    expect(floorOf(slot)).toBe("");

    const ghost = slot.querySelector(".inlinePreviewGhost");
    expect(ghost).not.toBeNull();
    fakeHeight(ghost, 494); // CSS 依原尺寸在縮小態算出來的高度
    setContentHeight(slot, 0);
    expect(laidOutHeight(slot)).toBe(494);

    // 往上捲回來 ⇒ 重新掛載。此刻 content 只有 56px 的「讀取中…」指示器。
    far().emit(true);
    near().emit(true);
    setContentHeight(slot, 56);
    resized().emit();
    // 舊行為：mount() 立刻拿掉替身盒 ⇒ 494 → 56，一次塌陷 438px。
    expect(laidOutHeight(slot)).toBe(494);
  });

  test("捲動錨點的祖先（slot / content）全程不得有 inline style", () => {
    const handle = mountSlot(HREF, "normal");
    const slot = handle.el;
    const clean = (step) => {
      expect(slot.getAttribute("style"), step).toBeNull();
      expect(contentOf(slot).getAttribute("style"), step).toBeNull();
    };
    clean("建立");
    near().emit(true);
    clean("mount");
    const img = fakeLoadedMedia(slot, 570, { w: 800, h: 600 });
    resized().emit();
    clean("onResize（量到高度）");
    handle.setSizeMode("enlarged");
    clean("setSizeMode");
    far().emit(false);
    img.remove();
    clean("unmount");

    // 不是「沒人寫高度」才乾淨 —— 高度確實記著，只是寫在 spacer 上。
    handle.setSizeMode("normal");
    expect(floorOf(slot)).toBe("570px");
    clean("setSizeMode（套用 570）");

    handle.invalidatePinned();
    expect(floorOf(slot)).toBe("");
    clean("invalidatePinned");
  });

  test("佔位高度寫在 spacer 上，slot 高度取 max 不是相加", () => {
    measureThenDiscard(HREF, 494);
    const slot = mountSlot(HREF).el;
    expect(floorOf(slot)).toBe("494px");
    expect(slot.getAttribute("style")).toBeNull();

    // 內容比佔位矮（讀取中指示器）⇒ 由佔位撐住。
    setContentHeight(slot, 56);
    expect(laidOutHeight(slot)).toBe(494);
    // 內容比佔位高（放大態的長圖）⇒ 取內容，**不是** 494 + 700。
    setContentHeight(slot, 700);
    expect(laidOutHeight(slot)).toBe(700);
  });

  test("遲滯：只是離開視野（還在卸載邊界內）不卸載", () => {
    const slot = mountSlot(HREF).el;
    near().emit(true);
    near().emit(false); // 捲出視野，但 far 仍相交
    expect(contentKids(slot)).toBeGreaterThan(0);
  });

  test("環境沒有 IntersectionObserver ⇒ 立即掛載（行為與沒這功能時相同）", () => {
    delete global.IntersectionObserver;
    resetLazyObserversForTest();
    const slot = mountSlot(HREF).el;
    expect(spies.requestPreview).toBe(1);
    expect(contentKids(slot)).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------
  // 症狀級回歸（f9fef96b 的延伸）：推文者高亮已改走 class 層，但**任何會改動
  // annotationsKey 的操作**（AI 校正逐筆回填、圖文並排、黑名單、樓號、字級…）
  // 仍然全量重建每一列 ⇒ 舊 slot 被 disposeNode 收掉、新 slot 的 pinned/aspect
  // 從 null 開始 ⇒ 整份長頁的圖片佔位盒同時塌陷再非同步撐回來（閃爍＋跳頁）。
  // 修法是把量測結果存進 module 級 memo（鍵＝href），重建的 slot 第一幀就有高度。

  // 量到高度（＋原尺寸）之後把節點丟掉，模擬「這一列被重建」。刻意不走
  // near().emit(true)：ResizeObserver 那條路不必掛 React 就能記錄，跑 500 次也快。
  function measureThenDiscard(href, height, natural) {
    const handle = mountSlot(href);
    fakeLoadedMedia(handle.el, height, natural);
    resized().emit();
    handle.destroy();
    handle.el.remove();
    liveSlots.splice(liveSlots.indexOf(handle), 1);
  }

  describe("重建後沿用同 href 的量測", () => {
    test("重建的 slot 一開始就有 minHeight（不必等任何 observer 回報）", () => {
      measureThenDiscard(HREF, 570);
      // 重建：**不發任何 observer 事件**，第一幀就該撐住。
      const rebuilt = mountSlot(HREF).el;
      expect(floorOf(rebuilt)).toBe("570px");
    });

    test("走完整的掛載→捲遠卸載也一樣記得（卸載前那次量測要回寫）", () => {
      const handle = mountSlot(HREF);
      near().emit(true);
      const img = fakeLoadedMedia(handle.el, 420);
      far().emit(false);
      img.remove();
      handle.destroy();
      handle.el.remove();
      liveSlots.splice(liveSlots.indexOf(handle), 1);

      expect(floorOf(mountSlot(HREF).el)).toBe("420px");
    });

    test("原尺寸也沿用 ⇒ 重建的 slot 直接有替身盒（沒量過的模式也佔得準）", () => {
      measureThenDiscard(HREF, 570, { w: 800, h: 600 });
      const rebuilt = mountSlot(HREF, "enlarged").el;
      const ghost = spacerOf(rebuilt).querySelector(".inlinePreviewGhost");
      expect(ghost).not.toBeNull();
      expect(ghost.classList.contains("easyReadingImg")).toBe(true);
      expect(ghost.style.aspectRatio).toBe("800 / 600");
      expect(ghost.style.getPropertyValue("--ghost-w")).toBe("800px");
      // enlarged 這格沒量過 ⇒ 不得拿 normal 的頂替，交給替身盒。
      expect(floorOf(rebuilt)).toBe("");
    });

    test("不得跨連結借高度（memo 以 href 為鍵）", () => {
      measureThenDiscard(HREF, 570);
      expect(floorOf(mountSlot("https://i.imgur.com/zzzzzzz.jpg").el)).toBe("");
    });

    test("memo 有上限：最舊的 href 被淘汰（長文 287 張圖 × 多篇不得無限長大）", () => {
      measureThenDiscard(HREF, 570);
      for (let i = 0; i < SIZE_MEMO_MAX; ++i) {
        measureThenDiscard(`https://i.imgur.com/pad${i}.jpg`, 100 + i);
      }
      expect(floorOf(mountSlot(HREF).el)).toBe("");
      // 最近一筆仍在。
      const last = SIZE_MEMO_MAX - 1;
      expect(floorOf(mountSlot(`https://i.imgur.com/pad${last}.jpg`).el)).toBe(
        `${100 + last}px`,
      );
    });
  });

  // 疊層之後 slot 的高度是 max(內容, 佔位)，而**量的是內容層**。這個 fake 把兩者
  // 都做出來：slot 會被佔位撐高，content 永遠只回內容自己的高度。
  function fakeLaidOutMedia(slot, contentHeight) {
    fakeHeight(contentOf(slot), contentHeight);
    const img = document.createElement("img");
    img.className = "easyReadingImg hyperLinkPreview";
    fakeHeight(img, contentHeight);
    contentOf(slot).appendChild(img);
    return img;
  }

  // 版面**寬度**改變（字級／視窗 resize、圖左字右合併切換）之後，pinned 就是舊寬度
  // 下的值。aspect 與寬度無關（替身盒交給 CSS 用真圖那組規則算），所以分開處理。
  describe("版面寬度改變 ⇒ pinned 過期", () => {
    // 舊版把佔位高度寫在 slot 自己的 min-height 上，量 slot.offsetHeight 就會量到
    // 被自己墊高的值 ⇒ 一個過期偏大的高度會被原封不動再記一次＝自我增強的永久假
    // 空白（舊 code 得靠「量之前先拿掉 min-height、量完再放回」硬繞）。疊層之後量
    // 的是 content，而 content 從來沒有 inline style ⇒ 這條路徑隨結構消失。
    test("量的是內容層 ⇒ 過期的佔位高度不會自我增強成永久假空白", () => {
      // memo 帶進一個舊寬度下量到的 570，但這一次的真實內容只有 320。
      measureThenDiscard(HREF, 570);
      const handle = mountSlot(HREF);
      expect(floorOf(handle.el)).toBe("570px");
      fakeLaidOutMedia(handle.el, 320);
      resized().emit();
      expect(floorOf(handle.el)).toBe("320px");
      expect(contentOf(handle.el).getAttribute("style")).toBeNull();
    });

    test("有替身盒可頂 ⇒ 作廢 pinned（改由 CSS 在新寬度下重算）", () => {
      measureThenDiscard(HREF, 570, { w: 800, h: 600 });
      invalidateInlinePreviewHeights();
      const rebuilt = mountSlot(HREF).el;
      expect(floorOf(rebuilt)).toBe("");
      expect(rebuilt.querySelector(".inlinePreviewGhost")).not.toBeNull();
    });

    test("沒有替身盒（iframe／相簿）⇒ 留著舊值當最佳猜測，不換來一次無謂的塌陷", () => {
      measureThenDiscard(HREF, 450); // 沒給原尺寸 ⇒ aspect 仍是 null
      invalidateInlinePreviewHeights();
      expect(floorOf(mountSlot(HREF).el)).toBe("450px");
    });

    test("存活中的 slot 也要跟著作廢（不是只有 memo）", () => {
      const handle = mountSlot(HREF);
      near().emit(true);
      const img = fakeLoadedMedia(handle.el, 570, { w: 800, h: 600 });
      resized().emit();
      far().emit(false);
      img.remove();
      expect(floorOf(handle.el)).toBe("570px");

      handle.invalidatePinned();
      expect(floorOf(handle.el)).toBe("");
      expect(handle.el.querySelector(".inlinePreviewGhost")).not.toBeNull();
    });
  });
});
