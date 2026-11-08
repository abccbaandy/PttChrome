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
// 這一頁之前，我們送 #AID 後等不到落地就送 \f 探路，探回來還是這一頁就判 miss，把結果報成
// 「找不到文章（可能已被刪除）」——使用者看不到真正的原因，還會再試、把限制拉長。
// （\f 本身不算按鍵：io.c#system_key_hook 對 Ctrl('L') 重畫後回 KEY_INCOMPLETE，pressanykey 照等，
// 見 screen_dismiss.js 的 A／B。真正會把它按掉的是送真按鍵的流程。）
// 認出來就**停手、不送任何鍵**，把理由交給使用者，畫面留給 PTT。
//
// 兩要素：標題列（「使用限制」＋「未…」）＋底列 pressanykey；理由本文是私有服務給的，不認字樣。
// 同型的「內容檢查 未送出」在 push_screen.parseContentDenied。
//
// 限速通知（upstream f369626a，contentcheck.c#activity_slow_alert）：服務說帳號「限速中」時，
// 開文（bbs.c#read_post）、進板（board.c#enter_board）、#AID、標題／作者搜尋在**延遲之前**先畫同一張
// alert_screen，狀態欄是 " 限速中 "；按任意鍵後照常繼續（開文、進板、跳到那篇），之後每一步都會被延遲。
// 同一次限速只通知一次。這張是站方要**使用者本人看到**的通知（commit 說明：讓用終端機的人看清楚）
// ⇒ 替使用者代按真按鍵的流程（跳過進板畫面送空白、AID 跳文收進板畫面送 ←）都不准把它按掉；
// 只會等逾時再探路的流程（#AID、開文、重新整理）也不要空等再報成「找不到／失敗」。認出來就停手、
// 一個鍵都不送，理由交給使用者，畫面留給 PTT。
const ACTIVITY_HDR_RE = /^\s*使用限制\s+(\S{2,6})\s*$/;
const DENIED_STATUS_RE = /^未/;
export const SLOW_STATUS = '限速中';
const PAUSE_TEXT = '請按任意鍵繼續';

// 任何一張「使用限制」整頁（被拒或限速中）：{ status, reason }；不是 ⇒ null。
export function parseActivityAlert(rowTexts, rows) {
  const n = rows == null ? (rowTexts ? rowTexts.length : 0) : rows;
  if (!rowTexts || n < 3) return null;
  const m = ACTIVITY_HDR_RE.exec(String(rowTexts[0] || ''));
  if (!m) return null;
  const last = String(rowTexts[n - 1] || '');
  if (last.indexOf(PAUSE_TEXT) < 0) return null;
  const reason = [];
  for (let y = 2; y < n - 1; ++y) {
    const t = String(rowTexts[y] || '').trim();
    if (!t) break;
    reason.push(t);
  }
  return { status: m[1], reason: reason.join(' ') };
}

// 被拒（「未搜尋」「未寄出」…）那一種：回理由字串；限速中或不是 ⇒ null。
export function parseActivityDenied(rowTexts, rows) {
  const a = parseActivityAlert(rowTexts, rows);
  return a && DENIED_STATUS_RE.test(a.status) ? a.reason : null;
}

// 給使用者的提示（任一種）。
export function activityAlertHint(alert) {
  if (alert && alert.status === SLOW_STATUS) {
    return (
      'PTT 通知帳號限速中' +
      (alert.reason ? '：' + alert.reason : '') +
      '（說明在畫面上，按任意鍵繼續；之後操作會變慢）'
    );
  }
  return activityDeniedHint(alert ? alert.reason : '');
}

// openPromptText 把整句提示當成「問題」傳出去，openPromptHint 認得就原樣轉出。
export function isActivityAlertHint(text) {
  return /^PTT (通知帳號限速中|暫時限制搜尋)/.test(String(text || ''));
}

// 失敗訊息的短標題。
export function activityAlertTitle(alert) {
  return alert && alert.status === SLOW_STATUS ? 'PTT 通知帳號限速中' : 'PTT 暫時限制搜尋';
}

// 給使用者的提示：PTT 自己的理由在畫面上，這裡只說「被限制了、別再試」。
export function activityDeniedHint(reason) {
  return (
    'PTT 暫時限制搜尋' +
    (reason ? '：' + reason : '') +
    '（說明在畫面上，按任意鍵回列表，稍後再試）'
  );
}
