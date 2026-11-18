// @ts-check
// P109 文章裡的 YouTube／Twitch clip 先放縮圖，點了才載播放器（純狀態，無 DOM／網路）。
//
// 一個 YouTube 播放器開起來約 1.2 MB（19 個請求，大多是播放器程式；11/18 用 Chromium 無快取量），
// 縮圖 hqdefault.jpg 約 17 KB。好讀捲過一篇貼十幾支影片的文章，原本每支都整個播放器載進來。
// 開著時（pref videoThumbFirst，預設開）ImagePreviewer 的 InlineIframe 先畫縮圖＋播放鈕，
// 點了才換成真的 iframe（加 autoplay）；框大小不變。關掉＝跟以前一樣直接嵌播放器。
//
// 點過的播放器以 src 為鍵記在 module 級：好讀長頁整份重建 slot 時 React root 會重掛，
// 存在元件 state 裡的話一重建就又變回縮圖（同 image_load_gate.js 的理由）。重掛時直接畫播放器，
// 不加 autoplay（跟關掉這個功能時重掛的行為一樣）。

let enabled = true;
/** @type {Set<string>} */
const activated = new Set();

/** @param {boolean} on */
export function setVideoThumbFirst(on) {
  enabled = !!on;
}

export function videoThumbFirst() {
  return enabled;
}

/**
 * 這個播放器此刻要不要先放縮圖。
 * @param {string} src 播放器（iframe）網址
 */
export function needsVideoFacade(src) {
  return enabled && !activated.has(src);
}

/** @param {string} src */
export function activateVideo(src) {
  activated.add(src);
}

/**
 * YouTube 影片 id 的縮圖網址（固定路徑，不用呼叫 API；每支影片都有 hqdefault）。
 * @param {string} id
 */
export function youtubePoster(id) {
  return `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
}

/**
 * 點了之後的播放器網址：加上自動播放（YouTube autoplay=1、Twitch clip autoplay=true）。
 * 手機 WebView 若擋自動播放，就是多點一次播放器自己的播放鈕。
 * @param {string} src
 */
export function autoplaySrc(src) {
  let u;
  try {
    u = new URL(src);
  } catch (e) {
    return src;
  }
  if (/(^|\.)twitch\.tv$/i.test(u.hostname)) u.searchParams.set("autoplay", "true");
  else u.searchParams.set("autoplay", "1");
  return u.href;
}

/** 測試用：清掉點過的紀錄、回到預設開。 */
export function _resetVideoFacadeForTest() {
  activated.clear();
  enabled = true;
}
