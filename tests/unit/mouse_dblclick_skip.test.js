// 雙擊選字在「滑鼠瀏覽」開啟時被殺掉的回歸鎖。
//
// 病灶：App.mouse_down 對「350ms 內的第二次 mousedown」呼叫 e.preventDefault()，
// 而那正是瀏覽器「取消本次選取」的開關 ⇒ 原生雙擊選詞／三擊選行整組失效。
// useMouseBrowsing 預設 true ⇒ **預設就是壞的**。
//
// 正解：第二下改用既有的 `SkipMouseClick` 旗標。App.mouse_click 開頭無條件讀取
// 並清空它，命中時 doMouseCommand=false ⇒「第二下不重複送 PTT 指令」完整保住，
// 但瀏覽器的選取行為不受干擾。
//
// 為什麼不能用 preventDefault：見 docs/enhanced-addon.md 踩坑 A
// （終端機的任何祖先都不可有 user-select:none，同一類「把原生選取掐死」的坑）。
import { App } from "../../src/js/pttchrome";

function makeApp({ selectionCollapsed = true, useMouseBrowsing = true } = {}) {
  const attrs = { SkipMouseClick: "0" };
  const app = Object.create(App.prototype);
  app.modalShown = false;
  app.CmdHandler = {
    getAttribute: (k) => attrs[k],
    setAttribute: (k, v) => {
      attrs[k] = v;
    },
  };
  app._attrs = attrs;
  app.buf = {
    useMouseBrowsing,
    listRenderMode: "native",
    onMouse_move: vi.fn(),
    // 點空白處關框：沒有框（App.mouse_click 每次點擊當下現算，見 screen_dismiss.js）。
    dismissTarget: () => null,
  };
  app.view = {};
  app.mouseButtons = { onMouseDown: vi.fn(), onMouseUp: vi.fn() };
  app.aidNavigation = { active: false };
  app.dblclickTimer = null;
  app.setDblclickTimer = vi.fn(() => {
    app.dblclickTimer = { cancel: vi.fn() };
  });
  app.cancelDblclickTimer = vi.fn();
  app.clientToPos = vi.fn(() => ({ col: 10, row: 5 }));
  app.mouseGates = vi.fn(() => ({ leftClick: true, misclickGuard: false }));
  app.onMouse_click = vi.fn();
  app.setInputAreaFocus = vi.fn();
  app.checkClass = vi.fn(() => false);
  app._onUploadLayer = vi.fn(() => false);

  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: selectionCollapsed,
    toString: () => (selectionCollapsed ? "" : "詞"),
  });
  return app;
}

function mouseEvent(overrides = {}) {
  return Object.assign(
    {
      button: 0,
      clientX: 100,
      clientY: 100,
      target: { className: "", tagName: "SPAN", closest: () => null },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    },
    overrides,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App.mouse_down 的雙擊 skip 分支", () => {
  test("350ms 內的第二次 mousedown 不得 preventDefault（否則雙擊選字被取消）", () => {
    const app = makeApp();

    const first = mouseEvent();
    app.mouse_down(first);
    expect(app.dblclickTimer).not.toBeNull();

    const second = mouseEvent();
    app.mouse_down(second);

    expect(second.preventDefault).not.toHaveBeenCalled();
    expect(second.stopPropagation).not.toHaveBeenCalled();
  });

  test("第二次 mousedown 改立 SkipMouseClick 旗標", () => {
    const app = makeApp();
    app.mouse_down(mouseEvent());
    app.mouse_down(mouseEvent());
    expect(app._attrs.SkipMouseClick).toBe("1");
  });

  test("旗標讓隨後的 mouse_click 不送 PTT 指令（第二下不重複翻頁）", () => {
    const app = makeApp();
    app.mouse_down(mouseEvent());
    app.mouse_down(mouseEvent());

    const click = mouseEvent();
    app.mouse_click(click);

    expect(app.onMouse_click).not.toHaveBeenCalled();
    // skip 分支仍會做冪等的 hover 更新（不送任何 byte）。
    expect(app.buf.onMouse_move).toHaveBeenCalledWith(10, 5);
    // 旗標是一次性的，讀完就清。
    expect(app._attrs.SkipMouseClick).toBe("0");
  });

  test("第一次 mousedown（沒有前一次）照常不 preventDefault、也不立旗標", () => {
    const app = makeApp();
    const e = mouseEvent();
    app.mouse_down(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(app._attrs.SkipMouseClick).toBe("0");
  });

  test("已有選取時（拖曳選完再按）照舊立旗標", () => {
    const app = makeApp({ selectionCollapsed: false });
    const e = mouseEvent();
    app.mouse_down(e);
    expect(app._attrs.SkipMouseClick).toBe("1");
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  test("關掉滑鼠瀏覽時不進 skip 分支，也永遠不 preventDefault", () => {
    const app = makeApp({ useMouseBrowsing: false });
    app.mouse_down(mouseEvent());
    const second = mouseEvent();
    app.mouse_down(second);
    expect(second.preventDefault).not.toHaveBeenCalled();
    expect(app.setDblclickTimer).not.toHaveBeenCalled();
  });
});
