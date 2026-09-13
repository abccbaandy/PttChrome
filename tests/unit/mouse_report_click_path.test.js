// XTerm SGR 滑鼠回報在 App.mouse_click / App.mouse_scroll 的接線鎖。
//
// 編碼與狀態機另有 mouse_report_encode / mouse_report_modes；這裡鎖的是純函式
// 看不到的四件事：
//   1. **優先權**：連結／預覽／有選取／列表好讀（buffer/frozen）一律贏過回報；
//   2. **只在原生 24 列畫面回報**（好讀長頁與虛擬視窗的列號跟 server 對不起來）；
//   3. **座標真的走 clientToPos**（不得另寫幾何——docs/mouse.md 的座標契約）；
//   4. **送出走 view._send()**，不得直接碰 view.conn（CLAUDE.md：view.conn 在
//      連線成功前是 undefined）。
import { App } from "../../src/js/pttchrome";

function makeApp({
  serverReport = true,
  reportable = true,
  listRenderMode = "native",
  useEasyReadingMode = false,
  pageState = 2,
  col = 40,
  row = 10,
  selectionCollapsed = true,
  closest = () => null,
} = {}) {
  const app = Object.create(App.prototype);
  app.modalShown = false;
  app.CmdHandler = { getAttribute: () => "0", setAttribute: () => {} };
  const conn = { send: vi.fn() };
  app.buf = {
    useMouseBrowsing: true,
    listRenderMode,
    pageState,
    cols: 80,
    rows: 24,
    cur_y: 23,
    onMouse_move: vi.fn(),
    dismissTarget: vi.fn(() => null),
    mouseAction: "none",
    mouseActionRow: -1,
  };
  app.view = { _send: vi.fn(), useEasyReadingMode, conn };
  // pref 關掉時滾輪會落回既有的 setBBSCmd 翻頁路徑，那條是 fork 來的舊碼、
  // 直接用 this.conn.send（不是本次新增的），stub 要餵得動它。
  app.conn = conn;
  app._testConn = conn;
  app.mouseButtons = {
    onMouseDown: vi.fn(),
    onMouseUp: vi.fn(),
    syncFromButtons: vi.fn()
  };
  app.aidNavigation = { active: false };
  app.dblclickTimer = null;
  app.setDblclickTimer = vi.fn();
  // 刻意用「非 1:1」的座標：若實作偷偷改用 e.clientX/clientY 當格子座標，
  // 送出去的字串就會不一樣。
  app.clientToPos = vi.fn(() => ({ col, row }));
  app.mouseGates = vi.fn(() => ({
    leftClick: !serverReport,
    misclickGuard: false,
    serverReport,
    wheel: !serverReport
  }));
  app.activeListSession = vi.fn(() => null);
  app.onMouse_click = vi.fn();
  app.setInputAreaFocus = vi.fn();
  app.checkClass = vi.fn(() => false);
  app._onUploadLayer = vi.fn(() => false);
  if (!reportable) app._serverMouseReportable = vi.fn(() => false);

  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: selectionCollapsed,
    toString: () => (selectionCollapsed ? "" : "selected")
  });
  app._testClosest = closest;
  return app;
}

const clickEvent = (app, over = {}) =>
  Object.assign(
    {
      button: 0,
      clientX: 100,
      clientY: 100,
      target: { className: "", tagName: "SPAN", closest: app._testClosest },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    },
    over
  );

