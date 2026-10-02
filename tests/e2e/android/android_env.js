// Android 模擬器 e2e 的環境層：純函式（unit 守護 tests/unit/android_e2e.test.js）＋
// 給 fixture／scripts/run-android-e2e.mjs 共用的 adb 定位。設計見 docs/android-e2e.md。
const fs = require('fs');
const os = require('os');
const path = require('path');

// 環境問題（沒有模擬器、座標換算對不上）一律帶這個前綴丟出，
// run-android-e2e.mjs 據此把整輪判成 exit 2，而不是測試紅。
const ENV_ERROR_TAG = '[android-env]';

// 原生 Pixel 6（1080x2400 @420dpi ⇒ 412 CSS px 寬、DPR 2.625），跟真手機同比例。
const AVD_NAME = 'pttchrome_e2e';
const AVD_DEVICE = 'pixel_6';
const SYSTEM_IMAGE = 'system-images;android-34;google_apis;x86_64';

// 只碰模擬器：開發機上常同時連著實機（無線 adb），測試會斷網、清 Chrome 資料，
// 絕不能落到使用者的手機上。ANDROID_SERIAL 明確指定時照用（使用者自己負責）。
function pickEmulatorSerial(serials, env = {}) {
  if (env.ANDROID_SERIAL) return serials.includes(env.ANDROID_SERIAL) ? env.ANDROID_SERIAL : null;
  const emus = serials.filter((s) => /^emulator-\d+$/.test(s));
  return emus.length === 1 ? emus[0] : null;
}

// 頁面 CSS px → 螢幕 device px。origin ＝ WebView 在螢幕上的 bounds（UIAutomator），
// **不可寫死網址列高度**：斷網後系統會在狀態列下插一條「No internet connection」，
// 整個內容區往下推 55px，而且是幾秒後才出現。
function toDevicePoint(origin, dpr, { x, y }) {
  return { x: Math.round(origin.x + x * dpr), y: Math.round(origin.y + y * dpr) };
}

// `adb devices` 輸出 → 已就緒（state=device）的 serial。
function parseAdbDevices(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => /^(\S+)\s+device\b/.exec(l))
    .filter(Boolean)
    .map((m) => m[1]);
}

function sdkRoot(env = process.env, platform = process.platform) {
  if (env.ANDROID_HOME) return env.ANDROID_HOME;
  if (env.ANDROID_SDK_ROOT) return env.ANDROID_SDK_ROOT;
  if (platform === 'win32' && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, 'Android', 'Sdk');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Android', 'sdk');
  return path.join(os.homedir(), 'Android', 'Sdk');
}

// SDK 裡的工具；找不到回 null（交給呼叫端判 exit 2）。adb 另外退回 PATH（CI 的 runner）。
function sdkTool(name, env = process.env, platform = process.platform) {
  const exe = platform === 'win32' ? (name === 'avdmanager' || name === 'sdkmanager' ? '.bat' : '.exe') : '';
  const dir = { adb: 'platform-tools', emulator: 'emulator', avdmanager: 'cmdline-tools/latest/bin', sdkmanager: 'cmdline-tools/latest/bin' }[name];
  const p = path.join(sdkRoot(env, platform), dir, name + exe);
  if (fs.existsSync(p)) return p;
  return name === 'adb' ? 'adb' : null;
}

module.exports = {
  ENV_ERROR_TAG,
  AVD_NAME,
  AVD_DEVICE,
  SYSTEM_IMAGE,
  pickEmulatorSerial,
  toDevicePoint,
  parseAdbDevices,
  sdkRoot,
  sdkTool,
};
