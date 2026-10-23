// 文章導覽軸（src/js/article_nav.js、docs/article-tools.md「文章導覽軸」）：
//   - 標記：第一則推文、新推文、提到我、圖片，位置＝列號 / 累積頁總列數；
//   - 位置：終端機右緣，下緣讓開好讀 footer 與推文列；
//   - 出現條件同推文列（只在好讀文章），pref 關就不出現；跳列只捲視口、不送鍵。
const prefOverride = vi.hoisted(() => ({}));
vi.mock("../../src/js/pref_storage", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, readEffectivePrefs: () => ({ ...real.readEffectivePrefs(), ...prefOverride }) };
});
import { DEFAULT_PREFS, NATIVE_SAFE_MODE_KEYS } from "../../src/js/pref_storage";
import { ArticleNav, navMarks, articleNavGeometry, ARTICLE_NAV_WIDTH } from "../../src/js/article_nav";
import { COMMENT_BAR_HEIGHT } from "../../src/js/comment_bar";

describe("navMarks", () => {
  test("第一則推文、新推文、提到我、圖片；位置＝列號 / 總列數", () => {
    const analysis = {
      comments: [{ row: 50 }, { row: 51 }],
      mentions: [{ row: 70 }],
      images: [{ row: 10 }],
    };
    expect(navMarks(analysis, 100, 60)).toEqual({
      commentRow: 50,
      marks: [
        { kind: "comments", row: 50, f: 0.5 },
        { kind: "new", row: 60, f: 0.6 },
        { kind: "mention", row: 70, f: 0.7 },
        { kind: "image", row: 10, f: 0.1 },
      ],
    });
  });
  test("沒有推文／新推文 ⇒ 沒有那兩種標記", () => {
    expect(navMarks({ comments: [], mentions: [], images: [] }, 10, null)).toEqual({ commentRow: null, marks: [] });
  });
});

describe("articleNavGeometry", () => {
  const mainRect = { left: 40, right: 1240, top: 40, bottom: 760, width: 1200 };
  test("終端機右緣、從 .main 頂到好讀 footer 上緣", () => {
    expect(articleNavGeometry({ mainRect, footerTop: 730 })).toEqual({
      left: 1240 - ARTICLE_NAV_WIDTH,
      top: 40,
      height: 690,
    });
  });
  test("推文列顯示中 ⇒ 下緣再讓開推文列", () => {
    expect(articleNavGeometry({ mainRect, footerTop: 730, commentBarShown: true }).height).toBe(690 - COMMENT_BAR_HEIGHT);
  });
  test("量不到終端機或太矮 ⇒ null", () => {
    expect(articleNavGeometry({ mainRect: { width: 0 } })).toBeNull();
    expect(articleNavGeometry({ mainRect: { ...mainRect, bottom: 100 } })).toBeNull();
  });
});

function makeCore(opts = {}) {
  const listeners = {};
  const lines = opts.lines || ["作者 someone 看板 Test", "內文", "推 abc: 好 10/23 12:34"];
  const scrolled = [];
  const core = {
    mobile: false,
    buf: {
      pageState: opts.pageState == null ? 3 : opts.pageState,
      cols: 80,
      get pageLines() {
        return lines;
      },
      getRowText: (r, s, e, acc) => String((acc || lines)[r]),
      addEventListener: (name, fn) => (listeners[name] = fn),
    },
    easyReading: {
      _enabled: true,
      _functionMode: false,
      scrollToArticleRow: (row) => (scrolled.push(row), true),
    },
    view: {
      mainDisplay: {
        getBoundingClientRect: () => ({ left: 0, right: 800, top: 0, bottom: 600, width: 800 }),
        scrollHeight: 2000,
        clientHeight: 600,
        scrollTop: 0,
      },
    },
  };
  return { nav: new ArticleNav(core), core, scrolled, settle: () => listeners.screenSettled() };
}

beforeEach(() => {
  vi.stubGlobal("window", {
    innerHeight: 600,
    innerWidth: 800,
    addEventListener: () => {},
    getComputedStyle: () => ({ display: "block" }),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("ArticleNav 控制器", () => {
  test("預設開；一個 byte 都不送 ⇒ 不在安全模式名單", () => {
    expect(DEFAULT_PREFS.enableArticleNav).toBe(true);
    expect(NATIVE_SAFE_MODE_KEYS).not.toContain("enableArticleNav");
  });

  test("好讀文章 ⇒ 出現在終端機右緣，第一則推文有標記", () => {
    const { nav, settle } = makeCore();
    settle();
    expect(nav.state).toMatchObject({ visible: true, left: 800 - ARTICLE_NAV_WIDTH, top: 0, height: 600, total: 3, commentRow: 2 });
    expect(nav.state.marks[0]).toMatchObject({ kind: "comments", row: 2 });
  });

  test("不在文章（列表）／pref 關 ⇒ 不出現", () => {
    const { nav, core, settle } = makeCore();
    settle();
    core.buf.pageState = 2;
    settle();
    expect(nav.state.visible).toBe(false);
    core.buf.pageState = 3;
    prefOverride.enableArticleNav = false;
    try {
      settle();
      expect(nav.state.visible).toBe(false);
    } finally {
      delete prefOverride.enableArticleNav;
    }
  });

  test("跳列只捲好讀視口；拖曳＝捲到那個比例、讓它落在視窗中間", () => {
    const { nav, core, scrolled, settle } = makeCore();
    settle();
    expect(nav.jumpTo(2)).toBe(true);
    expect(scrolled).toEqual([2]);
    nav.scrollToFraction(0.5);
    expect(core.view.mainDisplay.scrollTop).toBe(1000 - 300);
    nav.scrollToFraction(-1);
    expect(core.view.mainDisplay.scrollTop).toBe(0);
  });
});
