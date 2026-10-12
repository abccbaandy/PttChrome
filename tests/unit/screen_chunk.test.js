// @unit-env browser
// 好讀累積長頁的分塊（src/render/screen_chunk.js ＋ main.css `.screenChunk`）。
//
// 為什麼分塊：超長文的成本大頭是瀏覽器原生的 layout／paint，與 DOM 規模成正比；
// `content-visibility: auto` 讓離視窗遠的塊不排版不繪製（docs/easy-reading.md「長頁分塊」）。
// 這裡鎖的是分塊**自己**的契約（列內容的等價由 screen_incremental_render／
// screen_reverse_splice 守）：
//   1. CSS：估計高度與 CHUNK_ROWS 同值、閉塊選取時能展開、不宣告 user-select。
//   2. 每頁 append 只碰尾塊（＋新塊），既有的塊與列一個都不搬；成本與文章長度無關。
//   3. 全量重建按順序沿用舊塊元素（瀏覽器記住的實測高度留著，視窗上方不跳）。
//   4. 延遲開圖：塊進預載邊界就照常渲染（slot 自己的 observer 才可信、逐張掛）；塊離開
//      卸載邊界就強制卸載（閉塊內 slot 自己的 IntersectionObserver 幾乎不回報）。
//   5. 選取範圍跨到的塊暫時展開（Firefox 跨閉塊 Selection.toString() 漏字）。
//   6. rowsFromScrollTop 以塊跳過視窗上方，結果與逐列量相同。
import mainCss from "../../src/css/main.css?raw";
import { row, seg, link } from "./helpers/screen_fixtures";
import { ScreenController } from "../../src/render/screen";
import {
  CHUNK_ROWS,
  CHUNK_CLASS,
  CHUNK_OPEN_CLASS,
  CHUNK_NEAR_CLASS,
  rowsFromScrollTop,
} from "../../src/render/screen_chunk";
import { resetLazyObserversForTest } from "../../src/render/inline_preview_slot";
import { offsetTopWithin } from "../../src/js/scroll_anchor";

// vi.mock 會被提升到所有 import 之前 ⇒ 上面的 screen.js 拿到的就是計數版。
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

