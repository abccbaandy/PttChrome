// @unit-env browser
// App.onData 的水球通知閘門：瀏覽器只在失焦時解析＋通知；APK 每則都交給原生
// （WebView 切到背景不一定有 blur，前景與否由原生判斷，android_bridge.js 'notify'）。
// 收件匣不受這道閘門影響：每包都餵（message_inbox.js）。
//
// **檔案層級 import**：載入 App 會拖進整條主程式（見 tests/unit/module_load_cost.test.js）。
import { App } from "../../src/js/pttchrome";

const WIRE = "\x1b[1;33;46m★friend01\x1b[0;1;37;45m 在嗎 \x1b[m";

function fakeApp({ focused, notifications = true }) {
  return {
    appFocused: focused,
    boardNoteSkip: { noteRecv() {} },
    parser: { feed() {} },
    messageInbox: { noteData: vi.fn() },
    waterball: { userId: "", message: "" },
    view: { enableNotifications: notifications, showWaterballNotification: vi.fn() }
  };
}

afterEach(() => {
  delete window.__PTT_ANDROID__;
});

test("瀏覽器、有焦點：不通知，但收件匣照收", () => {
  const app = fakeApp({ focused: true });
  App.prototype.onData.call(app, WIRE);
  expect(app.view.showWaterballNotification).not.toHaveBeenCalled();
  expect(app.messageInbox.noteData).toHaveBeenCalledWith(WIRE);
});

test("瀏覽器、失焦：通知", () => {
  const app = fakeApp({ focused: false });
  App.prototype.onData.call(app, WIRE);
  expect(app.view.showWaterballNotification).toHaveBeenCalledTimes(1);
  expect(app.waterball).toEqual({ userId: "friend01", message: "在嗎" });
});

test("APK：有焦點也交給原生判斷", () => {
  window.__PTT_ANDROID__ = { version: "1", site: "x" };
  const app = fakeApp({ focused: true });
  App.prototype.onData.call(app, WIRE);
  expect(app.view.showWaterballNotification).toHaveBeenCalledTimes(1);
});

test("通知開關關掉：APK 也不送", () => {
  window.__PTT_ANDROID__ = { version: "1", site: "x" };
  const app = fakeApp({ focused: false, notifications: false });
  App.prototype.onData.call(app, WIRE);
  expect(app.view.showWaterballNotification).not.toHaveBeenCalled();
});
