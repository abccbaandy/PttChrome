// PTT 的「使用限制」整頁提示（upstream 368f91f5，mbbsd/contentcheck.c#activity_alert）：站方的
// activity.svc 判定 #AID 跳文、標題／作者搜尋太頻繁（爬蟲、輪詢）而拒絕時，帶著「為什麼、到何時」
// 的理由畫一整頁：
//   row 0     vs_hdr2(" 使用限制 ", " 未搜尋 ")（轉寄被拒是 " 未寄出 "）
//   row 2..   理由（服務給的，每列前面兩格空白、ANSI 1;31）
//             etc/activity_alert 的站方說明（可選）
//   b_lines   pressanykey()＝vmsg(NULL) 的「▄▄ 請按任意鍵繼續 ▄▄」
// 按任意鍵後 scr_restore、return FULLUPDATE ⇒ 回到原本的列表，游標不動。舊版服務不給理由時
// read.c 仍假裝「找不到」，那種分不出來。
//
// 這一頁之前，我們送 #AID 後等不到落地就送 \f 探路 ⇒ \f 被 pressanykey 吃掉、提示消失，
// 再把結果報成「找不到文章（可能已被刪除）」——使用者看不到真正的原因，還會再試、把限制拉長。
// 認出來就**停手、不送任何鍵**，把理由交給使用者，畫面留給 PTT。
//
// 兩要素：標題列（「使用限制」＋「未…」）＋底列 pressanykey；理由本文是私有服務給的，不認字樣。
// 同型的「內容檢查 未送出」在 push_screen.parseContentDenied。
const ACTIVITY_HDR_RE = /^\s*使用限制\s+未\S{1,4}\s*$/;
const PAUSE_TEXT = '請按任意鍵繼續';

export function parseActivityDenied(rowTexts, rows) {
  const n = rows == null ? (rowTexts ? rowTexts.length : 0) : rows;
  if (!rowTexts || n < 3) return null;
  if (!ACTIVITY_HDR_RE.test(String(rowTexts[0] || ''))) return null;
  const last = String(rowTexts[n - 1] || '');
  if (last.indexOf(PAUSE_TEXT) < 0) return null;
  const reason = [];
  for (let y = 2; y < n - 1; ++y) {
    const t = String(rowTexts[y] || '').trim();
    if (!t) break;
    reason.push(t);
  }
  return reason.join(' ');
}

// 給使用者的提示：PTT 自己的理由在畫面上，這裡只說「被限制了、別再試」。
export function activityDeniedHint(reason) {
  return (
    'PTT 暫時限制搜尋' +
    (reason ? '：' + reason : '') +
    '（說明在畫面上，按任意鍵回列表，稍後再試）'
  );
}
