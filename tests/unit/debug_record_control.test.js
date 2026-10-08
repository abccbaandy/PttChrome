// Debug 錄製的開／停（src/js/debug_record_control.js）：錄製器生命週期與下載。
import {
  debugRecordFileName,
  isDebugRecording,
  startDebugRecording,
  stopDebugRecording,
  toggleDebugRecording,
} from "../../src/js/debug_record_control";

class FakeRecorder {
  constructor(app) {
    this.app = app;
    this.isRecording = false;
    this.stopArgs = null;
  }
  start() {
    this.isRecording = true;
  }
  stop(opts) {
    this.isRecording = false;
    this.stopArgs = opts;
    return this.app.json;
  }
}

const deps = (downloads) => ({
  Recorder: FakeRecorder,
  readPrefs: () => ({ fontSize: 20 }),
  download: (name, json) => downloads.push([name, json]),
  now: () => new Date(2026, 9, 9, 8, 5, 3),
});

test("檔名＝ptt-debug-YYYYMMDD-HHMMSS.json（本地時間、補零）", () => {
  expect(debugRecordFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe(
    "ptt-debug-20260102-030405.json",
  );
});

test("toggle：開始 → 停止並下載（帶 prefs），之後 debugRecorder 歸 null", () => {
  const app = { debugRecorder: null, json: '{"ok":1}' };
  const downloads = [];
  expect(toggleDebugRecording(app, deps(downloads))).toEqual({
    recording: true,
    downloaded: false,
  });
  expect(isDebugRecording(app)).toBe(true);
  const recorder = app.debugRecorder;
  expect(toggleDebugRecording(app, deps(downloads))).toEqual({
    recording: false,
    downloaded: true,
  });
  expect(recorder.stopArgs).toEqual({ prefs: { fontSize: 20 } });
  expect(app.debugRecorder).toBe(null);
  expect(downloads).toEqual([["ptt-debug-20261009-080503.json", '{"ok":1}']]);
});

test("stop：沒在錄 ⇒ no-op、不下載", () => {
  const app = { debugRecorder: null };
  const downloads = [];
  expect(stopDebugRecording(app, deps(downloads))).toBe(false);
  expect(downloads).toEqual([]);
});

test("stop：錄製器回空 ⇒ 不下載但仍卸下", () => {
  const app = { debugRecorder: null, json: null };
  const downloads = [];
  startDebugRecording(app, deps(downloads));
  expect(stopDebugRecording(app, deps(downloads))).toBe(false);
  expect(app.debugRecorder).toBe(null);
  expect(downloads).toEqual([]);
});

test("start：已在錄 ⇒ 不重建錄製器", () => {
  const app = { debugRecorder: null };
  startDebugRecording(app, deps([]));
  const first = app.debugRecorder;
  startDebugRecording(app, deps([]));
  expect(app.debugRecorder).toBe(first);
});
