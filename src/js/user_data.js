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
// 目前只有旗標（'1'／不存在）。JSON 類（紀錄、快取）之後一類一類搬，搬的時候在這裡加 readJson／writeJson。

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
