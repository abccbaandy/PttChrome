// @unit-env browser
// 文章導覽軸的標記位置與滑塊同一把尺（src/js/article_nav.js、docs/article-tools.md「文章導覽軸」）。
//
// 症狀：「推」標在列號 / 總列數，滑塊卻是 scrollTop / scrollHeight（像素）。行內圖片讓一列
// 高好幾百 px ⇒ 多圖文章的「推」離真正的推文區起點差一大截。另外原生捲軸與導覽軸並排，
// 右緣有兩條捲軸。這裡用真 DOM 鎖：
//   1. 列的位置＝畫出來的節點在捲動內容裡的像素頂端；閉塊不量塊內（用塊的位置＋序位估）；
//   2. 沒有自己節點的列：在合併塊裡取塊頂、被黑名單拿掉取下一列；上一幀不是這份 lines ⇒ 不量；
//   3. 控制器把標記換成像素比例，並在顯示時於 .main 掛 ARTICLE_NAV_ON_CLASS（原生捲軸隱形）。
// 真瀏覽器的整條鏈（真分塊、真圖片、真捲軸）在 article_nav.offline／article_nav_scrollbar.offline。
import { ArticleNav, ARTICLE_NAV_ON_CLASS, nodeTopWithin, rowTopWithin } from "../../src/js/article_nav";
import { CHUNK_CLASS, CHUNK_NEAR_CLASS } from "../../src/render/screen_chunk";
import { ScreenController } from "../../src/render/screen";
import { row as fixtureRow, seg } from "./helpers/screen_fixtures";

const ROW_H = 20;
const live = [];
afterEach(() => {
  while (live.length) live.pop().remove();
});

// 捲動容器（.main 的角色）＋內容（#mainContainer 的角色）。版面是真的。
function scroller() {
  const disp = document.createElement("div");
  disp.style.cssText = "position:relative;height:300px;width:400px;overflow-y:auto";
  const mc = document.createElement("div");
  disp.appendChild(mc);
  document.body.appendChild(disp);
  live.push(disp);
  return { disp, mc };
}

function chunk(parent, near) {
  const k = document.createElement("div");
  k.className = CHUNK_CLASS + (near ? " " + CHUNK_NEAR_CLASS : "");
  parent.appendChild(k);
  return k;
}

// 一列：span[type=bbsrow]，tall＝掛著一張多高的圖（行內預覽佔位盒的角色）。
function rowNode(parent, tall) {
  const s = document.createElement("span");
  s.setAttribute("type", "bbsrow");
  s.style.cssText = `display:block;height:${ROW_H + (tall || 0)}px`;
  parent.appendChild(s);
  return s;
}

function block(parent, rows) {
  const d = document.createElement("div");
  d.className = "mergedCommentBlock";
  d.style.cssText = `display:block;height:${ROW_H * rows}px`;
  parent.appendChild(d);
  return d;
}

const fakeScreen = (lines, nodes) => ({
  rowNode: (r, l) => (l === lines ? nodes[r] || null : undefined),
});

