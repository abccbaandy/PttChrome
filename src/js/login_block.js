// PTT 站方的登入封鎖畫面（「[PTT DDoS/BOT 偵測系統] … 已被暫時禁止登入／暫停連線」）。
//
// 不在 pttbbs 開源碼裡（PTT 私有的防濫用層，docs/pttbbs-screen-protocol.md「PTT 私有的」），
// 但畫面自己寫明了規則：無法申請解除；「停止使用機器人或行為不正常的 App（部份 App 需要關閉
// 自動登入）、無任何登入行為之後最多 12 小時後會恢復」；「暫停期間若持續嘗試登入…將無限期延長」。
// ⇒ 看到它之後，本頁的自動登入一律停手（AutoLogin.suspend），斷線提示講清楚，再不再登入
// 交給使用者自己決定。

// 畫面文字（多列 join 起來或逐列都可以）是不是這個封鎖畫面。兩個字樣都只出現在封鎖畫面上。
export function isLoginBlockText(text) {
  const s = String(text || '');
  return s.indexOf('DDoS/BOT 偵測系統') >= 0 || s.indexOf('已被暫時禁止登入') >= 0;
}

// 目前畫面（TermBuf）是不是封鎖畫面。
export function isLoginBlockScreen(buf) {
  if (!buf || typeof buf.getRowText !== 'function') return false;
  const rows = buf.rows || 24;
  for (let y = 0; y < rows; ++y) {
    if (isLoginBlockText(buf.getRowText(y, 0, buf.cols || 80))) return true;
  }
  return false;
}
