// 純 JS 渲染鏈的**生命週期**守護。
//
// 為什麼需要：React 卸載一棵子樹時會自動跑每個元件的 cleanup（unobserve、abort、
// unmount）。改成手寫 DOM 之後這件事沒有人做——列被換掉／整份重建時，該列建立的
// 延遲載入佔位盒（IntersectionObserver + ResizeObserver + ImagePreviewer 的 React
// root）會全部留著。長文一篇 287 個連結、加上每次改設定的全量重建，很快就是幾千
// 個活著的 observer。這是去 React 化唯一新增的洩漏面，所以單獨拉一條測試盯著。

import { ScreenController } from "../../src/render/screen";
import { resetLazyObserversForTest } from "../../src/render/inline_preview_slot";
import { row, seg, link } from "./helpers/screen_fixtures";

// 假 IntersectionObserver / ResizeObserver：只需要記住「現在還有誰被觀察著」。
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
}

const observedCount = () =>
  observers.reduce((n, o) => n + o.targets.size, 0) +
  sizeObservers.reduce((n, o) => n + o.targets.size, 0);

const ENHANCE = {
  blacklist: new Set(),
  titleBlacklist: [],
  pageState: 3,
  easyReading: true,
  dropHidden: true,
  stableRows: true,
  articleId: "a1",
};

// 每一列一個圖片連結 → 每一列一個佔位盒。
const linkLines = (n, tag) => {
  const out = [];
  for (let i = 0; i < n; ++i) {
    out.push(row(seg(`${tag}`), link(`https://i.imgur.com/${tag}${i}.jpg`)));
  }
  return out;
};

function mount() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const controller = new ScreenController(root);
  return { root, controller };
}

const props = (lines, extra) => ({
  lines,
  forceWidth: 20,
  enableLinkInlinePreview: true,
  enableLinkHoverPreview: false,
  enhance: Object.assign({}, ENHANCE, extra),
});

describe("渲染鏈的佔位盒生命週期", () => {
  beforeEach(() => {
    observers.length = 0;
    sizeObservers.length = 0;
    resetLazyObserversForTest();
    global.IntersectionObserver = FakeIO;
    global.ResizeObserver = FakeRO;
  });

  afterEach(() => {
    delete global.IntersectionObserver;
    delete global.ResizeObserver;
    resetLazyObserversForTest();
  });

  test("整份重建（換文章）會收掉舊列的所有 observer", () => {
    const { root, controller } = mount();
    controller.update(props(linkLines(5, "a")));
    // 每個佔位盒被 near/far/size 三個 observer 觀察。
    expect(observedCount()).toBe(5 * 3);

    // articleId 換掉 ＝ 換文章，lines 也是全新的一批 → 舊列全部丟棄。
    controller.update(props(linkLines(3, "b"), { articleId: "a2" }));
    expect(observedCount()).toBe(3 * 3);

    controller.destroy();
    root.remove();
    expect(observedCount()).toBe(0);
  });

  test("純 append（好讀翻頁）不會重建既有列，也不會重複註冊 observer", () => {
    const { root, controller } = mount();
    const first = linkLines(3, "a");
    controller.update(props(first));
    const before = observedCount();
    expect(before).toBe(3 * 3);

    // append：前綴是**同一批列物件**，符合 isAppendOnly ⇒ 既有列直接沿用節點。
    const grown = first.concat(linkLines(2, "b"));
    controller.update(props(grown));
    expect(observedCount()).toBe(5 * 3);

    controller.destroy();
    root.remove();
    expect(observedCount()).toBe(0);
  });

  test("設定變動造成的全量重算也不會漏掉舊 observer", () => {
    const { root, controller } = mount();
    const lines = linkLines(4, "a");
    controller.update(props(lines));
    expect(observedCount()).toBe(4 * 3);

    // 改設定 → annotationsKey 變 → 快取整份失效 → 每一列重建。
    controller.update(props(lines, { showFloorNumbers: true }));
    expect(observedCount()).toBe(4 * 3);

    controller.destroy();
    root.remove();
    expect(observedCount()).toBe(0);
  });
});