describe("nodeTopWithin／rowTopWithin", () => {
  test("照常渲染的塊：像素頂端（圖片列不是一列高）", () => {
    const { disp, mc } = scroller();
    const k = chunk(mc, true);
    const nodes = [rowNode(k), rowNode(k, 1000), rowNode(k)];
    expect(nodeTopWithin(nodes[2], disp)).toBe(ROW_H + ROW_H + 1000);
    const lines = ["a", "b", "c"];
    expect(rowTopWithin(fakeScreen(lines, nodes), lines, 2, disp)).toBe(1040);
  });

  test("閉塊：不量塊內，塊頂＋塊高 × 序位比例", () => {
    const { disp, mc } = scroller();
    const head = chunk(mc, true);
    rowNode(head, 480); // 前一塊 500px
    const k = chunk(mc, false);
    k.style.height = "400px"; // 閉塊的高（估計或瀏覽器記住的實測）
    const kids = [rowNode(k), rowNode(k), rowNode(k), rowNode(k)];
    expect(nodeTopWithin(kids[0], disp)).toBe(500);
    expect(nodeTopWithin(kids[2], disp)).toBe(500 + 400 * (2 / 4));
  });

  test("沒有自己節點的列：在合併塊裡 ⇒ 塊頂；被黑名單拿掉 ⇒ 下一列", () => {
    const { disp, mc } = scroller();
    const k = chunk(mc, true);
    const r0 = rowNode(k);
    const merged = block(k, 3); // 第 1～3 列併成一塊
    const r4 = rowNode(k);
    const r6 = rowNode(k); // 第 5 列被黑名單拿掉
    const nodes = [r0, merged, null, null, r4, null, r6];
    const lines = nodes.map((_, i) => String(i));
    const screen = fakeScreen(lines, nodes);
    expect(rowTopWithin(screen, lines, 2, disp)).toBe(ROW_H);
    expect(rowTopWithin(screen, lines, 5, disp)).toBe(ROW_H * 5);
  });

  test("display:none 的列（手機收起來的列）⇒ 取下一列", () => {
    const { disp, mc } = scroller();
    const k = chunk(mc, true);
    const nodes = [rowNode(k), rowNode(k), rowNode(k)];
    nodes[1].style.display = "none";
    const lines = ["a", "b", "c"];
    expect(rowTopWithin(fakeScreen(lines, nodes), lines, 1, disp)).toBe(ROW_H);
  });

  test("上一幀畫的不是這份 lines ⇒ 不量（null）", () => {
    const { disp, mc } = scroller();
    const nodes = [rowNode(chunk(mc, true))];
    const painted = ["a"];
    const screen = fakeScreen(painted, nodes);
    expect(rowTopWithin(screen, painted, 0, disp)).toBe(0);
    expect(rowTopWithin(screen, ["a"], 0, disp)).toBeNull();
  });
});

describe("ScreenController.rowNode", () => {
  test("上一幀第 row 列的頂層節點；換了 lines ⇒ undefined", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    live.push(root);
    const controller = new ScreenController(root);
    try {
      const lines = [fixtureRow(seg("first")), fixtureRow(seg("second"))];
      controller.update({
        lines,
        forceWidth: 20,
        enableLinkInlinePreview: false,
        enableLinkHoverPreview: false,
        enhance: { blacklist: new Set(), titleBlacklist: [], pageState: 3, easyReading: true, dropHidden: true, stableRows: true, articleId: "a1" },
      });
      expect(controller.rowNode(1, lines).textContent).toContain("second");
      expect(controller.rowNode(1, lines.slice())).toBeUndefined();
    } finally {
      controller.destroy();
    }
  });
});

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

describe("ArticleNav 控制器（真 DOM）", () => {
  function setup() {
    const { disp, mc } = scroller();
    const k = chunk(mc, true);
    const lines = ["作者 someone 看板 Test", "https://i.imgur.com/abcdefg.jpg", "推 abc: 好 10/23 12:34"];
    const nodes = [rowNode(k), rowNode(k, 1000), rowNode(k)];
    const listeners = {};
    const core = {
      mobile: false,
      buf: {
        pageState: 3,
        cols: 80,
        pageLines: lines,
        getRowText: (r, s, e, acc) => String((acc || lines)[r]),
        addEventListener: (name, fn) => (listeners[name] = fn),
      },
      easyReading: { _enabled: true, _functionMode: false },
      view: { mainDisplay: disp, mainContainer: mc, componentScreen: fakeScreen(lines, nodes) },
    };
    return { nav: new ArticleNav(core), core, disp, settle: () => listeners.screenSettled() };
  }

  test("「推」換成像素比例（＝滑塊的尺），不是列號 / 總列數", async () => {
    const { nav, disp, settle } = setup();
    settle();
    expect(nav.state.marks.find((m) => m.kind === "comments").f).toBeCloseTo(2 / 3);
    await frame();
    await frame();
    const expected = (ROW_H * 2 + 1000) / disp.scrollHeight;
    expect(nav.state.marks.find((m) => m.kind === "comments").f).toBeCloseTo(expected, 4);
  });

  test("顯示中 .main 掛 ARTICLE_NAV_ON_CLASS（原生捲軸隱形）；不顯示就拿掉", () => {
    const { nav, core, disp, settle } = setup();
    settle();
    expect(nav.state.visible).toBe(true);
    expect(disp.classList.contains(ARTICLE_NAV_ON_CLASS)).toBe(true);
    core.buf.pageState = 2;
    settle();
    expect(nav.state.visible).toBe(false);
    expect(disp.classList.contains(ARTICLE_NAV_ON_CLASS)).toBe(false);
  });
});
