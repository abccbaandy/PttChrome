// 滑鼠送鍵也要過序列閘門（serialized_op_gate.serializedOpHint）。
//
// 鍵盤、輸入法、貼上、功能鍵四條入口在序列化操作（搜尋兩步、跳到第一篇未讀、設為已讀、
// 重新整理、原生列表的稍後再讀、長推文、登出…）在線上時都會吞鍵＋提示；滑鼠的左鍵動作
// （列表點列 ⏎、左側退出帶 ←）、滾輪翻頁、中鍵 ← 以前只看 aidNavigation.active ⇒ 序列中途
// 插進一個 ⏎／PgDn／←：例如「跳到第一篇未讀」End → PgUp 之間點一列就開了那篇文章，
// 後面的 PgUp 落在文章裡。
import { App } from "../../src/js/pttchrome";
import { ACT_ENTER, ACT_EXIT } from "../../src/js/mouse_regions";

function makeApp({ busy = null } = {}) {
  const app = Object.create(App.prototype);
  app.modalShown = false;
  app.mouseButtons = { syncFromButtons: vi.fn() };
  app.aidNavigation = { active: false };
  app._onUploadLayer = vi.fn(() => false);
  app.mouseGates = vi.fn(() => ({
    wheel: true,
    wheelSmoothScroll: false,
    backNav: 1,
    middleClick: 2,
  }));
  app.conn = { isConnected: true };
  app.buf = {
    pageState: 2,
    listRenderMode: "native",
    cur_y: 5,
    mouseAction: ACT_ENTER,
    mouseActionRow: 8,
    isPromptPending: () => false,
  };
  app.hints = [];
  app.view = {
    useEasyReadingMode: false,
    _send: vi.fn(),
    flashListHint: (m) => app.hints.push(m),
  };
  app.easyReading = { _onMouseClick: vi.fn() };
  app.listSession = null;
  app.CmdHandler = { setAttribute: vi.fn() };
  app.setBBSCmd = vi.fn();
  if (busy) app[busy] = true;
  return app;
}

// real-input: tests/e2e/offline/mouse.offline.spec.js
const wheelDown = () => ({
  deltaX: 0,
  deltaY: 120,
  deltaMode: 0,
  timeStamp: 0,
  buttons: 0,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
});
const click = () => ({ button: 0, preventDefault: vi.fn(), defaultPrevented: false });

const BUSY_FLAGS = [
  "searchInFlight",
  "refreshInFlight",
  "unreadJumpInFlight",
  "markAllReadInFlight",
  "homeFavFetchInFlight",
  "nativeReadLaterInFlight",
];

describe("滾輪翻頁（原生畫面）", () => {
  test("沒有序列在線上：照送 PageDown（對照組）", () => {
    const app = makeApp();
    app.mouse_scroll(wheelDown());
    expect(app.setBBSCmd).toHaveBeenCalledWith("doPageDown");
  });

  test.each(BUSY_FLAGS)("%s 在線上：不送、閃提示", (flag) => {
    const app = makeApp({ busy: flag });
    const e = wheelDown();
    app.mouse_scroll(e);
    expect(app.setBBSCmd).not.toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
    expect(app.hints.length).toBe(1);
  });
});

describe("左鍵動作（列表點列 ⏎、左側退出帶 ←）", () => {
  test("沒有序列在線上：點列照送 ↓…⏎（對照組）", () => {
    const app = makeApp();
    app.onMouse_click(click());
    expect(app.view._send).toHaveBeenCalledWith("\x1b[B\x1b[B\x1b[B\r");
  });

  test.each(BUSY_FLAGS)("%s 在線上：點列不送、閃提示", (flag) => {
    const app = makeApp({ busy: flag });
    app.onMouse_click(click());
    expect(app.view._send).not.toHaveBeenCalled();
    expect(app.hints.length).toBe(1);
  });

  test("長推文送出中：左側退出帶不送 ←", () => {
    const app = makeApp();
    app.buf.mouseAction = ACT_EXIT;
    app.longPush = { active: true, opHint: "長推文送出中" };
    app.onMouse_click(click());
    expect(app.view._send).not.toHaveBeenCalled();
    expect(app.hints).toEqual(["長推文送出中"]);
  });
});

describe("中鍵 ←", () => {
  test("沒有序列在線上：照送（對照組）", () => {
    const app = makeApp();
    app.middleMouse_down({ button: 1, target: null });
    expect(app.view._send).toHaveBeenCalledWith("\x1b[D");
  });

  test("序列在線上：不送", () => {
    const app = makeApp({ busy: "unreadJumpInFlight" });
    app.middleMouse_down({ button: 1, target: null });
    expect(app.view._send).not.toHaveBeenCalled();
  });
});
