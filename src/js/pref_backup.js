// 設定備份：匯出／匯入檔案的純邏輯（無 DOM、無網路）——單元測試在
// tests/unit/pref_backup.test.js。真正的檔案下載（downloadAsFile）與檔案讀取
// （input[type=file]）留在 PrefModal，合併沿用 pref_sync_logic.js#mergeCloudPrefs。

import { DEFAULT_PREFS } from "./pref_storage";
import { sanitizeForCloud, LOCAL_ONLY_PREF_KEYS } from "./pref_sync_logic";

export const BACKUP_SCHEMA_VERSION = 1;
const BACKUP_APP = "pttchrome";
const BACKUP_KIND = "prefs";

// 匯出檔的排除名單**刻意與雲端同步共用**（sanitizeForCloud）：帳號／密碼／2FA
// 金鑰／上班模式都不得離開這台機器。匯出檔是純文字 JSON，比雲端 doc 更容易被丟
// 上網路硬碟或聊天室，理由只會更強；另建一份名單則遲早會與雲端那份漂移。
export const buildExportPayload = (values, now = new Date()) => ({
  app: BACKUP_APP,
  kind: BACKUP_KIND,
  schemaVersion: BACKUP_SCHEMA_VERSION,
  exportedAt: now.toISOString(),
  prefs: sanitizeForCloud(values || {})
});

const isPlainObject = v => !!v && typeof v === "object" && !Array.isArray(v);

// 型別必須與 DEFAULT_PREFS 的同名值一致才收：手改壞的檔案（fontSize: "big"）套下去
// 會讓渲染層算出 NaN，整個終端機空白。
const sameShape = (value, fallback) => {
  if (Array.isArray(fallback)) return Array.isArray(value);
  if (isPlainObject(fallback)) return isPlainObject(value);
  return typeof value === typeof fallback;
};

const pickKnownPrefs = raw => {
  const out = {};
  for (const key of Object.keys(DEFAULT_PREFS)) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    // 手改檔案硬塞憑證進來也不吃：本機的帳密只有本機說了算。
    if (LOCAL_ONLY_PREF_KEYS.includes(key)) continue;
    if (!sameShape(raw[key], DEFAULT_PREFS[key])) continue;
    out[key] = raw[key];
  }
  // termSize 是唯一的巢狀 pref，半套的尺寸（只有 cols）會讓終端機算錯版面，
  // 缺一不可就整個丟掉退回預設。
  if (
    out.termSize &&
    !(
      typeof out.termSize.cols === "number" &&
      typeof out.termSize.rows === "number"
    )
  ) {
    delete out.termSize;
  }
  return out;
};

// 回傳 { ok: true, prefs } 或 { ok: false, reason }，reason 是 i18n key 後綴
// （options_backupError + Capitalized，比照 options_aiStatus_ 的拼接慣例）。
export const parseImportPayload = text => {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: "badJson" };
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: "badFormat" };
  // 兩種信封都吃：本工具匯出的 { prefs }，以及 localStorage 的原始格式
  // { values }（使用者可能直接從 DevTools 撈 pttchrome.pref.v1 出來）。
  const raw = isPlainObject(parsed.prefs)
    ? parsed.prefs
    : isPlainObject(parsed.values)
      ? parsed.values
      : null;
  if (!raw) return { ok: false, reason: "badFormat" };
  const prefs = pickKnownPrefs(raw);
  // 一個認得的 key 都沒有 ⇒ 不是這個 app 的備份檔（或整份都壞掉）。
  if (!Object.keys(prefs).length) return { ok: false, reason: "badFormat" };
  return { ok: true, prefs };
};

// 「還原成這份備份的狀態」：備份檔沒提到的 key 回**預設值**，不是保留本機現值。
// 刻意不重用 mergeCloudPrefs——那支在 defaults 與 cloud 之間還夾了一層
// localValues（雲端只覆蓋它有的 key，其餘維持本機），語意是「套用雲端的差異」，
// 用在這裡會讓匯入結果取決於匯入前的狀態，同一個檔案在兩台機器還原出不同結果。
// localValues 只拿來還原 local-only 的那幾個 key（帳密／2FA 金鑰／上班模式）。
export const mergeImportedPrefs = (defaults, localValues, imported) => {
  const merged = { ...defaults, ...imported };
  for (const key of LOCAL_ONLY_PREF_KEYS) {
    const local = localValues && localValues[key];
    merged[key] = local !== undefined ? local : defaults[key];
  }
  return merged;
};

const pad2 = n => String(n).padStart(2, "0");

export const backupFileName = (now = new Date()) =>
  "pttchrome-prefs-" +
  now.getFullYear() +
  pad2(now.getMonth() + 1) +
  pad2(now.getDate()) +
  "-" +
  pad2(now.getHours()) +
  pad2(now.getMinutes()) +
  pad2(now.getSeconds()) +
  ".json";
