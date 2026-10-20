// @unit-env browser
// 手機列表卡片「點了沒開文」的留痕（App._traceListTap）：只在 debug 錄製中、而且是
// 卡片模式才寫，記下這一下在哪裡被擋掉（modal／選取／不是卡片本體…）與 session 狀態。
// 問題本身不好重現（使用者 2026-10-20 回報），下次附錄製檔就看得出原因。
//
// **檔案層級 import**：載入 App 會拖進整條主程式（見 tests/unit/module_load_cost.test.js）。
import { App } from "../../src/js/pttchrome";

function fakeApp({ listCards = true, recording = true } = {}) {
  return {
    debugRecorder: recording ? { log: vi.fn() } : null,
    view: { listCards },
    buf: { listRenderMode: "buffer" },
    listSession: { state: "active" }
  };
}

const target = Object.assign(document.createElement("span"), { className: "listCardMain" });

test("錄製中＋卡片模式：記下擋掉的原因、目標與 session 狀態", () => {
  const app = fakeApp();
  App.prototype._traceListTap.call(app, "selection", { target });
  expect(app.debugRecorder.log).toHaveBeenCalledWith("listTap", {
    outcome: "selection",
    target: "listCardMain",
    renderMode: "buffer",
    state: "active"
  });
});

test("沒在錄製：什麼都不做", () => {
  const app = fakeApp({ recording: false });
  expect(() => App.prototype._traceListTap.call(app, "modal", { target })).not.toThrow();
});

test("桌機（不是卡片模式）：不記", () => {
  const app = fakeApp({ listCards: false });
  App.prototype._traceListTap.call(app, "modal", { target });
  expect(app.debugRecorder.log).not.toHaveBeenCalled();
});
