// Debug 錄製的開／停（原 src/components/DebugRecordButton 裡的邏輯）。
// 錄製鈕本身住在「⋯」浮動工具的面板裡（render/merge_buttons.js#createDebugRecordButton），
// 由 App 的 debug 模式（設定→關於，runtime-only）決定出不出現；這裡只管錄製器的生命週期：
//   開始 ＝ new DebugRecorder(app).start()（monkey-patch onData/_sendRaw）
//   停止 ＝ stop → redact → 觸發下載 JSON（schema 見 debug_recorder_logic.js）
// app.debugRecorder 是唯一的狀態（null ＝沒在錄）。下載與 prefs 讀取可注入（測試用）。
import { DebugRecorder } from './debug_recorder';
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

export function isDebugRecording(app) {
  return !!(app && app.debugRecorder && app.debugRecorder.isRecording);
}

export function startDebugRecording(app, deps) {
  if (isDebugRecording(app)) return;
  const Recorder = (deps && deps.Recorder) || DebugRecorder;
  app.debugRecorder = new Recorder(app);
  app.debugRecorder.start();
}

// 回傳是否真的下載了檔案（沒在錄 ⇒ false）。
export function stopDebugRecording(app, deps) {
  if (!isDebugRecording(app)) return false;
  const d = deps || {};
  const readPrefs = d.readPrefs || readValuesWithDefault;
  const download = d.download || downloadAsFile;
  const json = app.debugRecorder.stop({ prefs: readPrefs() });
  app.debugRecorder = null;
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
