// Debug 錄製的開／停（src/js/debug_record_control.js）：錄製器生命週期與下載。
import {
  debugRecordFileName,
  isDebugRecording,
  isBackgroundRecording,
  startDebugRecording,
  stopDebugRecording,
  toggleDebugRecording,
  startBackgroundRecording,
  stopBackgroundRecording,
  saveBackgroundRecording,
} from "../../src/js/debug_record_control";
import { RING_WINDOW_MS } from "../../src/js/debug_recorder_logic";

class FakeRecorder {
  constructor(app, opts) {
    this.app = app;
    this.isRecording = false;
    this.stopArgs = null;
    this.windowMs = (opts && opts.windowMs) || 0;
    this.snapshots = 0;
  }
  get background() {
    return this.windowMs > 0;
  }
  start() {
    this.isRecording = true;
  }
  promote() {
    this.windowMs = 0;
  }
  snapshot() {
    this.snapshots++;
    return this.app.snapshotJson;
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

// ── 背景錄製（環形緩衝）───────────────────────────────────────────────

test("背景錄製：開在環形緩衝模式，不算「手動錄製中」（錄製鈕不變紅）", () => {
  const app = { debugRecorder: null };
  startBackgroundRecording(app, deps([]));
  expect(app.debugRecorder.windowMs).toBe(RING_WINDOW_MS);
  expect(isBackgroundRecording(app)).toBe(true);
  expect(isDebugRecording(app)).toBe(false);
});

test("存下最近 3 分鐘：下載 snapshot、錄製器不停（同一個繼續錄，可以再存）", () => {
  const app = { debugRecorder: null, snapshotJson: '{"ring":1}' };
  const downloads = [];
  startBackgroundRecording(app, deps(downloads));
  const recorder = app.debugRecorder;
  expect(saveBackgroundRecording(app, deps(downloads))).toBe(true);
  expect(saveBackgroundRecording(app, deps(downloads))).toBe(true);
  expect(app.debugRecorder).toBe(recorder);
  expect(recorder.isRecording).toBe(true);
  expect(recorder.snapshots).toBe(2);
  expect(downloads[0]).toEqual(["ptt-debug-20261009-080503.json", '{"ring":1}']);
});

test("存檔：沒開背景錄製（或正在手動錄製）⇒ 不下載", () => {
  const downloads = [];
  expect(saveBackgroundRecording({ debugRecorder: null }, deps(downloads))).toBe(false);
  const app = { debugRecorder: null };
  startDebugRecording(app, deps(downloads));
  expect(saveBackgroundRecording(app, deps(downloads))).toBe(false);
  expect(downloads).toEqual([]);
});

test("背景錄製中按手動錄製 ⇒ 同一個錄製器轉成完整錄製（前面幾分鐘一起帶走），不另開第二個", () => {
  const app = { debugRecorder: null, json: '{"manual":1}', bgDebugRecord: true };
  const downloads = [];
  startBackgroundRecording(app, deps(downloads));
  const recorder = app.debugRecorder;
  expect(toggleDebugRecording(app, deps(downloads)).recording).toBe(true);
  expect(app.debugRecorder).toBe(recorder);
  expect(isDebugRecording(app)).toBe(true);
  expect(isBackgroundRecording(app)).toBe(false);
  // 手動停止 ⇒ 下載完整的一卷；背景錄製仍開著 ⇒ 補開一個新的背景錄製器
  expect(toggleDebugRecording(app, deps(downloads))).toEqual({ recording: false, downloaded: true });
  expect(downloads).toEqual([["ptt-debug-20261009-080503.json", '{"manual":1}']]);
  expect(app.debugRecorder).not.toBe(recorder);
  expect(isBackgroundRecording(app)).toBe(true);
});

test("手動停止時背景錄製是關的 ⇒ 不補開", () => {
  const app = { debugRecorder: null, json: "{}", bgDebugRecord: false };
  startDebugRecording(app, deps([]));
  stopDebugRecording(app, deps([]));
  expect(app.debugRecorder).toBe(null);
});

test("手動錄製中開背景錄製 ⇒ 不動手動那卷", () => {
  const app = { debugRecorder: null };
  startDebugRecording(app, deps([]));
  const manual = app.debugRecorder;
  startBackgroundRecording(app, deps([]));
  expect(app.debugRecorder).toBe(manual);
  stopBackgroundRecording(app);
  expect(app.debugRecorder).toBe(manual);
  expect(manual.isRecording).toBe(true);
});

test("關背景錄製 ⇒ 丟掉緩衝（discard，不序列化）並卸下", () => {
  const app = { debugRecorder: null };
  startBackgroundRecording(app, deps([]));
  const recorder = app.debugRecorder;
  stopBackgroundRecording(app);
  expect(recorder.stopArgs).toEqual({ discard: true });
  expect(app.debugRecorder).toBe(null);
});
