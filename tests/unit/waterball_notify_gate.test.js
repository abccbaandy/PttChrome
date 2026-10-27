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
    commandQueue: { noteRecv() {} },
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

// 不是水球閘門，但同一個入口：CommandQueue 的線路靜默寬限靠「收過 byte 沒有」判定
// （command_queue.js 檔頭 stallCapMs），而且要在 parser.feed 之前告知 —— feed 引發
// 的 settle／判定要看得到線路已經有聲音。
test("每包先告訴 CommandQueue 線路有聲音，再餵 parser", () => {
  const order = [];
  const app = fakeApp({ focused: true });
  app.commandQueue = { noteRecv: () => order.push("noteRecv") };
  app.parser = { feed: () => order.push("feed") };
  App.prototype.onData.call(app, WIRE);
  expect(order).toEqual(["noteRecv", "feed"]);
});
