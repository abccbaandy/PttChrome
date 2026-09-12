// 單張圖的暫時性灰階切換鈕（src/render/inline_preview_slot.js）。
//
// 動線：把某張圖轉灰階 → 用瀏覽器內建的「以圖找圖」查。灰階只能是 CSS filter
// （本地產不出真正灰階的位元組，理由見該檔的 grayHrefs 註解），所以這裡守的是
// 「按鈕在不在、data-gray 翻不翻、--img-w 有沒有量到」——真幾何（按鈕右緣是否貼齊
// 圖片右緣、filter 的實際計算值）jsdom 不解 calc()/var() 也沒有排版，交給
// tests/e2e/offline/image_gray.offline.spec.js。
//
// 假 IntersectionObserver / ResizeObserver 與 offsetWidth stub 的手法照抄
// tests/unit/lazy_inline_preview.test.js。

import { setupI18n } from "../../src/js/i18n";
import {
  LAZY_MOUNT_MARGIN_PX,
  LAZY_UNMOUNT_MARGIN_PX,
} from "../../src/js/lazy_media";

const {
  createInlinePreviewSlot,
  clearInlinePreviewGray,
  resetLazyObserversForTest,
} = await import("../../src/render/inline_preview_slot");

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
}

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

const liveSlots = [];
function mountSlot(href, sizeMode) {
  const slot = createInlinePreviewSlot(href, sizeMode);
  document.body.appendChild(slot.el);
  liveSlots.push(slot);
  return slot;
}
function destroySlots() {
  while (liveSlots.length) {
    const s = liveSlots.pop();
    s.destroy();
    s.el.remove();
  }
}

const contentOf = (slotEl) => slotEl.querySelector(".inlinePreviewContent");
const btnOf = (slotEl) => slotEl.querySelector(".previewGrayBtn");
const grayAttr = (slotEl) => slotEl.getAttribute("data-gray");

function fake(node, prop, value) {
  Object.defineProperty(node, prop, { configurable: true, value });
}

// 「圖真的畫出來了」＝ content 裡有一張 offsetWidth/Height > 0 的 img.easyReadingImg。
// jsdom 不排版也不載圖，兩者都要自己造。
function addLoadedImage(slotEl, { width = 640, height = 480, top = 0 } = {}) {
  const img = document.createElement("img");
  img.className = "easyReadingImg hyperLinkPreview";
  fake(img, "offsetWidth", width);
  fake(img, "offsetHeight", height);
  // 圖片是 `margin: 0.5em auto`，上緣比內容層低一截；兩者 offsetParent 相同，
  // 產品端相減得到 --img-top。
  fake(img, "offsetTop", top);
  fake(contentOf(slotEl), "offsetHeight", height);
  fake(contentOf(slotEl), "offsetTop", 0);
  contentOf(slotEl).appendChild(img);
  return img;
}

const HREF = "https://i.imgur.com/grayaaa.jpg";

// 按鈕的 title 走 i18n（zh_TW / en_US 兩份，i18n_parity 會抓漏），沒載入語系表時
// i18n() 回 undefined ⇒ 兩態都是 undefined，斷言會退化成看不出原因的相等。
setupI18n();

