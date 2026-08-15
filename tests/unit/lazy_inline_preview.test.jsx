// 好讀自動開圖的延遲載入／遠離卸載（src/components/LazyInlinePreview.jsx ＋
// src/js/lazy_media.js）。
//
// 背景：好讀把整篇累積成一長頁並對每個連結掛 inline 預覽。實錄的 EZsoft 長文有
// 287 個圖片連結，舊行為是一累積到就全部解析＋下載＋解碼、到離開文章前永不釋放
// —— 已解碼的點陣圖是「記憶體吃滿」的最大宗。
//
// 這裡守護的重點是**連 requestPreview() 都不能先呼叫**：它一被呼叫就開始解析網址
// （imgur 無副檔名的還會發兩個 HEAD 探測），所以單純給 <img> 加 loading="lazy"
// 沒有用，延遲必須做在整個預覽元件的掛載上。

import { render, act } from "@testing-library/react";
import {
  nextLazyState,
  recordSlotAspect,
  recordSlotHeight,
  slotMinHeight,
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
  default: LazyInlinePreview,
  PreviewSizeModeContext,
  resetLazyObserversForTest,
} = await import("../../src/components/LazyInlinePreview");

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
    act(() => {
      this.cb(
        Array.from(this.targets).map((target) => ({ target, isIntersecting })),
        this,
      );
    });
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
    act(() => {
      this.cb(
        Array.from(this.targets).map((target) => ({ target })),
        this,
      );
    });
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
      expect(slotMinHeight(p, "normal")).toBe(570);
      expect(slotMinHeight(p, "enlarged")).toBe(908);
    });
    test("只有另一種模式量過 ⇒ 這個模式不套（沒有值可用，不得拿別的模式的頂替）", () => {
      const p = recordSlotHeight(null, "enlarged", 908, true);
      expect(slotMinHeight(p, "normal")).toBeUndefined();
    });
    test("從未量過／高度無效 ⇒ 不套", () => {
      expect(slotMinHeight(null, "normal")).toBeUndefined();
      expect(slotMinHeight({ normal: 0 }, "normal")).toBeUndefined();
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

describe("LazyInlinePreview（掛載/卸載）", () => {
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
    delete global.IntersectionObserver;
    delete global.ResizeObserver;
    resetLazyObserversForTest();
  });

  test("還沒進入視野 ⇒ 佔位盒是空的，且 requestPreview 一次都沒被呼叫", () => {
    const { container } = render(<LazyInlinePreview href={HREF} />);
    const slot = container.querySelector(".inlinePreviewSlot");
    expect(slot).not.toBeNull();
    expect(slot.children.length).toBe(0);
    expect(spies.requestPreview).toBe(0);
  });

  test("接近視野 ⇒ 掛上預覽（此時才解析網址）", () => {
    const { container } = render(<LazyInlinePreview href={HREF} />);
    near().emit(true);
    expect(spies.requestPreview).toBe(1);
    expect(
      container.querySelector(".inlinePreviewSlot").children.length,
    ).toBeGreaterThan(0);
  });

  // jsdom 沒有排版也沒有網路：offsetHeight 恆為 0，ImagePreviewer 也停在「讀取中」。
  // 釘高度的前提是「slot 內真的有媒體、卸載後會塌陷」，所以要複現該情境就得把兩件
  // 事都做出來：偽造高度 ＋ 放一個真媒體節點（React 只管自己 render 的 children，
  // 手動 append 的節點不會被卸載動作移除，正好模擬「圖已經載出來了」）。
  function fakeLoadedMedia(slot, height, natural) {
    Object.defineProperty(slot, "offsetHeight", {
      configurable: true,
      value: height,
    });
    const img = document.createElement("img");
    img.className = "easyReadingImg hyperLinkPreview";
    if (natural) {
      // jsdom 不解碼圖片 ⇒ naturalWidth/Height 恆為 0，要自己給。
      Object.defineProperty(img, "naturalWidth", { value: natural.w });
      Object.defineProperty(img, "naturalHeight", { value: natural.h });
    }
    // 「已經佔到版面」的判準（hasLoadedMedia）：載入完成前的 <img> 是 display:none，
    // 那時量到的是「讀取中…」指示器的高度，不能記。
    Object.defineProperty(img, "offsetHeight", {
      configurable: true,
      value: height,
    });
    slot.appendChild(img);
    return img;
  }

  // 改變 slot（與其內媒體）當下的高度，模擬點圖放大／縮小造成的尺寸變化。
  function resizeTo(slot, height) {
    Object.defineProperty(slot, "offsetHeight", {
      configurable: true,
      value: height,
    });
    const img = slot.querySelector("img");
    if (img)
      Object.defineProperty(img, "offsetHeight", {
        configurable: true,
        value: height,
      });
  }

  test("遠離視野 ⇒ 卸載，並把卸載前的高度釘進佔位盒（閱讀位置不位移）", () => {
    const { container } = render(<LazyInlinePreview href={HREF} />);
    near().emit(true);
    const slot = container.querySelector(".inlinePreviewSlot");
    const img = fakeLoadedMedia(slot, 420);
    far().emit(false);
    img.remove(); // 媒體隨卸載消失
    expect(slot.children.length).toBe(0);
    expect(slot.style.minHeight).toBe("420px");
  });

  test("捲回來 ⇒ 重新掛載，佔位高度保留", () => {
    const { container } = render(<LazyInlinePreview href={HREF} />);
    const slot = container.querySelector(".inlinePreviewSlot");
    near().emit(true);
    const img = fakeLoadedMedia(slot, 420);
    far().emit(false);
    img.remove();
    expect(slot.children.length).toBe(0);
    far().emit(true); // 回到卸載邊界之內
    near().emit(true);
    expect(slot.children.length).toBeGreaterThan(0);
    expect(slot.style.minHeight).toBe("420px");
  });

  // 症狀級回歸（使用者實測 ptt-debug-20260815-112407）。完整走一遍回報的動線：
  //   縮小態看過這張圖 → 點圖放大 → 往下捲到卸載 → 點縮小 → 再往上捲。
  // 兩個症狀都在最後一步現形，且互為代價，必須同時擋下：
  //   (1) 佔位盒沿用放大態的高度 ⇒ 圖片下方一塊約等於放大後高度的空白
  //   (2) 佔位盒歸零 ⇒ 往上捲時圖一張張掛回來撐開，把上方內容推走 ⇒ 跳頁
  // 正解：兩種模式各記一組實測高度，切回去就用那一組。
  test("放大→捲遠→縮小：佔位盒換用縮小態的高度（不留空白，也不塌陷）", () => {
    const view = (mode) => (
      <PreviewSizeModeContext.Provider value={mode}>
        <LazyInlinePreview href={HREF} />
      </PreviewSizeModeContext.Provider>
    );
    const { container, rerender } = render(view("normal"));
    const slot = container.querySelector(".inlinePreviewSlot");
    near().emit(true);
    // 縮小態把圖載出來 → 這個模式的高度被記下（關鍵：不必等到卸載）
    fakeLoadedMedia(slot, 570);
    resized().emit();

    // 點圖放大：同一張圖變成 908
    rerender(view("enlarged"));
    resizeTo(slot, 908);
    resized().emit();
    expect(slot.style.minHeight).toBe("908px");

    // 往下捲到卸載（放大態）
    const img = slot.querySelector("img");
    far().emit(false);
    img.remove();
    expect(slot.children.length).toBe(0);
    expect(slot.style.minHeight).toBe("908px");

    // 點縮小 ⇒ 換用縮小態量到的 570：不是 908（空白），也不是 0（塌陷→跳頁）
    rerender(view("normal"));
    expect(slot.style.minHeight).toBe("570px");

    // 切回放大 ⇒ 回到 908
    rerender(view("enlarged"));
    expect(slot.style.minHeight).toBe("908px");
  });

  // 使用者往下捲時，那幾張圖**只**在放大態載入過 ⇒ normal 高度沒機會被量到。
  // 這時不得拿放大態的值頂替（＝空白），也不能什麼都不放（＝塌陷跳頁）：要留下同比例
  // 的替身盒，讓 CSS 用真圖那組規則算出縮小態該有的高度。
  test("只在放大態量過 ⇒ 切到縮小態改由替身盒佔位（不套放大態高度）", () => {
    const view = (mode) => (
      <PreviewSizeModeContext.Provider value={mode}>
        <LazyInlinePreview href={HREF} />
      </PreviewSizeModeContext.Provider>
    );
    const { container, rerender } = render(view("enlarged"));
    const slot = container.querySelector(".inlinePreviewSlot");
    near().emit(true);
    const img = fakeLoadedMedia(slot, 908, { w: 800, h: 600 });
    resized().emit();
    expect(slot.style.minHeight).toBe("908px");

    far().emit(false); // 往下捲到卸載
    img.remove();
    rerender(view("normal")); // 點縮小
    expect(slot.style.minHeight).toBe("");

    const ghost = slot.querySelector(".inlinePreviewGhost");
    expect(ghost).not.toBeNull();
    // 關鍵：掛的是跟真圖同一個 class，高度才會由同一組 CSS 規則算出來。
    expect(ghost.classList.contains("easyReadingImg")).toBe(true);
    expect(ghost.style.aspectRatio).toBe("800 / 600");
    expect(ghost.style.getPropertyValue("--ghost-w")).toBe("800px");
  });

  test("替身盒只在卸載期間存在，掛回來就讓位給真圖", () => {
    const { container } = render(<LazyInlinePreview href={HREF} />);
    const slot = container.querySelector(".inlinePreviewSlot");
    near().emit(true);
    const img = fakeLoadedMedia(slot, 570, { w: 800, h: 600 });
    resized().emit();
    expect(slot.querySelector(".inlinePreviewGhost")).toBeNull();
    far().emit(false);
    img.remove();
    expect(slot.querySelector(".inlinePreviewGhost")).not.toBeNull();
    far().emit(true);
    near().emit(true);
    expect(slot.querySelector(".inlinePreviewGhost")).toBeNull();
  });

  // 載入完成前 <img> 已在 DOM 裡但 display:none，量到的是「讀取中…」指示器的高度。
  // 記進去就是假空白（同 ask-urlline-blank 那個 65px 實例）。
  test("媒體還沒載完（img 尚未佔到版面）⇒ 尺寸回報不得記高度", () => {
    const { container } = render(<LazyInlinePreview href={HREF} />);
    const slot = container.querySelector(".inlinePreviewSlot");
    near().emit(true);
    Object.defineProperty(slot, "offsetHeight", {
      configurable: true,
      value: 65, // 「讀取中…」指示器
    });
    const img = document.createElement("img");
    img.className = "easyReadingImg hyperLinkPreview";
    Object.defineProperty(img, "offsetHeight", {
      configurable: true,
      value: 0,
    });
    slot.appendChild(img);
    resized().emit();
    expect(slot.style.minHeight).toBe("");
  });

  // 症狀級回歸（使用者實測：每篇文章推文區前面多一塊空白）。
  // 「※ 文章網址」那行的 URL 是 PTT 文章 HTML 頁，不是媒體：捲過去只會顯示
  // 「讀取中…」指示器，判定後內容消失。卸載時**不得**把那個指示器的高度釘住，
  // 否則變成永久假空白，而且非媒體連結永遠不會再長出內容來填它。
  test("非媒體連結（slot 內只有讀取中指示器）卸載 ⇒ 不留 min-height", () => {
    const { container } = render(
      <LazyInlinePreview href="https://www.ptt.cc/bbs/ask/M.1786465191.A.DBD.html" />,
    );
    near().emit(true);
    const slot = container.querySelector(".inlinePreviewSlot");
    // 「讀取中…」指示器撐出的高度（實測 65px），slot 內沒有任何媒體元素。
    Object.defineProperty(slot, "offsetHeight", {
      configurable: true,
      value: 65,
    });
    expect(slot.querySelector("img, video, iframe")).toBeNull();
    far().emit(false);
    expect(slot.style.minHeight).toBe("");
  });

  test("遲滯：只是離開視野（還在卸載邊界內）不卸載", () => {
    const { container } = render(<LazyInlinePreview href={HREF} />);
    const slot = container.querySelector(".inlinePreviewSlot");
    near().emit(true);
    near().emit(false); // 捲出視野，但 far 仍相交
    expect(slot.children.length).toBeGreaterThan(0);
  });

  test("環境沒有 IntersectionObserver ⇒ 立即掛載（行為與沒這功能時相同）", () => {
    delete global.IntersectionObserver;
    resetLazyObserversForTest();
    const { container } = render(<LazyInlinePreview href={HREF} />);
    expect(spies.requestPreview).toBe(1);
    expect(
      container.querySelector(".inlinePreviewSlot").children.length,
    ).toBeGreaterThan(0);
  });
});
