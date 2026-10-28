// @unit-env browser
// 「登出並關閉 App」在 App 這一層的串接（pttchrome.jsx startLogout／onClose）：
//   - 走完 PTT 正常登出、server 關線（logout.onConnectionClosed 回 quitApp）才送 bridge 'quitApp'；
//   - 只登出、登出失敗 ⇒ 不關，照舊畫「已登出」／連線中斷提示；
//   - 按下時本來就沒連線 ⇒ 沒東西要登出，直接關。
// LogoutSession 本身的 byte 序列與 quitApp 旗標見 tests/unit/logout_session.test.js。
//
// **檔案層級 import**：載入 App 會拖進整條主程式（見 tests/unit/module_load_cost.test.js）。
import { App } from "../../src/js/pttchrome";

// 什麼方法都吃、什麼都不做的替身（onClose 的收攤會碰一長串 session）。
const inert = () => new Proxy({}, { get: () => () => {} });

let sent;
beforeEach(() => {
  sent = [];
  window.__PTT_ANDROID__ = { version: "1", site: "x", quitApp: true };
  window.PttAndroid = {
    postMessage: (s) => sent.push(JSON.parse(s)),
    addEventListener() {},
  };
  const alert = document.createElement("div");
  alert.id = "reactAlert";
  document.body.appendChild(alert);
});

afterEach(() => {
  delete window.__PTT_ANDROID__;
  delete window.PttAndroid;
  document.getElementById("reactAlert").remove();
});

function fakeApp(closed) {
  return {
    logout: { onConnectionClosed: () => closed },
    conn: {},
    buf: inert(),
    reconnectResume: { capture: vi.fn() },
    listSession: inert(),
    boardListSession: inert(),
    aidNavigation: inert(),
    boardNoteSkip: inert(),
    helpMenu: inert(),
    longPush: inert(),
    deepLinkController: inert(),
    messageInbox: inert(),
    cancelMbTimer() {},
    connectedUrl: { url: "wstelnet://x/bbs", opened: true },
    updateTabIcon: vi.fn(),
  };
}

const quitOps = () => sent.filter((m) => m.op === "quitApp");

describe("onClose", () => {
  test("登出並關閉 App：收攤照做、送 quitApp、不畫提示", () => {
    const app = fakeApp({ loggedOut: true, quitApp: true });
    App.prototype.onClose.call(app);
    expect(app.reconnectResume.capture).toHaveBeenCalledWith(true);
    expect(quitOps()).toHaveLength(1);
    expect(document.getElementById("reactAlert").childElementCount).toBe(0);
  });

  test("只登出 ⇒ 不關 App", () => {
    App.prototype.onClose.call(fakeApp({ loggedOut: true, quitApp: false }));
    expect(quitOps()).toHaveLength(0);
  });

  test("一般斷線 ⇒ 不關 App", () => {
    App.prototype.onClose.call(fakeApp({ loggedOut: false, quitApp: false }));
    expect(quitOps()).toHaveLength(0);
  });
});

describe("startLogout", () => {
  const appWith = (connected) => ({
    isConnected: () => connected,
    logout: { start: vi.fn(() => true) },
  });

  test("連線中：交給 LogoutSession（帶著 quitApp），不先關", () => {
    const app = appWith(true);
    expect(App.prototype.startLogout.call(app, { quitApp: true })).toBe(true);
    expect(app.logout.start).toHaveBeenCalledWith({ quitApp: true });
    expect(quitOps()).toHaveLength(0);
  });

  test("本來就沒連線 ⇒ 直接關 App", () => {
    const app = appWith(false);
    expect(App.prototype.startLogout.call(app, { quitApp: true })).toBe(true);
    expect(app.logout.start).not.toHaveBeenCalled();
    expect(quitOps()).toHaveLength(1);
  });

  test("沒連線、只登出 ⇒ 什麼都不做", () => {
    const app = appWith(false);
    expect(App.prototype.startLogout.call(app, { quitApp: false })).toBe(false);
    expect(quitOps()).toHaveLength(0);
  });
});
