// @unit-env browser
// real-input: tests/e2e/offline/mobile_article_find.offline.spec.js
// 手機文章內找字（js/article_find.js，P75）。
//
// 鎖的症狀：
//   1. 找的是畫面上看得到的字：不分大小寫、&nbsp; 當一般空白、全形字照字算；跨列不算；
//      一列裡被 span 切成好幾段（推文上色）也找得到，標亮的 Range 剛好蓋住那幾個字。
//   2. 藏起來的列（黑名單推文）不算。
//   3. 好讀邊捲邊載、列被換掉 ⇒ 重找後目前這個留在同一列。
//   4. 只在手機好讀累積頁（或唯讀頁）、開關開著才有入口；換了一篇／離開文章就收起、標亮全清。
//   5. 一個 byte 都不送（controller 根本沒有送鍵的路徑；這裡用假 core 驗沒碰 conn）。
import {
  findInText,
  scanMatches,
  carryIndex,
  ArticleFind,
  FIND_HIGHLIGHT,
  FIND_CURRENT_HIGHLIGHT,
} from "../../src/js/article_find";

const PREF_KEY = "pttchrome.pref.v1";

function mountRows(rows) {
  const c = document.createElement("div");
  c.id = "findTestContainer";
  rows.forEach((html, i) => {
    const row = document.createElement("span");
    row.setAttribute("data-type", "bbsline");
    row.setAttribute("data-row", String(i));
    row.style.display = "block";
    row.innerHTML = html;
    c.appendChild(row);
  });
  document.body.appendChild(c);
  return c;
}

afterEach(() => {
  document.querySelectorAll("#findTestContainer").forEach((n) => n.remove());
  localStorage.removeItem(PREF_KEY);
  if (typeof CSS !== "undefined" && CSS.highlights) CSS.highlights.clear();
});

describe("findInText", () => {
  test("不分大小寫、不重疊、照順序；空字串 ⇒ []", () => {
    expect(findInText("TSMC tsmc Tsmc", "tsmc")).toEqual([0, 5, 10]);
    expect(findInText("aaaa", "aa")).toEqual([0, 2]);
    expect(findInText("abc", "")).toEqual([]);
    expect(findInText("abc", "  ")).toEqual([]);
  });
  test("&nbsp; 當一般空白；全形字照字算", () => {
    expect(findInText("推 台積電 漲停", "台積電 漲")).toEqual([2]);
    expect(findInText("２３３０　台積電", "台積電")).toEqual([5]);
  });
});

describe("scanMatches", () => {
  test("被 span 切開的字也找得到，Range 剛好蓋住；跨列不算", () => {
    const c = mountRows([
      '<span class="q1">推 abc</span><span>:台</span><span>積電 好</span>',
      "台積",
      "電",
    ]);
    const m = scanMatches(c, "台積電");
    expect(m.length).toBe(1);
    expect(m[0].range.toString()).toBe("台積電");
    expect(m[0].rowEl.getAttribute("data-row")).toBe("0");
  });

  test("藏起來的列不算", () => {
    const c = mountRows(["foo", '<span hidden>foo</span>', "foo"]);
    c.children[1].setAttribute("hidden", "");
    expect(scanMatches(c, "foo").map((x) => x.rowEl.getAttribute("data-row"))).toEqual(["0", "2"]);
  });
});

describe("carryIndex", () => {
  test("同一列的第 k 個；那一列沒了 ⇒ 0", () => {
    const c = mountRows(["x", "x x x", "x"]);
    const m = scanMatches(c, "x");
    expect(carryIndex(m, { rowEl: null, row: "1", nth: 2 })).toBe(3);
    expect(carryIndex(m, { rowEl: null, row: "1", nth: 9 })).toBe(3);
    expect(carryIndex(m, { rowEl: null, row: "7", nth: 0 })).toBe(0);
    expect(carryIndex([], null)).toBe(-1);
  });
});

