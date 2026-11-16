// @ts-check
// 使用者資料的共用讀寫（架構 review A10 第二步，docs/user-data.md「共用讀寫」）。
//
// 以前每個功能各寫一份「拿 storage → try/catch → getItem === '1'」：同一段防錯抄了五遍，
// 隱私視窗、被封鎖網站資料、容量滿時的行為只能逐檔對照。這裡收成一處，鍵名一律用
// user_data_keys.js 的 id（不吃字串鍵名，總表以外的資料進不來）。
//
// 契約：讀不到（沒有 storage、存取丟例外）⇒ 回預設值；寫不進去 ⇒ 安靜放棄，只在這一頁有效。
// 附屬功能的記憶不可以炸掉呼叫端。
//
// 旗標（'1'／不存在）用 readFlag／writeFlag；JSON 類（紀錄、快取）用 readJson／writeJson／removeData，
// 擁有者一個一個搬（docs/user-data.md 寫了搬到哪）。

import { STORAGE_KEYS } from './user_data_keys';

/** @typedef {keyof typeof STORAGE_KEYS} StorageKeyId */

/**
 * 這個環境的 localStorage；拿不到（隱私模式的部分瀏覽器、被封鎖網站資料、node）回 null。
 * @returns {Storage | null}
 */
export function defaultStorage() {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch (_e) {
    return null;
  }
}

/** @param {StorageKeyId} id */
function keyOf(id) {
  const key = STORAGE_KEYS[id];
  if (!key) throw new Error('user_data: 總表沒有這個鍵 ' + id);
  return key;
}

/**
 * 旗標：存成 '1'，關掉就整個移除（不存 '0'，舊資料也是這個形狀）。
 * @param {StorageKeyId} id
 * @param {Storage | null} [storage] 測試注入；明確給 null ＝ 沒有 storage
 * @returns {boolean}
 */
export function readFlag(id, storage = defaultStorage()) {
  const key = keyOf(id);
  try {
    return !!storage && storage.getItem(key) === '1';
  } catch (_e) {
    return false;
  }
}

/**
 * @param {StorageKeyId} id
 * @param {boolean} on
 * @param {Storage | null} [storage]
 */
export function writeFlag(id, on, storage = defaultStorage()) {
  const key = keyOf(id);
  try {
    if (!storage) return;
    if (on) storage.setItem(key, '1');
    else storage.removeItem(key);
  } catch (_e) {
    // 存不了（隱私模式、容量滿）就只在這一頁有效。
  }
}

/**
 * JSON 資料：沒有這筆、JSON 壞掉、拿不到 storage 都回 null。**形狀檢查留給擁有者**
 * （每種資料的合法形狀不同，手改壞的、舊版留下的都要在那裡濾掉）。
 * @param {StorageKeyId} id
 * @param {Storage | null} [storage]
 * @returns {unknown}
 */
export function readJson(id, storage = defaultStorage()) {
  const key = keyOf(id);
  try {
    if (!storage) return null;
    const raw = storage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

/**
 * 原文字串（沒有、拿不到都回 null）。給要拿原文當快取鍵的擁有者：每一幀都要問、原文沒變就
 * 沿用上次解析的結果（新推文標記的列表徽章；別的分頁寫的也認得出來）。其餘一律用 readJson。
 * @param {StorageKeyId} id
 * @param {Storage | null} [storage]
 * @returns {string | null}
 */
export function readRaw(id, storage = defaultStorage()) {
  const key = keyOf(id);
  try {
    return storage ? storage.getItem(key) : null;
  } catch (_e) {
    return null;
  }
}

/**
 * 寫入 JSON；回傳有沒有真的寫進去（容量滿、隱私模式 ⇒ false，呼叫端照舊只在這一頁有效）。
 * @param {StorageKeyId} id
 * @param {unknown} value
 * @param {Storage | null} [storage]
 * @returns {boolean}
 */
export function writeJson(id, value, storage = defaultStorage()) {
  const key = keyOf(id);
  try {
    if (!storage) return false;
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * 整筆移除（任何形狀的資料都適用）。
 * @param {StorageKeyId} id
 * @param {Storage | null} [storage]
 */
export function removeData(id, storage = defaultStorage()) {
  const key = keyOf(id);
  try {
    if (storage) storage.removeItem(key);
  } catch (_e) {
    // 拿不到就算了：下次讀照樣回預設。
  }
}
