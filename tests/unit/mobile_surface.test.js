// @vitest-environment jsdom
// 手機 Phase 3–4 的畫面類型對帳（docs/mobile.md）。
// term_view._syncMobileSurface 是 render 前的對帳點：手機模式下，好讀長頁（!_gridRender）
// ⇒ 'article'（換行版面）、列表好讀視窗（帶 listScroll）⇒ 'list'（卡片），其餘 ⇒ 'grid'。
// 它必須在 render **之前**生效（forceWidth／列表視口高取當下 chh）。
import { TermView } from "../../src/js/term_view";

const makeView = ({ mobile, gridRender }) => {
  const view = Object.create(TermView.prototype);
  view.mobileSurface = "grid";
  view.reflow = false;
  view.listCards = false;
  view.reflowWidth = null;
  view._gridRender = gridRender;
  view.mainDisplay = document.createElement("div");
  view.bbscore = {
    mobile,
    _applyMobileGeometry: vi.fn((s) => {
      view.setMobileSurface(s);
      return true;
    }),
  };
  return view;
};

const sync = (v, ov) => v._syncMobileSurface(v._frameSurface(ov));

describe("TermView._frameSurface", () => {
  test("好讀長頁 ⇒ article；列表視窗 ⇒ list；其餘 ⇒ grid", () => {
    const v = makeView({ mobile: true, gridRender: false });
    expect(v._frameSurface()).toBe("article");
    v._gridRender = true;
    expect(v._frameSurface({ listScroll: { bodyStart: 3 } })).toBe("list");
    expect(v._frameSurface({ changedRows: [1] })).toBe("grid");
    expect(v._frameSurface()).toBe("grid");
  });
});

describe("TermView._syncMobileSurface", () => {
  test("手機＋好讀長頁 ⇒ 換行版面（.main 掛 mobileReflow）", () => {
    const v = makeView({ mobile: true, gridRender: false });
    sync(v);
    expect(v.bbscore._applyMobileGeometry).toHaveBeenCalledWith("article");
    expect(v.reflow).toBe(true);
    expect(v.mainDisplay.classList.contains("mobileReflow")).toBe(true);
  });

  test("手機＋列表視窗 ⇒ 卡片（.main 掛 mobileListCards）", () => {
    const v = makeView({ mobile: true, gridRender: true });
    sync(v, { listScroll: { bodyStart: 3 } });
    expect(v.listCards).toBe(true);
    expect(v.reflow).toBe(false);
    expect(v.mainDisplay.classList.contains("mobileListCards")).toBe(true);
    expect(v.mainDisplay.classList.contains("mobileReflow")).toBe(false);
  });

  test("狀態沒變就不重套幾何（每幀都會呼叫，不可每幀 fixedResize）", () => {
    const v = makeView({ mobile: true, gridRender: false });
    sync(v);
    sync(v);
    sync(v);
    expect(v.bbscore._applyMobileGeometry).toHaveBeenCalledTimes(1);
  });

  test("回到格線幀（functionMode／原生列表）⇒ 收掉換行版面與卡片", () => {
    const v = makeView({ mobile: true, gridRender: false });
    sync(v);
    v._gridRender = true;
    sync(v);
    expect(v.reflow).toBe(false);
    expect(v.mainDisplay.classList.contains("mobileReflow")).toBe(false);
    sync(v, { listScroll: {} });
    sync(v);
    expect(v.listCards).toBe(false);
    expect(v.mainDisplay.classList.contains("mobileListCards")).toBe(false);
  });

  test("桌機：好讀長頁／列表都不換版面（零改動）", () => {
    const v = makeView({ mobile: false, gridRender: false });
    sync(v);
    v._gridRender = true;
    sync(v, { listScroll: {} });
    expect(v.bbscore._applyMobileGeometry).not.toHaveBeenCalled();
    expect(v.mobileSurface).toBe("grid");
  });
});

describe("TermView.currentLineIndex", () => {
  test("格線版面：scrollTop / chh", () => {
    const v = Object.create(TermView.prototype);
    v.reflow = false;
    v.chh = 20;
    v.mainDisplay = { scrollTop: 245 };
    expect(v.currentLineIndex()).toBe(12);
  });

  test("沒有字級（還沒排版）⇒ null", () => {
    const v = Object.create(TermView.prototype);
    v.reflow = false;
    v.chh = 0;
    v.mainDisplay = { scrollTop: 245 };
    expect(v.currentLineIndex()).toBe(null);
  });
});