const STRIPPED = mainCss.replace(/\/\*[\s\S]*?\*\//g, "");
const ruleBody = (selector) => {
  for (const m of STRIPPED.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
    if (m[1].split(",").some((s) => s.trim() === selector)) return m[2];
  }
  return null;
};

const ENHANCE = {
  blacklist: new Set(),
  titleBlacklist: [],
  pageState: 3,
  easyReading: true,
  dropHidden: true,
  stableRows: true,
  articleId: "a1",
};
const textLines = (n, tag = "line") => {
  const out = [];
  for (let i = 0; i < n; ++i) out.push(row(seg(`${tag} ${i}`)));
  return out;
};
const props = (lines, extra, preview = false) => ({
  lines,
  forceWidth: 20,
  enableLinkInlinePreview: preview,
  enableLinkHoverPreview: false,
  enhance: Object.assign({}, ENHANCE, extra),
});

const live = [];
function mount(withCss) {
  const root = document.createElement("div");
  root.className = "main";
  let style = null;
  if (withCss) {
    style = document.createElement("style");
    style.textContent = mainCss;
    document.head.appendChild(style);
    // 真捲動容器：有高度、可捲（版面是真的，不偽造 scrollTop）。
    root.style.cssText = "height:400px;overflow-y:auto;width:800px;line-height:20px;font-size:20px";
  }
  document.body.appendChild(root);
  const controller = new ScreenController(root);
  const entry = { root, controller, style };
  live.push(entry);
  return entry;
}
afterEach(() => {
  while (live.length) {
    const e = live.pop();
    e.controller.destroy();
    e.root.remove();
    if (e.style) e.style.remove();
  }
});

const chunksOf = (c) => Array.from(c.children).filter((k) => k.classList.contains(CHUNK_CLASS));
const topNodes = (c) => chunksOf(c).flatMap((k) => Array.from(k.children));

describe("CSS 契約", () => {
  test("估計高度＝CHUNK_ROWS 列（lh 跟著字級），且有 auto（瀏覽器記住實測高度）", () => {
    const body = ruleBody(".screenChunk");
    expect(body).not.toBeNull();
    expect(body).toMatch(/content-visibility\s*:\s*auto/);
    expect(body).toMatch(new RegExp(`contain-intrinsic-height\\s*:\\s*auto\\s+${CHUNK_ROWS}lh`));
  });

  test("選取展開（Open）與預載邊界內（Near）的塊改成 visible", () => {
    expect(ruleBody(".screenChunk.screenChunkOpen")).toMatch(/content-visibility\s*:\s*visible/);
    expect(ruleBody(".screenChunk.screenChunkNear")).toMatch(/content-visibility\s*:\s*visible/);
  });

  test("列的 display:block 等基本樣式同樣套到塊裡的列", () => {
    expect(ruleBody("#mainContainer > .screenChunk > span")).toMatch(/display\s*:\s*block/);
  });
});

describe("分塊結構", () => {
  test("只有累積長頁（stableRows）分塊；原生／列表不分塊，來回切換乾淨", () => {
    const { controller } = mount();
    controller.update(props(textLines(250)));
    const c = controller.container;
    expect(chunksOf(c).length).toBe(3);
    expect(chunksOf(c).map((k) => k.children.length)).toEqual([CHUNK_ROWS, CHUNK_ROWS, 50]);
    expect(Array.from(c.children).every((k) => k.classList.contains(CHUNK_CLASS))).toBe(true);

    controller.update(props(textLines(24, "native"), { pageState: 2, easyReading: false, dropHidden: false, stableRows: false }));
    expect(chunksOf(c).length).toBe(0);
    expect(c.querySelectorAll('[type="bbsrow"]').length).toBe(24);

    controller.update(props(textLines(30, "again")));
    expect(chunksOf(c).length).toBe(1);
    expect(c.querySelectorAll('[type="bbsrow"]').length).toBe(30);
    expect(c.textContent).not.toContain("native");
  });

  test("逐頁 append：只碰尾塊與新塊，既有節點與塊一個都不搬（每頁成本與文章長度無關）", async () => {
    const PAGE = 22;
    const full = textLines(PAGE * 40);
    const { controller } = mount();
    controller.update(props(full.slice(0, PAGE * 30)));
    const c = controller.container;
    const before = new Set(topNodes(c));
    const chunksBefore = chunksOf(c);
    const added = [];
    const removed = [];
    const touchedParents = new Set();
    const mo = new MutationObserver((list) => {
      for (const m of list) {
        touchedParents.add(m.target);
        m.addedNodes.forEach((n) => added.push(n));
        m.removedNodes.forEach((n) => removed.push(n));
      }
    });
    mo.observe(c, { childList: true, subtree: true });
    controller.update(props(full.slice(0, PAGE * 31)));
    await Promise.resolve();
    mo.disconnect();
    expect(removed.length).toBe(0);
    expect(added.filter((n) => before.has(n)).length).toBe(0);
    // 新增的頂層節點 ≤ 一頁＋一個新塊
    expect(added.length).toBeLessThanOrEqual(PAGE + 1);
    expect(added.length).toBeGreaterThanOrEqual(PAGE);
    // 被寫入的父節點：尾塊、（可能的）新塊、容器本身（插新塊）——與文章長度無關。
    expect(touchedParents.size).toBeLessThanOrEqual(3);
    // 舊塊的身分不變
    chunksBefore.forEach((k) => expect(k.isConnected).toBe(true));
  });

  test("全量重建（改設定）按順序沿用舊塊元素", () => {
    const { controller } = mount();
    const lines = textLines(230);
    controller.update(props(lines));
    const c = controller.container;
    const chunksBefore = chunksOf(c);
    const nodesBefore = new Set(topNodes(c));
    // showFloorNumbers 進 annotationsKey ⇒ 全量重建
    controller.update(props(lines, { showFloorNumbers: true }));
    expect(chunksOf(c)).toEqual(chunksBefore);
    // 正向對照：列節點真的全換了（否則上一條在「什麼都沒發生」時也是綠的）
    expect(topNodes(c).some((n) => nodesBefore.has(n))).toBe(false);
    expect(chunksOf(c).map((k) => k.children.length)).toEqual([CHUNK_ROWS, CHUNK_ROWS, 30]);
  });

  test("全量重建後列變少：多出來的舊塊收掉", () => {
    const { controller } = mount();
    controller.update(props(textLines(230)));
    const first = chunksOf(controller.container)[0];
    controller.update(props(textLines(40, "b"), { articleId: "a2" }));
    expect(chunksOf(controller.container)).toEqual([first]);
  });

  test("反向讀取：接合點那一列開新塊，往上插入的每一頁落在兩塊之間", () => {
    const PAGE = 22;
    const full = textLines(PAGE * 10);
    const J = PAGE * 2 + 3;
    const { controller } = mount();
    const c = controller.container;
    controller.update(props(full.slice(0, J), { reverseJunction: J }));
    controller.update(props(full.slice(0, J).concat(full.slice(PAGE * 8)), { reverseJunction: J }));
    const headChunks = chunksOf(c).length - 1;
    for (let t = PAGE * 7; t >= PAGE * 4; t -= PAGE) {
      const kept = topNodes(c);
      controller.update(props(full.slice(0, J).concat(full.slice(t)), { reverseJunction: J }));
      controller.syncRowIndex();
      // 沿用的節點都還在（只有上一個接合點列換手：它帶的 .reverseJunction 標記移到新的 J）
      expect(kept.filter((n) => !n.isConnected).length).toBeLessThanOrEqual(1);
      // 接合點那一列是某塊的第一個節點
      const jRow = c.querySelector(`[type="bbsrow"][srow="${J}"]`);
      expect(jRow.parentElement.firstElementChild).toBe(jRow);
      // head 的塊沒有被插進任何東西
      expect(chunksOf(c).slice(0, headChunks).reduce((n, k) => n + k.children.length, 0)).toBe(J);
      // 往上插的頁併進 tail 的塊（不是每頁一個小塊：每塊的估計高度是 CHUNK_ROWS 列，
      // 小塊一多，視窗上方的總高就被灌成好幾倍）
      const tailRows = chunksOf(c).slice(headChunks).reduce((n, k) => n + k.children.length, 0);
      expect(chunksOf(c).length - headChunks).toBeLessThanOrEqual(Math.ceil(tailRows / CHUNK_ROWS) + 1);
    }
  });
});

describe("延遲開圖與分塊", () => {
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
    emitTo(targets, isIntersecting) {
      this.cb(
        targets.filter((t) => this.targets.has(t)).map((target) => ({ target, isIntersecting })),
        this,
      );
    }
  }
  const isChunk = (t) => t.classList && t.classList.contains(CHUNK_CLASS);
  const chunkIO = (kind) =>
    observers.find(
      (o) =>
        Array.from(o.targets).some(isChunk) &&
        o.rootMargin.startsWith(kind === "near" ? "1500" : "6000"),
    );
  const slotIO = (kind) =>
    observers.find(
      (o) =>
        Array.from(o.targets).some((t) => t.classList && t.classList.contains("inlinePreviewSlot")) &&
        o.rootMargin.startsWith(kind === "near" ? "1500" : "6000"),
    );
  const mountedCount = (chunk) =>
    Array.from(chunk.querySelectorAll(".inlinePreviewContent")).filter((n) => n.childNodes.length > 0).length;

  const linkLines = (n) => {
    const out = [];
    for (let i = 0; i < n; ++i) out.push(row(seg("img "), link(`https://i.imgur.com/c${i}.jpg`)));
    return out;
  };

  beforeEach(() => {
    observers.length = 0;
    spies.requestPreview = 0;
    resetLazyObserversForTest();
    globalThis.IntersectionObserver = FakeIO;
  });
  afterEach(() => {
    delete globalThis.IntersectionObserver;
    resetLazyObserversForTest();
  });

  const slotsOf = (chunk) => Array.from(chunk.querySelectorAll(".inlinePreviewSlot"));

  test("塊進入預載邊界 ⇒ 掛 screenChunkNear 照常渲染；離開就拿掉", () => {
    const { controller } = mount();
    controller.update(props(linkLines(CHUNK_ROWS + 10), null, true));
    const [a, b] = chunksOf(controller.container);
    chunkIO("near").emitTo([a], true);
    expect(a.classList.contains(CHUNK_NEAR_CLASS)).toBe(true);
    expect(b.classList.contains(CHUNK_NEAR_CLASS)).toBe(false);
    chunkIO("near").emitTo([a], false);
    expect(a.classList.contains(CHUNK_NEAR_CLASS)).toBe(false);
  });

  test("掛載仍是逐張精準：塊近了不會整塊一起掛（短文整篇只有一塊）", () => {
    const { controller } = mount();
    controller.update(props(linkLines(20), null, true));
    const [a] = chunksOf(controller.container);
    chunkIO("near").emitTo([a], true);
    expect(spies.requestPreview).toBe(0);
    const slots = slotsOf(a);
    slotIO("near").emitTo(slots.slice(0, 3), true);
    expect(mountedCount(a)).toBe(3);
    expect(spies.requestPreview).toBe(3);
  });

  test("塊離開卸載邊界 ⇒ 塊內已掛的全部卸載，即使 slot 自己的 observer 沒回報（閉塊內不回報）", () => {
    const { controller } = mount();
    controller.update(props(linkLines(5), null, true));
    const [a] = chunksOf(controller.container);
    slotIO("near").emitTo(slotsOf(a), true);
    slotIO("far").emitTo(slotsOf(a), true); // 在卸載邊界內
    expect(mountedCount(a)).toBe(5);
    chunkIO("far").emitTo([a], false);
    expect(mountedCount(a)).toBe(0);
    // 塊還在遠方時，slot 自己殘留的 near 不得把它掛回來
    slotIO("near").emitTo(slotsOf(a), true);
    expect(mountedCount(a)).toBe(0);
    // 塊回到卸載邊界內 ⇒ 照 slot 自己的 near 掛回
    chunkIO("far").emitTo([a], true);
    expect(mountedCount(a)).toBe(5);
  });

  test("新的一頁 append 進已離開卸載邊界的塊 ⇒ 新 slot 立即沿用塊的遠近", () => {
    const { controller } = mount();
    const lines = linkLines(30);
    controller.update(props(lines.slice(0, 8), null, true));
    const [a] = chunksOf(controller.container);
    chunkIO("far").emitTo([a], false);
    controller.update(props(lines, null, true));
    expect(chunksOf(controller.container)).toEqual([a]);
    slotIO("near").emitTo(slotsOf(a), true);
    expect(mountedCount(a)).toBe(0);
  });
});

