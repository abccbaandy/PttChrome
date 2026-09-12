// 「換文章卻還有幾張莫名其妙的灰圖」的回歸守護（比照 screen_images_enlarged_reset）。
//
// 單張圖的灰階態放在 module 級的 Set（鍵＝href，見 src/render/inline_preview_slot.js
// 的 grayHrefs 註解）—— 非如此不可：任何改動 annotationsKey 的操作都會整份重建
// slot，狀態存閉包裡會在使用者眼前自己跳回原彩。代價是它**跨 slot、跨文章都活著**，
// 所以換文章必須明確清掉。
//
// 而且只清 Set 不夠：那一刻已經掛在畫面上的節點還帶著 data-gray。唯一入口是
// ScreenController._resetImagesGray（清 Set ＋ 對存活中的 slot 逐一 syncGray）。
//
// 斷言一律鎖症狀（DOM 上的 data-gray），不鎖任何私有欄位。
import { ScreenController } from "../../src/render/screen";
import { resetLazyObserversForTest } from "../../src/render/inline_preview_slot";
import { setupI18n } from "../../src/js/i18n";
import { row, seg, link } from "./helpers/screen_fixtures";

setupI18n();

// 假 observer：只需要能主動回報尺寸（灰階鈕是在 onResize 量到圖寬時才建立的）。
class FakeIO {
  constructor(cb, opts) {
    this.cb = cb;
    this.rootMargin = opts && opts.rootMargin;
    this.targets = new Set();
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

const emitResize = () => sizeObservers.forEach((o) => o.emit());

const ENHANCE = {
  blacklist: new Set(),
  titleBlacklist: [],
  pageState: 3,
  easyReading: true,
  dropHidden: true,
  stableRows: true,
};

const HREF = "https://i.imgur.com/grayreset.jpg";

const props = (articleId, extra) => ({
  lines: [row(seg("看圖"), link(HREF))],
  forceWidth: 20,
  enableLinkInlinePreview: true,
  enableLinkHoverPreview: false,
  enhance: Object.assign({ articleId }, ENHANCE, extra),
});

let root = null;
let controller = null;

function mount() {
  root = document.createElement("div");
  root.className = "main";
  document.body.appendChild(root);
  controller = new ScreenController(root);
}

const slotEl = () => controller.container.querySelector(".inlinePreviewSlot");
const grayAttr = () => slotEl().getAttribute("data-gray");

// jsdom 不排版也不載圖：灰階鈕只在「content 裡剛好一張已佈局的 img」時才建立，
// 所以兩件事都得自己造出來。
function loadImageAndToggle() {
  const content = slotEl().querySelector(".inlinePreviewContent");
  const img = document.createElement("img");
  img.className = "easyReadingImg hyperLinkPreview";
  Object.defineProperty(img, "offsetWidth", { configurable: true, value: 600 });
  Object.defineProperty(img, "offsetHeight", { configurable: true, value: 400 });
  content.appendChild(img);
  emitResize();
  const btn = slotEl().querySelector(".previewGrayBtn");
  expect(btn, "前提失效：量到圖寬之後應該長出灰階鈕").not.toBeNull();
  btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

describe("換文章重置單張圖的灰階", () => {
  beforeEach(() => {
    sizeObservers.length = 0;
    resetLazyObserversForTest();
    global.IntersectionObserver = FakeIO;
    global.ResizeObserver = FakeRO;
    mount();
  });

  afterEach(() => {
    controller.destroy();
    root.remove();
    delete global.IntersectionObserver;
    delete global.ResizeObserver;
    resetLazyObserversForTest();
  });

  test("點灰階鈕 ⇒ 該張圖的 slot 帶上 data-gray", () => {
    controller.update(props("a1"));
    expect(grayAttr()).toBeNull();
    loadImageAndToggle();
    expect(grayAttr()).toBe("1");
  });

  test("同篇 page-down（articleId 不變）保留灰階", () => {
    controller.update(props("a1"));
    loadImageAndToggle();

    controller.update(props("a1"));
    expect(grayAttr()).toBe("1");
  });

  test("換文章 ⇒ 一律回到原彩", () => {
    controller.update(props("a1"));
    loadImageAndToggle();
    expect(grayAttr()).toBe("1");

    controller.update(props("a2"));
    expect(grayAttr()).toBeNull();
  });

  // 換文章後再繞回同一篇（或另一篇剛好引用同一張圖）也不該是灰的：
  // 直接清 Set 而漏掉 syncGray 的版本在這裡會留下舊節點的 data-gray。
  test("換文章後回到原本那篇 ⇒ 仍是原彩（狀態真的被清掉，不是被蓋住）", () => {
    controller.update(props("a1"));
    loadImageAndToggle();
    controller.update(props("a2"));
    controller.update(props("a1"));
    expect(grayAttr()).toBeNull();
  });

  // 換文章的其他重置（imagesEnlarged／lightsOn）走的是各自的唯一入口，灰階也一樣 ——
  // 這條確認 _resetImagesGray 真的被接進那個區塊，而不是只清了 module 級的 Set。
  test("重置入口同時清狀態與已掛著的節點", () => {
    controller.update(props("a1"));
    loadImageAndToggle();
    controller._resetImagesGray();
    expect(grayAttr()).toBeNull();
  });
});
