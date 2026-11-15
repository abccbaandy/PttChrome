// @ts-check
// 手機選單上方的動態看板收成一列（P87，pref mobileMenuBannerCollapse → enhance.menuBanner）。
//
// 選單（主功能表與子選單）的 row 1～MENU_BANNER_LAST_ROW 是 menu.c#adbanner 畫的動態看板／
// 心情點播（別人寫的 ANSI 圖，FILMROW 11 列）。手機大按鈕模式下它照舊是縮小的 80 欄格線，
// 佔掉將近半個螢幕，選單只看得到 4 顆。
//
// 收起時（預設）：那一區**每一列只看自己**（dirty-row patch 的列獨立前提不破）：
//   - 空白列照舊收起（menuBlankRow）；
//   - 有字的列畫成一條「動態看板　<這一列的字>　展開 ▾」，CSS 用兄弟選擇器只留第一條
//     （`.menuBannerSummary ~ .menuBannerSummary { display: none }`）⇒ 摘要＝這一區第一列有字的。
// 動態看板整塊空白（使用者在 PTT 關掉了）⇒ 每列都是空白列 ⇒ 什麼都不畫。
// 展開時：那一區照舊縮小格線，標題列（row 0，平常收起）改畫一條「收起 ▴」。
// 切換只存本機（localStorage），不同步、不送鍵；功能開關是 pref。

import { MENU_BANNER_LAST_ROW } from './menu_items';

export const MENU_BANNER_EXPANDED_KEY = 'pttchrome.menuBannerExpanded';

/** @param {number} row */
export function isMenuBannerRow(row) {
  return row >= 1 && row <= MENU_BANNER_LAST_ROW;
}

// 主功能表開了心情點播時，menu.c#menu_header（EXP_ALERT_ADBANNER_USONG）在 menu_row（12）畫一條
// 「──── 上方為使用者心情點播留言區，不代表本站立場 ────」，選單項往下推一列（decide_menu_row）。
// 它是動態看板的附註：收起時跟著收。只認那一列的位置＋原字串。
export const USONG_ALERT_ROW = MENU_BANNER_LAST_ROW + 1;
const USONG_ALERT_TEXT = '上方為使用者心情點播留言區';

/**
 * @param {number} row
 * @param {string} text 該列文字
 */
export function isUsongAlertRow(row, text) {
  return row === USONG_ALERT_ROW && String(text || '').includes(USONG_ALERT_TEXT);
}

// ANSI 圖的框線、色塊、幾何符號（U+2500–25FF）與全形底線：畫圖用的，不是要讀的字。
const ART_CHARS = /[─-◿￣]/g;
const READABLE = /[\p{L}\p{N}]/u;

/**
 * 摘要文字：拿掉畫圖用的符號、連續空白壓成一格、去頭尾。整列沒有任何文字或數字
 * （純框線、色塊）回空字串 ⇒ 這一列不當摘要（收起時當空白列收掉）。
 * @param {string} text
 */
export function bannerSummaryText(text) {
  const s = String(text || '').replace(ART_CHARS, ' ').replace(/[\s　]+/g, ' ').trim();
  return READABLE.test(s) ? s : '';
}

/** @returns {Storage | null} */
function defaultStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch (_e) {
    return null;
  }
}

/** @param {Storage | null} [storage] */
export function readMenuBannerExpanded(storage = defaultStorage()) {
  try {
    return !!storage && storage.getItem(MENU_BANNER_EXPANDED_KEY) === '1';
  } catch (_e) {
    return false;
  }
}

/**
 * @param {boolean} on
 * @param {Storage | null} [storage]
 */
export function writeMenuBannerExpanded(on, storage = defaultStorage()) {
  try {
    if (!storage) return;
    if (on) storage.setItem(MENU_BANNER_EXPANDED_KEY, '1');
    else storage.removeItem(MENU_BANNER_EXPANDED_KEY);
  } catch (_e) {
    // 存不了（隱私模式、容量滿）就只在這一頁有效。
  }
}

/**
 * 這一幀 enhance.menuBanner 的值：不是一般選單（信件列表也走 menuCards）或開關關掉 ⇒ undefined。
 * @param {{ menuCards: unknown, prefOn: boolean, expanded: boolean }} o
 * @returns {'collapsed' | 'expanded' | undefined}
 */
export function menuBannerMode(o) {
  if (o.menuCards !== true || !o.prefOn) return undefined;
  return o.expanded ? 'expanded' : 'collapsed';
}
