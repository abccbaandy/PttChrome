// 「點空白處關框」在 App.mouse_click 的接線鎖（判斷本身另有 screen_dismiss.test.js）。
//
// 這裡鎖的是三件純函式看不到的事：
//   1. gate ＝ useMouseBrowsing && mouseLeftClick（D1：**不開新 pref**）；
//   2. 送鍵**不走 buf.mouseAction** —— notify 的每個 changed 幀都 clearHighlight()
//      把它清成 none，而框正是「畫面剛變出來」的東西 ⇒ 使用者不動滑鼠直接點下去
//      時必定讀到 none。所以這條路在點擊當下呼叫 buf.dismissTarget() 現算；
//   3. 沒有框時**一個 byte 都不送**（沒有「安全鍵」：Ctrl-C 在文章列表會清標記
//      清單 read.c:950，空白鍵在文章裡是翻頁）。
import { App } from "../../src/js/pttchrome";

function makeApp({
  dismiss = null,
  leftClick = true,
  listRenderMode = "native",
  cur_y = 23,
  clickRow = 10,
} = {}) {
  const app = Object.create(App.prototype);
  app.modalShown = false;
  app.CmdHandler = {
    getAttribute: () => "0",
    setAttribute: () => {},
  };
  app.buf = {
    useMouseBrowsing: true,
    listRenderMode,
    cur_y,
    onMouse_move: vi.fn(),
    dismissTarget: vi.fn(() => dismiss),
    // 若實作退回去讀 mouseAction，這個「已被 clearHighlight 清成 none」的值
    // 會讓測試紅 —— 那正是要防的回歸。
    mouseAction: "none",
    mouseActionRow: -1,
  };
  app.view = { _send: vi.fn() };
  app.mouseButtons = { onMouseDown: vi.fn(), onMouseUp: vi.fn() };
  app.aidNavigation = { active: false };
  app.dblclickTimer = null;
  app.setDblclickTimer = vi.fn();
  app.clientToPos = vi.fn(() => ({ col: 40, row: clickRow }));
  app.mouseGates = vi.fn(() => ({ leftClick, misclickGuard: false }));
  app.activeListSession = vi.fn(() => null);
  app.onMouse_click = vi.fn();
  app.setInputAreaFocus = vi.fn();
  app.checkClass = vi.fn(() => false);
  app._onUploadLayer = vi.fn(() => false);

  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: true,
    toString: () => "",
  });
  return app;
}

const clickEvent = (over = {}) =>
  Object.assign(
    {
      button: 0,
      clientX: 100,
      clientY: 100,
      target: { className: "", tagName: "SPAN", closest: () => null },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    },
    over,
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App.mouse_click：點空白處關框", () => {
  test("pressanykey 的框 → 送空白鍵，並吃掉這一下（不落到滑鼠瀏覽分支）", () => {
    const app = makeApp({ dismiss: { kind: "anyKey", bytes: " " } });
    const e = clickEvent();
    app.mouse_click(e);
    expect(app.view._send).toHaveBeenCalledWith(" ");
    expect(e.preventDefault).toHaveBeenCalled();
    expect(app.onMouse_click).not.toHaveBeenCalled();
  });

  test("輸入欄的框 → 送 Ctrl-C", () => {
    const app = makeApp({ dismiss: { kind: "inputField", bytes: "\x03" } });
    app.mouse_click(clickEvent());
    expect(app.view._send).toHaveBeenCalledWith("\x03");
  });

  test("REGRESSION：現算而不是讀 buf.mouseAction（框剛出現時它必定是 none）", () => {
    const app = makeApp({ dismiss: { kind: "anyKey", bytes: " " } });
    app.mouse_click(clickEvent());
    expect(app.buf.dismissTarget).toHaveBeenCalled();
    expect(app.view._send).toHaveBeenCalledWith(" ");
  });

  test("REGRESSION：D2 —— 點在游標那一列不送鍵，但仍吃掉這一下", () => {
    const app = makeApp({
      dismiss: { kind: "inputField", bytes: "\x03" },
      cur_y: 23,
      clickRow: 23,
    });
    const e = clickEvent();
    app.mouse_click(e);
    expect(app.view._send).not.toHaveBeenCalled();
    // 框開著時整個畫面都是我們的，不能讓瀏覽器預設行為對它動作。
    expect(e.preventDefault).toHaveBeenCalled();
    expect(app.onMouse_click).not.toHaveBeenCalled();
  });

  test("NEGATIVE：沒有框 ⇒ 一個 byte 都不送，照常走滑鼠瀏覽", () => {
    const app = makeApp({ dismiss: null });
    app.mouse_click(clickEvent());
    expect(app.view._send).not.toHaveBeenCalled();
    expect(app.onMouse_click).toHaveBeenCalled();
  });

  test("D1 gate：mouseLeftClick 關掉 ⇒ 不送關框鍵", () => {
    const app = makeApp({
      dismiss: { kind: "anyKey", bytes: " " },
      leftClick: false,
    });
    app.mouse_click(clickEvent());
    expect(app.view._send).not.toHaveBeenCalled();
  });

  test("列表好讀 buffer/frozen ⇒ 不直送 byte（v5 封閉互動，須走 CommandQueue）", () => {
    for (const mode of ["buffer", "frozen"]) {
      const app = makeApp({
        dismiss: { kind: "anyKey", bytes: " " },
        listRenderMode: mode,
      });
      app.mouse_click(clickEvent());
      expect(app.view._send).not.toHaveBeenCalled();
    }
  });

  test("連結／功能鍵按鈕優先：closest('a') 命中時關框完全不參與", () => {
    const app = makeApp({ dismiss: { kind: "anyKey", bytes: " " } });
    app.mouse_click(
      clickEvent({
        target: {
          className: "",
          tagName: "A",
          closest: (sel) => (sel === "a" ? {} : null),
        },
      }),
    );
    expect(app.view._send).not.toHaveBeenCalled();
    expect(app.buf.dismissTarget).not.toHaveBeenCalled();
  });
});
