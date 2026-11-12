// @unit-env browser
// App 層的故障隔離（架構 review A1 步驟 b，docs/feature-isolation.md）：
//   - onClose 逐功能收攤：正式版某一個丟例外 ⇒ 其餘照收、斷線狀態與提示照走；dev／測試照樣丟出。
//   - onPrefChange 逐 key：正式版交給 onError（以前默默吞掉）；dev／測試照樣丟出。
//
// **檔案層級 import**：載入 App 會拖進整條主程式（見 tests/unit/module_load_cost.test.js）。
import { App } from "../../src/js/pttchrome";
import { setListenerErrorPolicy } from "../../src/js/event";

const inert = () => new Proxy({}, { get: () => () => {} });

let prev;
beforeEach(() => {
  const alert = document.createElement("div");
  alert.id = "reactAlert";
  document.body.appendChild(alert);
});
afterEach(() => {
  if (prev) setListenerErrorPolicy(prev);
  prev = null;
  document.getElementById("reactAlert").remove();
});

function fakeApp() {
  return {
    logout: { onConnectionClosed: () => ({ loggedOut: true, quitApp: false }) },
    conn: {},
    buf: inert(),
    reconnectResume: { capture: vi.fn(), loggedInThisConnection: () => true },
    listSession: {
      disable: () => {
        throw new Error("list boom");
      },
    },
    boardListSession: inert(),
    aidNavigation: inert(),
    boardNoteSkip: inert(),
    helpMenu: inert(),
    longPush: inert(),
    deepLinkController: inert(),
    messageInbox: { reset: vi.fn() },
    cancelMbTimer() {},
    connectedUrl: { url: "wstelnet://x/bbs", opened: true },
    updateTabIcon: vi.fn(),
  };
}

describe("onClose 逐功能收攤", () => {
  test("正式版：一個收攤丟例外 ⇒ 其餘照收、斷線狀態與提示照走、例外交給 onError", () => {
    const errors = [];
    prev = setListenerErrorPolicy({ strict: false, onError: (info) => errors.push(info) });
    const app = fakeApp();
    App.prototype.onClose.call(app);
    expect(app.messageInbox.reset).toHaveBeenCalledTimes(1);
    expect(app.connectState).toBe(2);
    expect(app.updateTabIcon).toHaveBeenCalledWith("disconnect");
    expect(errors).toEqual([expect.objectContaining({ type: "close:listSession", feature: null, disabled: false })]);
  });

  test("dev／測試（strict）：照樣丟出", () => {
    expect(() => App.prototype.onClose.call(fakeApp())).toThrow("list boom");
  });
});

describe("onPrefChange 逐 key", () => {
  // mobileLayout 會呼叫 this.applyMobileLayout：替身沒有這個方法 ⇒ 丟 TypeError。
  test("正式版：交給 onError（帶 key），不往外丟", () => {
    const errors = [];
    prev = setListenerErrorPolicy({ strict: false, onError: (info) => errors.push(info) });
    expect(() => App.prototype.onPrefChange.call({}, "mobileLayout", 1)).not.toThrow();
    expect(errors).toEqual([expect.objectContaining({ type: "pref:mobileLayout" })]);
  });

  test("dev／測試（strict）：照樣丟出，不再默默吞掉", () => {
    expect(() => App.prototype.onPrefChange.call({}, "mobileLayout", 1)).toThrow(TypeError);
  });
});
