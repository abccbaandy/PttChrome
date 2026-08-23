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

// ResizeObserver 這邊要能主動回報：佔位盒的高度就是靠它記起來的。
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

  test("dirty-row 只重建髒的那一列：沿用的列不得被 dispose，重建的列不得洩漏", () => {
    // 逐列 patch 是唯一一條「舊節點原封留在 nodes 裡」的路徑，最容易寫成兩種
    // 反向錯誤：把沿用的列也 dispose 掉（圖片預覽整批消失），或忘記收掉被換掉
    // 的那一列（observer / React root 越積越多）。
    // pageState 2 ＝ 逐列獨立，才走得到 dirty-row 路徑；inline 預覽在這裡是為了
    // 讓每一列都真的建出佔位盒。
    const { root, controller } = mount();
    const lines = linkLines(4, "a");
    const listEnhance = { pageState: 2, easyReading: false, dropHidden: false, stableRows: false };
    controller.update(props(lines, listEnhance));
    expect(observedCount()).toBe(4 * 3);
    const keptNode = controller.container.children[0];

    // 活 buffer 的就地改寫：列物件不換，內容整列換掉。
    const replacement = linkLines(1, "z")[0];
    lines[1].length = 0;
    for (const c of replacement) lines[1].push(c);

    controller.update(
      props(lines.slice(), Object.assign({ changedRows: [1] }, listEnhance)),
    );

    expect(observedCount()).toBe(4 * 3);
    expect(controller.container.children[0]).toBe(keptNode);

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

  // 症狀級（f9fef96b 的延伸）：推文者高亮已改走 class 層，但**任何會改動
  // annotationsKey 的操作**還是全量重建每一列 —— AI 校正逐筆回填一篇文章就數十次。
  // 重建出來的佔位盒若從零高度開始，整份長頁的圖片區同時塌陷再非同步撐回來
  // ＝閃爍＋閱讀位置往下跳。量測結果存在 module 級 memo（鍵＝href）才擋得住。
  test("設定變動造成的全量重建：新節點的佔位盒第一幀就有高度（不塌陷）", () => {
    const { root, controller } = mount();
    const lines = linkLines(1, "a");
    controller.update(props(lines));

    const slotEl = () => controller.container.querySelector(".inlinePreviewSlot");
    const before = slotEl();
    // 圖載出來、量到高度（真實情境是 near → mount → onLoad → ResizeObserver）。
    Object.defineProperty(before, "offsetHeight", {
      configurable: true,
      value: 420,
    });
    const img = document.createElement("img");
    img.className = "easyReadingImg hyperLinkPreview";
    Object.defineProperty(img, "offsetHeight", { configurable: true, value: 420 });
    before.appendChild(img);
    sizeObservers[0].emit();
    expect(before.style.minHeight).toBe("420px");

    controller.update(props(lines, { showFloorNumbers: true }));
    const after = slotEl();
    expect(after).not.toBe(before); // 節點真的被重建了
    expect(after.style.minHeight).toBe("420px"); // 修好前是 ""＝塌陷

    controller.destroy();
    root.remove();
  });
});