describe("控制器", () => {
  function setup(rows, opts = {}) {
    const container = mountRows(rows);
    const listeners = [];
    const pageLines = [1];
    const conn = { send: vi.fn() };
    const view = {
      mainDisplay: container,
      _renderedLines: pageLines,
      _articleInstanceId: 1,
      buf: { pageLines },
      conn,
    };
    view.buf.addEventListener = (type, fn) => listeners.push(fn);
    const core = {
      mobile: opts.mobile !== false,
      view,
      buf: view.buf,
    };
    core.settle = () => listeners.forEach((fn) => fn());
    const ctl = new ArticleFind(core);
    return { core, ctl, container, view, conn };
  }

  test("不是手機、開關關掉、不在好讀累積頁 ⇒ 沒有入口", () => {
    expect(setup(["a"], { mobile: false }).ctl.available()).toBe(false);
    const s = setup(["a"]);
    expect(s.ctl.available()).toBe(true);
    s.view._renderedLines = [2];
    expect(s.ctl.available()).toBe(false);
    localStorage.setItem(PREF_KEY, JSON.stringify({ values: { mobileFindInArticle: false } }));
    s.view._renderedLines = s.view.buf.pageLines;
    expect(s.ctl.available()).toBe(false);
  });

  test("打字 ⇒ 計數、跳到第一個；下一個／上一個循環；標亮兩層；不送鍵", () => {
    const { ctl, conn } = setup(["aa b", "b", "a"]);
    const scrolls = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function () {
      scrolls.push(this.getAttribute("data-row"));
    };
    try {
      ctl.open();
      ctl.setQuery("A");
      expect(ctl.state).toMatchObject({ open: true, total: 3, index: 0 });
      expect(scrolls).toEqual(["0"]);
      ctl.next();
      ctl.next();
      expect(ctl.state.index).toBe(2);
      expect(scrolls[scrolls.length - 1]).toBe("2");
      ctl.next();
      expect(ctl.state.index).toBe(0);
      ctl.prev();
      expect(ctl.state.index).toBe(2);
      if (typeof CSS !== "undefined" && CSS.highlights) {
        expect(CSS.highlights.get(FIND_HIGHLIGHT).size).toBe(2);
        expect(CSS.highlights.get(FIND_CURRENT_HIGHLIGHT).size).toBe(1);
      }
      ctl.setQuery("zzz");
      expect(ctl.state).toMatchObject({ total: 0, index: -1 });
      expect(conn.send).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  test("換了一篇 ⇒ 收起、標亮全清", () => {
    const { ctl, core, view } = setup(["foo"]);
    ctl.open();
    ctl.setQuery("foo");
    view._articleInstanceId = 2;
    core.settle();
    expect(ctl.state.open).toBe(false);
    if (typeof CSS !== "undefined" && CSS.highlights) {
      expect(CSS.highlights.has(FIND_HIGHLIGHT)).toBe(false);
      expect(CSS.highlights.has(FIND_CURRENT_HIGHLIGHT)).toBe(false);
    }
  });

  test("離開好讀累積頁 ⇒ 收起", () => {
    const { ctl, core, view } = setup(["foo"]);
    ctl.open();
    view._renderedLines = [9];
    core.settle();
    expect(ctl.state.open).toBe(false);
  });

  test("列被換掉（好讀邊捲邊載）⇒ 重找，目前這個留在同一列", async () => {
    const { ctl, container } = setup(["x", "x", "x"]);
    ctl.open();
    ctl.setQuery("x");
    ctl.next();
    expect(ctl.state.index).toBe(1);
    // 第 1 列整列換掉（同 data-row），前面再插一列新的。
    const fresh = container.children[1].cloneNode(true);
    container.replaceChild(fresh, container.children[1]);
    const extra = document.createElement("span");
    extra.setAttribute("data-type", "bbsline");
    extra.setAttribute("data-row", "9");
    extra.textContent = "x";
    container.insertBefore(extra, container.firstChild);
    await vi.waitFor(() => expect(ctl.state.total).toBe(4));
    expect(ctl.state.index).toBe(2);
  });
});
