// Debug 錄製的開／停（原 src/components/DebugRecordButton 裡的邏輯）。
// 錄製鈕本身住在「⋯」浮動工具的面板裡（render/merge_buttons.js#createDebugRecordButton），
// 由 App 的 debug 模式（設定→關於，runtime-only）決定出不出現；這裡只管錄製器的生命週期：
//   開始 ＝ new DebugRecorder(app).start()（monkey-patch onData/_sendRaw）
//   停止 ＝ stop → redact → 觸發下載 JSON（schema 見 debug_recorder_logic.js）
// app.debugRecorder 是唯一的狀態（null ＝沒在錄）。下載與 prefs 讀取可注入（測試用）。
//
// 背景錄製（pref bgDebugRecord）：同一個 DebugRecorder 開在環形緩衝模式，只留最後
// 三分鐘（debug_recorder_logic.js#RING_WINDOW_MS），「存下最近 3 分鐘」＝ snapshot 下載、
// 繼續錄。**任何時刻只有一個錄製器**（兩個都 monkey-patch onData，停止順序不對就還原
// 錯）：手動開始 ＝背景那個 promote 成完整錄製（前面三分鐘一起帶進檔案）；手動停止
// 後若背景錄製仍開著，重新起一個背景錄製器。
import { DebugRecorder } from './debug_recorder';
import { RING_WINDOW_MS } from './debug_recorder_logic';
import { downloadAsFile } from './util';
import { readValuesWithDefault } from './pref_storage';

const pad2 = (n) => String(n).padStart(2, '0');

export function debugRecordFileName(d) {
  const t = d || new Date();
  return (
    'ptt-debug-' +
    t.getFullYear() +
    pad2(t.getMonth() + 1) +
    pad2(t.getDate()) +
    '-' +
    pad2(t.getHours()) +
    pad2(t.getMinutes()) +
    pad2(t.getSeconds()) +
    '.json'
  );
}

// 手動錄製中（錄製鈕的紅色狀態）。背景錄製不算。
export function isDebugRecording(app) {
  const rec = app && app.debugRecorder;
  return !!(rec && rec.isRecording && !rec.background);
}

export function isBackgroundRecording(app) {
  const rec = app && app.debugRecorder;
  return !!(rec && rec.isRecording && rec.background);
}

export function startDebugRecording(app, deps) {
  if (isDebugRecording(app)) return;
  if (isBackgroundRecording(app)) {
    app.debugRecorder.promote();
    return;
  }
  const Recorder = (deps && deps.Recorder) || DebugRecorder;
  app.debugRecorder = new Recorder(app);
  app.debugRecorder.start();
}

// 開背景錄製；手動錄製中 ⇒ 什麼都不做（手動停止時會依 app.bgDebugRecord 補開）。
export function startBackgroundRecording(app, deps) {
  if (app.debugRecorder && app.debugRecorder.isRecording) return;
  const Recorder = (deps && deps.Recorder) || DebugRecorder;
  app.debugRecorder = new Recorder(app, { windowMs: RING_WINDOW_MS });
  app.debugRecorder.start();
}

// 關背景錄製並丟掉緩衝（手動錄製不受影響）。
export function stopBackgroundRecording(app) {
  if (!isBackgroundRecording(app)) return;
  app.debugRecorder.stop({ discard: true });
  app.debugRecorder = null;
}

// 存下背景錄製的最近三分鐘（下載），錄製器繼續跑。回傳是否真的下載了。
export function saveBackgroundRecording(app, deps) {
  if (!isBackgroundRecording(app)) return false;
  const d = deps || {};
  const readPrefs = d.readPrefs || readValuesWithDefault;
  const download = d.download || downloadAsFile;
  const json = app.debugRecorder.snapshot({ prefs: readPrefs() });
  if (!json) return false;
  download(debugRecordFileName(d.now ? d.now() : undefined), json);
  return true;
}

// 回傳是否真的下載了檔案（沒在錄 ⇒ false）。
export function stopDebugRecording(app, deps) {
  if (!isDebugRecording(app)) return false;
  const d = deps || {};
  const readPrefs = d.readPrefs || readValuesWithDefault;
  const download = d.download || downloadAsFile;
  const json = app.debugRecorder.stop({ prefs: readPrefs() });
  app.debugRecorder = null;
  if (app.bgDebugRecord) startBackgroundRecording(app, d);
  if (!json) return false;
  download(debugRecordFileName(d.now ? d.now() : undefined), json);
  return true;
}

// 回傳 { recording, downloaded }：recording ＝切換後的狀態。
export function toggleDebugRecording(app, deps) {
  if (isDebugRecording(app)) {
    const downloaded = stopDebugRecording(app, deps);
    return { recording: false, downloaded };
  }
  startDebugRecording(app, deps);
  return { recording: true, downloaded: false };
}