const wheelEvent = (over = {}) =>
  Object.assign(
    {
      clientX: 100,
      clientY: 100,
      deltaY: 100,
      deltaX: 0,
      target: { closest: () => null },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    },
    over
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App.mouse_click：SGR 回報", () => {
  test("原生畫面 + serverReport ⇒ 送出 press+release 兩段", () => {
    const app = makeApp({ col: 4, row: 9 });
    const e = clickEvent(app);
    app.mouse_click(e);
    expect(app.view._send).toHaveBeenCalledWith("\x1b[<0;5;10M\x1b[<0;5;10m");
    expect(e.preventDefault).toHaveBeenCalled();
    // 不得落到我們自己那套滑鼠瀏覽。
    expect(app.onMouse_click).not.toHaveBeenCalled();
  });

  test("座標真的來自 clientToPos（不得另寫幾何）", () => {
    const app = makeApp({ col: 79, row: 23 });
    app.mouse_click(clickEvent(app));
    expect(app.clientToPos).toHaveBeenCalledWith(100, 100);
    expect(app.view._send).toHaveBeenCalledWith("\x1b[<0;80;24M\x1b[<0;80;24m");
  });

  test("modifier 進得了 button code（Ctrl+點 ⇒ 16）", () => {
    const app = makeApp({ col: 0, row: 0 });
    app.mouse_click(clickEvent(app, { ctrlKey: true }));
    expect(app.view._send).toHaveBeenCalledWith("\x1b[<16;1;1M\x1b[<16;1;1m");
  });

  test("**絕不**直接呼叫 view.conn.send（一律走 view._send）", () => {
    const app = makeApp();
    app.mouse_click(clickEvent(app));
    expect(app._testConn.send).not.toHaveBeenCalled();
  });

  test("pref／主機沒開（serverReport false）⇒ 零 byte", () => {
    const app = makeApp({ serverReport: false });
    app.mouse_click(clickEvent(app));
    expect(app.view._send).not.toHaveBeenCalled();
  });

  test.each([
    ["列表好讀 buffer", "buffer"],
    ["列表好讀 frozen", "frozen"]
  ])("%s 的虛擬座標不得回報（零 byte）", (_n, mode) => {
    const app = makeApp({ listRenderMode: mode });
    app.mouse_click(clickEvent(app));
    expect(app.view._send).not.toHaveBeenCalled();
  });

  test("文章好讀長頁（列號會被 clamp）不得回報", () => {
    const app = makeApp({ useEasyReadingMode: true, pageState: 3 });
    app.mouse_click(clickEvent(app));
    expect(app.view._send).not.toHaveBeenCalled();
  });

  test("點在連結上 ⇒ 連結優先，零 byte", () => {
    const link = { tagName: "A" };
    const app = makeApp({ closest: (sel) => (sel === "a" ? link : null) });
    app.mouse_click(clickEvent(app));
    expect(app.view._send).not.toHaveBeenCalled();
  });

  test("有選取文字 ⇒ 選字優先，零 byte（原生選取不可被干擾）", () => {
    const app = makeApp({ selectionCollapsed: false });
    app.mouse_click(clickEvent(app));
    expect(app.view._send).not.toHaveBeenCalled();
  });

  test("推文列（data-pusher）不得吃掉回報", () => {
    const pusher = {
      getAttribute: (k) => (k === "data-pusher" ? "someone" : "7")
    };
    const app = makeApp({
      closest: (sel) => (sel === "[data-pusher]" ? pusher : null)
    });
    app.view.togglePusherHighlight = vi.fn();
    app.mouse_click(clickEvent(app));
    expect(app.view.togglePusherHighlight).not.toHaveBeenCalled();
    expect(app.view._send).toHaveBeenCalledWith("\x1b[<0;41;11M\x1b[<0;41;11m");
  });
});

describe("App.mouse_scroll：SGR 回報", () => {
  test("往下 ⇒ 65、往上 ⇒ 64", () => {
    const down = makeApp({ col: 0, row: 0 });
    down.mouse_scroll(wheelEvent({ deltaY: 100 }));
    expect(down.view._send).toHaveBeenCalledWith("\x1b[<65;1;1M");

    const up = makeApp({ col: 0, row: 0 });
    up.mouse_scroll(wheelEvent({ deltaY: -100 }));
    expect(up.view._send).toHaveBeenCalledWith("\x1b[<64;1;1M");
  });

  test("水平滾輪不回報（xterm 66/67 刻意不實作）", () => {
    const app = makeApp();
    app.mouse_scroll(wheelEvent({ deltaX: -120, deltaY: 0 }));
    expect(app.view._send).not.toHaveBeenCalled();
  });

  test("文章好讀不回報（交給瀏覽器原生捲動）", () => {
    const app = makeApp({ useEasyReadingMode: true, pageState: 3 });
    app.mouse_scroll(wheelEvent());
    expect(app.view._send).not.toHaveBeenCalled();
  });

  test("列表好讀不回報", () => {
    const app = makeApp({ listRenderMode: "buffer" });
    app.mouse_scroll(wheelEvent());
    expect(app.view._send).not.toHaveBeenCalled();
  });

  test("pref 關掉時回到原本的翻頁路徑（送 PageDown，不送 SGR）", () => {
    const app = makeApp({ serverReport: false });
    app.mouseGates = vi.fn(() => ({
      leftClick: true,
      misclickGuard: false,
      serverReport: false,
      wheel: true
    }));
    app.mouse_scroll(wheelEvent({ deltaY: 100 }));
    expect(app._testConn.send).toHaveBeenCalledWith("\x1b[6~"); // 原本的 PageDown
    expect(app.view._send).not.toHaveBeenCalled();
  });
});
