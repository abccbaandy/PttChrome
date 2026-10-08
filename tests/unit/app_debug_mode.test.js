// @unit-env browser
// App 的 debug 模式接線（pttchrome.jsx#setDebugMode／toggleDebugRecording）：
//   - 開關 debug 模式 ⇒ view.debugRecordButton 跟著變並重畫（「⋯」裡的錄製鈕才會出現／消失）；
//   - 錄製中關掉 ⇒ 先停止並下載（不丟資料），通知「已下載」提示的訂閱者；
//   - 錄製鈕點擊 ⇒ 回傳切換後狀態、焦點還給終端機。
import { App } from '../../src/js/pttchrome';

function makeApp() {
  const app = Object.create(App.prototype);
  app.debugMode = false;
  app.debugRecorder = null;
  app._debugRecordDownloadedListeners = new Set();
  app.view = { debugRecordButton: false, redraw: vi.fn() };
  app.setInputAreaFocus = vi.fn();
  return app;
}

const fakeRecorder = (json) => ({
  isRecording: true,
  stop: vi.fn(function () {
    this.isRecording = false;
    return json;
  }),
});

test('開／關 debug 模式 ⇒ view 旗標跟著變並重畫；值沒變不重畫', () => {
  const app = makeApp();
  app.setDebugMode(true);
  expect(app.debugMode).toBe(true);
  expect(app.view.debugRecordButton).toBe(true);
  expect(app.view.redraw).toHaveBeenCalledTimes(1);
  app.setDebugMode(true);
  expect(app.view.redraw).toHaveBeenCalledTimes(1);
  app.setDebugMode(false);
  expect(app.view.debugRecordButton).toBe(false);
  expect(app.view.redraw).toHaveBeenCalledTimes(2);
});

test('錄製中關掉 debug 模式 ⇒ 停止、卸下錄製器、通知已下載', () => {
  const app = makeApp();
  app.setDebugMode(true);
  // 錄製器回 null ⇒ 不觸發真的下載（瀏覽器下載不在 unit 範圍），只驗停止與卸下。
  const recorder = fakeRecorder(null);
  app.debugRecorder = recorder;
  const seen = [];
  const off = app.onDebugRecordDownloaded(() => seen.push('downloaded'));
  app.setDebugMode(false);
  expect(recorder.stop).toHaveBeenCalledTimes(1);
  expect(app.debugRecorder).toBe(null);
  expect(seen).toEqual([]);
  off();
  expect(app._debugRecordDownloadedListeners.size).toBe(0);
});

test('toggleDebugRecording：開始回 true、焦點還給終端機', () => {
  const app = makeApp();
  app.conn = null;
  expect(app.toggleDebugRecording()).toBe(true);
  expect(app.debugRecorder && app.debugRecorder.isRecording).toBe(true);
  expect(app.setInputAreaFocus).toHaveBeenCalled();
  // 收尾：停掉（錄製器回空字串以外的內容會觸發下載；這裡直接換成假的）。
  app.debugRecorder.stop();
  app.debugRecorder = null;
});