describe("內嵌預覽圖的灰階切換鈕", () => {
  beforeEach(() => {
    observers.length = 0;
    sizeObservers.length = 0;
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

  test("圖還沒畫出來 ⇒ 不長按鈕", () => {
    const slot = mountSlot(HREF).el;
    expect(btnOf(slot)).toBeNull();
    resized().emit();
    expect(btnOf(slot)).toBeNull();
  });

  test("單張圖佈局完成 ⇒ 長出按鈕，並量下貼齊圖片右上角所需的兩個值", () => {
    const slot = mountSlot(HREF).el;
    addLoadedImage(slot, { width: 624, top: 9 });
    resized().emit();

    const btn = btnOf(slot);
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("type")).toBe("button");
    // 按鈕要貼的是**圖片**右上角，不是 slot 的（圖片 margin:0.5em auto，左右置中、
    // 上面也有一截）。這兩個變數分別是 CSS 那條百分比 margin-right 與 margin-top
    // 的唯一輸入。
    expect(btn.style.getPropertyValue("--img-w")).toBe("624px");
    expect(btn.style.getPropertyValue("--img-top")).toBe("9px");
    // 按鈕是 slot 的直屬子節點（grid item，與內容疊在同一格 ⇒ 不增加 slot 高度）。
    expect(btn.parentElement).toBe(slot);
  });

  // 上緣差不可以在 CSS 裡照抄圖片的 0.5em：em 在按鈕身上以按鈕自己的 font-size
  // 解析，圖片那個 0.5em 用的是終端機字級（隨設定變動）⇒ 按鈕會浮到圖片上緣之外。
  // 字級改變會走 onResize（既有路徑），量到的值要跟著換。
  test("字級改變 ⇒ 兩個量測值都跟著更新", () => {
    const handle = mountSlot(HREF);
    addLoadedImage(handle.el, { width: 400, top: 6 });
    resized().emit();
    expect(btnOf(handle.el).style.getPropertyValue("--img-top")).toBe("6px");

    const img = contentOf(handle.el).querySelector("img");
    fake(img, "offsetWidth", 800);
    fake(img, "offsetTop", 12);
    resized().emit();
    expect(btnOf(handle.el).style.getPropertyValue("--img-w")).toBe("800px");
    expect(btnOf(handle.el).style.getPropertyValue("--img-top")).toBe("12px");
  });

  // 「非媒體 slot（※ 文章網址那行）／影片／iframe／相簿」一律不配按鈕 —— 那顆按鈕
  // 指涉不明，而且連帶讓 jsdom 下的 golden 快照完全不受影響。
  test("沒有圖的 slot（讀取中指示器／非媒體連結）⇒ 不長按鈕", () => {
    const slot = mountSlot(
      "https://www.ptt.cc/bbs/ask/M.1786465191.A.DBD.html",
    ).el;
    const loading = document.createElement("div");
    loading.className = "previewLoading";
    fake(loading, "offsetWidth", 200);
    contentOf(slot).appendChild(loading);
    resized().emit();
    expect(btnOf(slot)).toBeNull();
  });

  test("相簿（多張圖）⇒ 不長按鈕（一顆鈕代表不了整盒）", () => {
    const slot = mountSlot(HREF).el;
    addLoadedImage(slot);
    addLoadedImage(slot);
    resized().emit();
    expect(btnOf(slot)).toBeNull();
  });

  test("點一下 ⇒ data-gray=1；再點一下 ⇒ 屬性移除", () => {
    const slot = mountSlot(HREF).el;
    addLoadedImage(slot);
    resized().emit();
    expect(grayAttr(slot)).toBeNull();

    btnOf(slot).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(grayAttr(slot)).toBe("1");

    btnOf(slot).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(grayAttr(slot)).toBeNull();
  });

  // 按鈕住在 #mainContainer 裡，而 ScreenController 在容器上掛了「點圖放大／縮小」
  // 的委派 listener。這一下不擋住就會順手把整頁圖片放大，看起來像亂跳。
  test("點按鈕不得冒泡到容器（否則會誤觸點圖放大）", () => {
    const slot = mountSlot(HREF).el;
    addLoadedImage(slot);
    resized().emit();

    let bubbled = 0;
    document.body.addEventListener("click", () => ++bubbled);
    const ev = new window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    btnOf(slot).dispatchEvent(ev);
    expect(bubbled).toBe(0);
    expect(ev.defaultPrevented).toBe(true);
  });

  test("按鈕文字說的是「點下去會發生什麼」（兩態不同）", () => {
    const slot = mountSlot(HREF).el;
    addLoadedImage(slot);
    resized().emit();
    const off = btnOf(slot).title;
    expect(off).toBeTruthy();

    btnOf(slot).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(btnOf(slot).title).toBeTruthy();
    expect(btnOf(slot).title).not.toBe(off);
  });

  // 狀態是 module 級、以 href 為鍵：**任何改動 annotationsKey 的操作都會整份重建
  // slot**（AI 校正逐筆回填一篇文章就數十次），存閉包裡的話灰階會自己跳回原彩。
  test("slot 被重建 ⇒ 同一個 href 仍是灰階", () => {
    const first = mountSlot(HREF);
    addLoadedImage(first.el);
    resized().emit();
    btnOf(first.el).dispatchEvent(
      new window.MouseEvent("click", { bubbles: true }),
    );
    expect(grayAttr(first.el)).toBe("1");

    first.destroy();
    first.el.remove();
    liveSlots.splice(liveSlots.indexOf(first), 1);

    // 第一幀就要是灰的：等 ResizeObserver 首次回報（下一個 frame）會讓灰圖
    // 閃一下原彩。
    const rebuilt = mountSlot(HREF);
    expect(grayAttr(rebuilt.el)).toBe("1");
    addLoadedImage(rebuilt.el);
    resized().emit();
    expect(grayAttr(rebuilt.el)).toBe("1");
  });

  test("不得跨連結感染（Set 以 href 為鍵）", () => {
    const a = mountSlot(HREF);
    addLoadedImage(a.el);
    resized().emit();
    btnOf(a.el).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    const b = mountSlot("https://i.imgur.com/graybbb.jpg");
    addLoadedImage(b.el);
    resized().emit();
    expect(grayAttr(a.el)).toBe("1");
    expect(grayAttr(b.el)).toBeNull();
  });

  // clearInlinePreviewGray 只清 Set；已經掛在畫面上的節點要靠 syncGray() 拉回來。
  // 這兩步合起來才是 ScreenController._resetImagesGray。
  test("清空狀態後呼叫 syncGray ⇒ 已掛著的節點也回到原彩", () => {
    const handle = mountSlot(HREF);
    addLoadedImage(handle.el);
    resized().emit();
    btnOf(handle.el).dispatchEvent(
      new window.MouseEvent("click", { bubbles: true }),
    );
    expect(grayAttr(handle.el)).toBe("1");

    clearInlinePreviewGray();
    expect(grayAttr(handle.el), "只清 Set 不會動到 DOM").toBe("1");
    handle.syncGray();
    expect(grayAttr(handle.el)).toBeNull();
  });

  // 純 JS 渲染鏈要自己收生命週期（入口 render/screen.js#disposeNode）。
  test("destroy() ⇒ 按鈕跟著消失", () => {
    const handle = mountSlot(HREF);
    addLoadedImage(handle.el);
    resized().emit();
    expect(btnOf(handle.el)).not.toBeNull();

    handle.destroy();
    expect(btnOf(handle.el)).toBeNull();
  });

  // 捲遠卸載時圖被 React 收走 ⇒ 按鈕沒有對象可指。但**灰階態不該跟著沒**：
  // 捲回來重新掛載時使用者仍應看到自己轉過的那張灰圖。
  test("捲遠卸載 ⇒ 按鈕收掉，但灰階態保留到重新掛載", () => {
    const handle = mountSlot(HREF);
    const img = addLoadedImage(handle.el);
    resized().emit();
    btnOf(handle.el).dispatchEvent(
      new window.MouseEvent("click", { bubbles: true }),
    );

    // near 相交 → mount（facts.mounted 立起來），再讓 far 回報不相交 ⇒ unmount。
    const near = observers.find((o) =>
      o.rootMargin.startsWith(String(LAZY_MOUNT_MARGIN_PX)),
    );
    const far = observers.find((o) =>
      o.rootMargin.startsWith(String(LAZY_UNMOUNT_MARGIN_PX)),
    );
    near.cb([{ target: handle.el, isIntersecting: true }]);
    far.cb([{ target: handle.el, isIntersecting: false }]);
    img.remove();

    expect(btnOf(handle.el)).toBeNull();
    expect(grayAttr(handle.el)).toBe("1");
  });

  // 硬不變量：slot / content 在 runtime 一律不得有 inline style（捲動錨點的祖先，
  // 見 inline_preview_slot.js 檔頭）。按鈕自己的 style 與 slot 的 data-gray 屬性
  // 都不是那兩個節點的樣式 —— 這條測試釘住這個界線。
  test("加了按鈕之後，slot 與 content 仍然零 inline style", () => {
    const slot = mountSlot(HREF).el;
    addLoadedImage(slot);
    resized().emit();
    btnOf(slot).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    expect(slot.getAttribute("style")).toBeNull();
    expect(contentOf(slot).getAttribute("style")).toBeNull();
  });
});
