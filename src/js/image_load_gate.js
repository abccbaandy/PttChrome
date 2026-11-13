// 行動網路省流量：好讀自動開圖改成「點了才開」的閘門（純狀態，無 DOM／網路）。
//
// 閘門成立＝三者皆真：
//   networkMetered  Android APK 原生回報目前的預設網路是行動數據／計費網路
//                   （android_bridge.js 'networkState'／'pttandroid:network'；APK 以外恆 false）
//   enabled         pref tapToLoadImagesOnMobileData（預設開）
//   !unlockAll      這篇文章還沒長按過「全部開圖」
// 成立時，佔位盒（render/inline_preview_slot.js）對**可預覽的連結**不掛載預覽、改放一顆
// 「開圖」按鈕：點一下＝只開這張（unlockImage），長按＝本篇全部照常自動開（unlockAllImages）。
//
// 解鎖以 href 為鍵、住在 module 級：好讀長頁任何改動 annotationsKey 的操作都會整份重建 slot
// （同 inline_preview_slot.js 的 grayHrefs 理由），存在 slot 閉包裡的話一重建按鈕就又冒回來。
// 生命週期比照 grayHrefs：同篇 page-down 保留、換文章由 ScreenController 清（resetImageUnlocks）。
// 已經載過的圖（Wi-Fi 時開的、或點開過的）由 slot 掛載時 rememberLoaded 記下 ⇒ 切到行動網路後
// 往回捲、或整份重建，都不會把已經看過的圖收回成按鈕。

let networkMetered = false;
let enabled = true;
let unlockAll = false;
const unlocked = new Set();
const listeners = new Set();

function notify() {
  for (const fn of Array.from(listeners)) {
    try {
      fn();
    } catch (e) {
      // 一個 slot 出錯不影響其他 slot（同 feature-isolation 的精神）。
      setTimeout(() => {
        throw e;
      });
    }
  }
}

// 閘門目前是否作用（不看個別 href）。
export function imageLoadGateActive() {
  return networkMetered && enabled && !unlockAll;
}

// 這個連結此刻是否要「點了才開」。previewable＝有對應的預覽 resolver（一般網頁連結本來就
// 不會開出東西，不給它按鈕）。
export function needsTapToLoad(href, previewable) {
  return !!previewable && imageLoadGateActive() && !unlocked.has(href);
}

// 掛載過的預覽默默記下（不通知：每張圖掛載都通知會讓所有 slot 跟著重跑）。
export function rememberLoaded(href) {
  unlocked.add(href);
}

// 使用者點了某一張的「開圖」。
export function unlockImage(href) {
  if (unlocked.has(href)) return;
  unlocked.add(href);
  notify();
}

// 使用者長按「開圖」：本篇其餘的圖恢復成一般的延遲自動開（進視野才載）。
export function unlockAllImages() {
  if (unlockAll) return;
  unlockAll = true;
  notify();
}

// 換文章（render/screen.js 的 articleId 變動處）。
export function resetImageUnlocks() {
  const wasOpen = unlockAll || unlocked.size > 0;
  unlockAll = false;
  unlocked.clear();
  if (wasOpen) notify();
}

export function setNetworkMetered(value) {
  const v = !!value;
  if (v === networkMetered) return;
  networkMetered = v;
  notify();
}

export function isNetworkMetered() {
  return networkMetered;
}

export function setTapToLoadEnabled(value) {
  const v = !!value;
  if (v === enabled) return;
  enabled = v;
  notify();
}

// 閘門狀態可能改變時呼叫 fn（網路切換、解鎖、換文章、pref）。回傳取消訂閱。
export function onImageLoadGateChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// 測試用：page-lifetime 狀態歸零（browser 模式 vi.resetModules 無效）。
export function _resetImageLoadGateForTest() {
  networkMetered = false;
  enabled = true;
  unlockAll = false;
  unlocked.clear();
  listeners.clear();
}