describe("選取期間展開相交的塊", () => {
  const nextSelectionChange = () =>
    new Promise((resolve) =>
      document.addEventListener("selectionchange", () => setTimeout(resolve, 0), { once: true }),
    );

  test("選取跨到的塊掛上 screenChunkOpen；取消選取就拿掉", async () => {
    const { controller } = mount();
    controller.update(props(textLines(350)));
    const ks = chunksOf(controller.container);
    expect(ks.length).toBe(4);
    const sel = document.getSelection();
    const range = document.createRange();
    range.setStart(ks[1].firstElementChild, 0);
    range.setEnd(ks[2].lastElementChild, 0);
    let changed = nextSelectionChange();
    sel.removeAllRanges();
    sel.addRange(range);
    await changed;
    expect(ks.map((k) => k.classList.contains(CHUNK_OPEN_CLASS))).toEqual([false, true, true, false]);
    changed = nextSelectionChange();
    sel.removeAllRanges();
    await changed;
    expect(ks.some((k) => k.classList.contains(CHUNK_OPEN_CLASS))).toBe(false);
    // classList.remove 不得殘留成別的 class 值（golden／outerHTML 比對）
    ks.forEach((k) => expect(k.getAttribute("class")).toBe(CHUNK_CLASS));
  });
});

describe("rowsFromScrollTop", () => {
  test("跳過視窗上方的整塊，第一個看得到的列與逐列量的結果相同", () => {
    const { root, controller } = mount(true);
    controller.update(props(textLines(450)));
    const c = controller.container;
    expect(chunksOf(c).length).toBe(5);
    const firstVisible = (rows, st) => {
      for (const r of rows) if (offsetTopWithin(r, root) + r.offsetHeight > st) return r;
      return null;
    };
    for (const target of [0, 37, 120, 260, 449]) {
      const el = c.querySelector(`[type="bbsrow"][srow="${target}"]`);
      root.scrollTop = offsetTopWithin(el, root);
      const st = root.scrollTop;
      const fast = firstVisible(rowsFromScrollTop(c, root, st), st);
      const slow = firstVisible(c.querySelectorAll('[type="bbsrow"][srow]'), st);
      expect(fast).toBe(slow);
      expect(fast).not.toBeNull();
    }
  });

  test("沒有分塊（原生畫面）⇒ 回傳全部列", () => {
    const { root, controller } = mount(true);
    controller.update(props(textLines(24), { pageState: 2, easyReading: false, dropHidden: false, stableRows: false }));
    expect(rowsFromScrollTop(controller.container, root, 0).length).toBe(24);
  });
});
