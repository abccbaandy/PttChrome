// Click-to-navigate for PTT article-code (AID) links in easy reading.
//
// Clicking a "#1gIeu-3A" link (detected by aid_parse.js, rendered by
// Row/LinkSegmentBuilder) drives the native key sequence a user would type:
//   s <board> ⏎   (board jump — works from INSIDE the article too, so no
//                  leave-article step is needed; always taken, even for the
//                  same board: one code path, and the s-search is forgiving)
//   # <aid> ⏎     (AID search — cursor lands on the target row)
//   ⏎             (open the article)
//
// …but ONLY when the pager is in currstat == READING. mbbsd/more.c:102-112 gates
// both s (RET_SELECTBRD) and # (RET_SELECTAID) on it, so inside a 站內信
// (currstat == RMAIL) they are DONOTHING and "s<board>\r" gets eaten KEY BY KEY
// as pager hotkeys instead (Y=回信給所有人, X/%=推文, T=改標題, E=編輯…) — a
// misfire, not just a no-op (回報實錄 ptt-debug-20260813: 畫面直接跳到另一封信).
// So the sequence is preceded by an ESCAPE preamble whenever the footer does not
// prove READING (parsePagerFooterContext, single-directional — see string_util):
//   ← × n         (back out one level per press until 【主功能表】)
// 主功能表 is the only safe place to resume from: mbbsd/menu.c:498 routes s in
// MMENU/TMENU/XMENU to ReadSelect() → do_select() → a real board entry, whereas
// mbbsd/board.c:1902's s (看板列表/我的最愛/分類看板) is a SEARCH that only moves
// the cursor. The price is that ReadSelect() calls Read(), which shows the board's
// 進板畫面 + pressanykey on this session's first entry (mbbsd/bbs.c:4482-4492) —
// the in-article path never does (more.c:177 calls Select() alone) — so the
// via-menu board jump also dismisses those. See _enqueueBoardJump.
// Each step is a serialized CommandQueue command completed by CONTENT (an
// expect over the settle facts), exactly like list_session's transactions.
// While the sequence runs, user input is blocked (`active` is checked at the
// term_view/pttchrome input entry points) and the REAL native screen is
// mirrored live: the article easy reading enters functionMode, and an engaged
// list session is parked in its own functionMode via beginExternalNavigation()
// so its reducer stays out of the way (clean-list settles stay; the final
// article settle takes the normal handoff).
//
// Failures are visible, never silently retried (v5 convention): any step's
// onFail unlocks input, flashes a banner and leaves the native screen as-is —
// the easy-reading/list state machines self-converge from whatever shows.

// Going BACK (the same machinery in reverse)
// ------------------------------------------
// PTT keeps no jump origin, so "back" is a SECOND navigation replayed from an
// anchor captured before we left — exactly BePTT's design (a stack of key
// sequences, replayed on the back press), except every step is verified by
// content here instead of being sent blind. The stack lives in nav_history.js;
// the only difference between a forward jump and a back run is the middle step
// (_enqueueMiddle): #<aid>, or nothing at all (stop on the list).
//
// Where the user is (article reading position, the list behind the article) comes
// from the reading record (reading_record.js, docs/reading-record.md): it is
// frozen the moment the mirrors go up, so the capture order no longer matters for
// the scroll position. The ARTICLE anchor (chooseAnchor) still reads live
// list/article state and must run before _begin().
//
// Only an AID ever opens an article on the way back — never an article number
// (shifts on deletion, separate space inside a `/` search list). Opening the
// WRONG article is far worse than stopping on the list. So every forward jump
// that has a board tries to learn the AID (free URL line, else Q) — see _begin.

import { parseStatusRow, parsePagerFooterContext } from './string_util';
import { NavHistory, chooseAnchor } from './nav_history';
import {
  parsePostInfoAid,
  parseArticleUrlLine,
  parsePostInfoUrl,
  isCrossPostHeaderLine
} from './aid_parse';
import { isPinnedListRow } from './comment_parse';
import { parseListEntry } from './agent_parse';
import { MAIN_MENU, boardNameFromKey, parseBoardKey, rowHasTitle } from './screen_titles';
import { isSubListFooter } from './screen_captions';
import { HINT_ERROR } from './status_hint';
import { recordFor } from './reading_record';

// AID search rejected: pttbbs answers with a press-any-key message instead of
// a clean list. Belt-and-braces text guard for the (unlikely) case the message
// still classifies as clean-list. Exported because long_push_session runs the
// same `#<aid>⏎` transaction to pin its cursor — one regex, one place.
//
// The two literals are read.c:468-472: 「找不到這個文章代碼(AID)，可能是文章已
// 消失，或是你找錯看板了」(n < 0) and 「不合法的文章代碼(AID)，請確定輸入是正確
// 的」(aidu <= 0). 「不正確」 never actually appeared in either — it is kept only
// so the guard never gets NARROWER than it used to be.
export const AID_NOT_FOUND_RE = /找不到|不合法|不正確/;

// ← as the terminal sees it. Backs out exactly one level everywhere the escape
// preamble can run (pmore, i_read list, domenu) and is a no-side-effect dismiss
// on a pressanykey screen.
const KEY_LEFT = '\x1b[D';

// row 0 是不是主功能表。term_buf.setPageState / classifyListScreen 走的是
// screen_titles 的同一組判定；deep_link_controller 拿這個當它**唯一的**
// 「使用者已登入」訊號。
//
// 2026-09-20 公告動了單段式／兩段式標題的括號（三段式明文保證不變，Row 0 左側
// 仍是「【主功能表】」），所以 rowHasTitle 兩種形狀都吃 —— 理由與邊界見
// screen_titles.js 的檔頭。**不要**在這裡另外宣告一份 `'【主功能表】'` 字面值，
// 那正是這次要收掉的東西。
export function isMainMenuRow(rowText) {
  return rowHasTitle(rowText, MAIN_MENU);
}

// The board's 進板畫面 tail: mbbsd/bbs.c#Read → pressanykey(). Same literals
// term_buf.setPageState matches for pageState 5.
const PRESS_ANY_KEY_RE = /請按任意鍵繼續|請按 空白鍵 繼續/;

// Escape presses allowed before giving up. 站內信 needs 3 (信件內容 → 信件列表 →
// 郵件選單 → 主功能表); the slack covers deeper nests. A cap is mandatory: with an
// over-quota mailbox mbbsd/menu.c:493 turns ← in the MAIL menu into 'R' (forced
// back into reading mail), so the screen keeps changing but never reaches MMENU.
const MAX_ESCAPE_STEPS = 6;

// Did `#<aid>\r` land? Shared by aid_navigation and long_push_session: both send
// the very same transaction, and a predicate that forks once ends up fixed on only
// one side (2026-09 的置底文 bug 兩邊同時壞，就是因為判準被抄了一份).
//
// Success = select_by_aid parked the cursor on a row in the entry area with the
// board title still up (mbbsd/read.c:478 `*pnew_ln = n + 1` → cursor_pos).
//
// Deliberately NOT gated on kind === 'clean-list': the AID-jump landing leaves the
// bottom footer row BLANK (the # prompt cleared it and the jump repaint doesn't
// redraw it — live-verified 2026-07-10, even after a \f probe; protocol §6 M1), so
// the classifier reads 'transient' on a perfectly good landing.
//
// 置底（★）列也算落地：select_by_aid searches `.DIR.bottom` BEFORE `.DIR`
// (read.c:403-424) ⇒ a pinned post IS found and the cursor parks on its row — but
// PTT prints ★ where the number would go (bbs.c:843 `outs("  " ANSI "  ★ ")` vs
// `prints("%7d", num)`) ⇒ facts.cursorRowNum is null there by construction. The old
// predicate hard-rejected that, read a correct landing as a miss and never sent the
// opening ⏎ (使用者回報：置底文的 deep link 卡在列表上進不了文章). PTT itself has no
// trouble with that ⏎: read.c:999-1008 turns a cursor past bottom_line into an index
// into `.DIR.bottom`. isPinnedListRow's contract — only ask it about rows whose
// recovered number is null — is honoured because cursorRowNum is tested first.
//
// 「找不到」 is rejected by the entry-area bound, NOT by the missing number:
// read.c:466-476 does `move(21,0); clrtobot(); move(22,0); prints(…); pressanykey()`,
// so the message sits on row rows-2 and the pressanykey bar on rows-1
// (vtuikit.c#vshowmsg's `move(b_lines, 0)`), leaving the cursor on rows-1.
// The last-row text guards are belt-and-braces. AID_NOT_FOUND_RE must NOT be scanned
// any higher: on a real landing row rows-2 is an ordinary article row, and a title
// containing 「找不到」 would become a false reject.
// `s<board>⏎` 落地＝目標板的乾淨文章列表。facts.boardName 是看板身分鍵
// （screen_titles.parseBoardKey）：「看板《X》」被 server 省略（看板描述太長）時沒有
// 板名可比，只能接受。不會因此誤判落地：這一步只從文章內（pmore 的 s）或主功能表送，
// 板名打錯時畫面留在原處，不會是 clean-list；下一步的 AID 搜尋也只在找得到時才落地。
export function landedOnBoard(facts, boardLower) {
  if (!facts || facts.kind !== 'clean-list' || facts.boardName == null) return false;
  const name = boardNameFromKey(facts.boardName);
  return name == null || name.toLowerCase() === boardLower;
}

// 標題列右段 title_tail_msgs（menu.c#showtitle）：MODE_SELECT＝系列、MODE_DIGEST＝文摘。
// 右段可能被省略（看板描述太長）⇒ 只能證明「是」，不能證明「不是」。
export function isSubListTitle(row0Text) {
  return /(系列|文摘)《[^》]*》\s*$/.test(row0Text || '');
}

// 文章內 `s<板>⏎` 的落地，含搜尋結果／文摘（底列 系列文章／文摘列表）：新版 read.c 的
// 搜尋條件住在 read_ctx，從搜尋結果裡換板**仍在搜尋模式**（同條件篩新板）⇒ 可能一篇
// 都沒有（read_empty_renderer「沒有文章...」，不是 clean-list），所以子列表只比標題列
// 的板名（要明確寫出才認，不吃省略的身分鍵）。回 false | { sub }：sub ＝在子列表上
// （# 被拒，要先 ← 離開，見 _enqueueLeaveSubList）。
export function landedOnBoardList(facts, boardLower) {
  if (!facts) return false;
  const rowTexts = facts.rowTexts || [];
  const rows = facts.rows || rowTexts.length;
  const sub = isSubListFooter(rowTexts[rows - 1] || '');
  if (landedOnBoard(facts, boardLower)) return { sub: sub };
  if (!sub) return false;
  const name = boardNameFromKey(parseBoardKey(rowTexts[0] || ''));
  return name != null && name.toLowerCase() === boardLower ? { sub: true } : false;
}

export function aidSearchLanded(facts) {
  if (!facts || facts.boardName == null) return false;
  if (facts.curY < 3 || facts.curY > facts.rows - 2) return false;
  const rowTexts = facts.rowTexts || [];
  const lastRow = rowTexts[facts.rows - 1] || '';
  if (AID_NOT_FOUND_RE.test(lastRow) || PRESS_ANY_KEY_RE.test(lastRow)) return false;
  if (facts.cursorRowNum != null) return true;
  return isPinnedListRow(rowTexts[facts.curY] || '');
}

// `<編號>⏎` 落地：與 list_session open-jump 同一個停靠指紋（舊 server 跳號後底列留空
// ⇒ 不要求 clean-list，見 protocol §4 ✚）。
export function numJumpLanded(facts, num) {
  if (!facts || facts.boardName == null) return false;
  return (
    facts.cursorRowNum === num &&
    facts.curY >= 3 &&
    facts.curY <= facts.rows - 2 &&
    facts.curX <= 1
  );
}

// End 落地：游標停在條目區的**最後一個非空列**（read.c 的 End ＝ last_line，置底文
// 排在一般文章之後，所以停在最後一篇置底或最後一篇文章）。這張畫面之後才有
// 「最新文章」可讀。
// 板尾畫面上置底文所在的螢幕列（由上而下）。判準與 agent_parse.parseListEntry 的
// pinned 同一支 ⇒ agent 列表回傳的 pinned[index] 與這裡的第 index 列是同一篇。
export function pinnedRowsOnScreen(facts) {
  const out = [];
  if (!facts) return out;
  const rowTexts = facts.rowTexts || [];
  for (let r = 3; r <= facts.rows - 2; ++r) {
    const e = parseListEntry(rowTexts[r] || '');
    if (e && e.pinned) out.push(r);
  }
  return out;
}

export function endLanded(facts) {
  if (!facts || facts.boardName == null) return false;
  const rows = facts.rows;
  if (facts.curY < 3 || facts.curY > rows - 2 || facts.curX > 1) return false;
  const rowTexts = facts.rowTexts || [];
  const lastRow = rowTexts[rows - 1] || '';
  if (AID_NOT_FOUND_RE.test(lastRow) || PRESS_ANY_KEY_RE.test(lastRow)) return false;
  if (!(rowTexts[facts.curY] || '').trim()) return false;
  for (let r = facts.curY + 1; r <= rows - 2; ++r) {
    if ((rowTexts[r] || '').trim()) return false;
  }
  return true;
}

// 進板畫面 pager + its pressanykey = 2 keys; the slack absorbs a multi-page one.
const MAX_ENTER_DISMISS = 3;

// ---- 每一步的等待預算 ----
// A soft timeout is NOT a failure: it sends the queue's zero-side-effect \f probe
// to ask "where am I" and lets expect judge the guaranteed full frame
// (command_queue._timedOut). And EVERY settle re-arms the soft timer
// (command_queue.onSettle) ⇒ shortening it only makes the VERDICT faster, it
// never kills a correct landing that is still streaming in. PTT answers in
// ~90ms and term_buf needs another SETTLE_MS (50ms) on top, so anything past a
// few hundred ms of total silence is already abnormal. Same fast-fail philosophy
// list_session already runs on this very same queue (CMD_PROBE_AFTER_MS 250 /
// CMD_PROBE_WINDOW_MS 600 / CMD_HARD_MS 1200) — aid_navigation used to sit on
// 4000-6000ms soft windows plus the queue's 2000/10000 defaults, so a failing
// step took ~4.3s to say anything and a whole deep link could drag past 30s
// (使用者回報「卡住的 timeout 太長」).
export const STEP_PROBE_AFTER_MS = 700; // soft: triggers the probe, never a failure
export const STEP_PROBE_WINDOW_MS = 700; // how long the probed full frame gets
const STEP_HARD_MS = 3000; // absolute cap from send (never re-armed)
// The board jump is heavier than the rest: the server opens the board's .DIR and
// may paint a whole 進板畫面 before anything comes back. One notch more slack.
export const BOARD_PROBE_AFTER_MS = 1500;
export const BOARD_HARD_MS = 5000;
// 同一組預算給其他「伺服器要做事才回得來」的一步（列表重新整理的 s<本板>⏎、
// 搜尋送出：search_predicates_window 要等搜尋服務）。凍結交易預設的 250/600/1200
// 對它們太短：伺服器靜默 850ms 就會被判逾時。
export const SLOW_STEP_BUDGET = {
  timeoutMs: BOARD_PROBE_AFTER_MS,
  probeTimeoutMs: STEP_PROBE_WINDOW_MS,
  hardTimeoutMs: BOARD_HARD_MS
};
// Progress banner lifetime. Sized to the worst-case run above (~9s) so it never
// outlives the transaction it describes; success/failure replaces it anyway.
const PROGRESS_HINT_MS = 8000;

// Dismisses the Q post-info box's pressanykey() (= vmsg(NULL), which consumes
// exactly ONE key — mbbsd/vtuikit.c:439-455).
//
// It CANNOT be \f: Ctrl-L is swallowed by mbbsd/io.c#system_key_hook (:196-203)
// which answers KEY_INCOMPLETE, and vkey() loops on that (:432-434) — the byte
// never reaches any key handler, it only forces a redraw. That is precisely why
// \f is a safe universal probe everywhere else, and precisely why it can never
// dismiss a pressanykey (live-verified 2026-08-15: the box stayed up, the
// following 's' was eaten as the dismissal and the board name was then typed
// into the pager as hotkeys — 'h' 說明 / 'a' 作者下一篇).
//
// Space is inert for us on both possible screens: page-down on the article list
// we are about to leave anyway, page-down in the pager if the box never came up.
// ← must NOT be used: leaking one to the list would leave the board.
const KEY_DISMISS = ' ';

function screenSignature(rowTexts) {
  return (rowTexts || []).join('\n');
}

// One navigation run, threaded through every step instead of the old
// (aid, board, boardLower, …) parameter chain:
//   target: where we are going — a forward jump's { board, kind:'aid', aid },
//           or a nav_history anchor when going back
//   boardLower: the case-insensitive board comparison key (landing expects)
//   dir: 'forward' (an AID link click) | 'back' (the back button / shortcut)
// Only `target.kind` decides the middle step (_enqueueMiddle); everything else
// — the escape preamble, the board jump, the 進板畫面 dismissals, the final ⏎ —
// is shared byte for byte between the two directions.
function makeRun(target, dir) {
  return {
    target: target,
    boardLower: String(target.board).toLowerCase(),
    dir: dir
  };
}

// 外部帶進來的連結（startExternal）的返回錨，取自閱讀紀錄的書籤。純函式。
//   - 文章列表（完整列表，看得出板名）⇒ 看板錨：返回＝`s<板>` 停在列表，列表好讀
//     依錨上的 list 還原視野（原生列表則由 pttbbs 的 getkeep 把游標留在原處）。
//   - 搜尋結果／文摘（獨立編號空間）、主功能表、看板列表 ⇒ 沒有可回的地方（null）。
//   - 跳往同一個板 ⇒ null：`#<aid>` 會覆寫這個板的 getkeep 游標，錨會說謊
//     （nav_history.chooseAnchor 同一條理由）。
export function externalOriginAnchor(bm, targetBoard) {
  const list = bm && bm.list;
  if (!list || list.mode !== 'plain') return null;
  const board = boardNameFromKey(list.board);
  if (!board) return null;
  if (targetBoard && String(targetBoard).toLowerCase() === board.toLowerCase()) return null;
  return {
    kind: 'board',
    board: board,
    aid: null,
    lineIndex: null,
    label: board + ' 看板',
    list: list
  };
}

export function AidNavigation(core, view, termBuf, queue, history) {
  this._core = core;
  this._view = view;
  this._termBuf = termBuf;
  this._queue = queue;
  this._history = history || new NavHistory();
  // True while the key sequence is in flight — input entry points check this
  // (term_view.onKeyDown / App.onMouse_click / wheel) and swallow everything.
  this.active = false;
  // active 期間 serialized_op_gate 給使用者的提示字；null ＝預設的「AID 跳文中」。
  this.opHint = null;
  // 目前這一輪是 refresh()（失敗訊息與收尾不同於跳文）。
  this._refreshing = false;
  // 目前這一輪是 startResume()（斷線重連後回到原處）。
  this._resuming = false;
  // One-shot: swallow the leaveCurrentPost our own landing causes (noteLeftPost).
  this._ownedLeave = false;
  // 指定看板挑板中的 token（preparePicked → continuePicked／reopenPicked／endPicked）：
  // 期間背景 `s` prompt 造成的離開文章／列表 settle 不清返回堆疊。
  this._picking = null;
  // findLocalPostAid 的增量掃描游標（見該函式）。
  this._urlScanRow = 0;
  this._urlScanLen = 0;
  this._urlScanHit = null;
  this._urlScanForwarded = false; // 掃到轉錄標頭了：之後的網址都不是本篇
  // 這一輪的結束回呼（只有 agent 工具會給，見 startBoard）。
  this._onRunEnd = null;
}

AidNavigation.prototype = {
  _hint: function(msg, ms, level) {
    if (this._view.flashListHint) this._view.flashListHint(msg, ms || 4000, level);
  },

  _fail: function(msg) {
    this.active = false;
    this.opHint = null;
    // 停在哪裡都一樣：把列表 session 的外部 hold 交回靜置探針（否則列表好讀會
    // 卡在原生鏡像直到下一次開文）。身後的列表紀錄留著，回到同一份列表時還原。
    recordFor(this._core).releaseExternal();
    if (this._refreshing) {
      // 重新整理失敗：同一套「停在原生畫面、看得到」的降級，只是措辭不同。
      this._refreshing = false;
      this._history.abort();
      this._updateBackButton();
      this._hint('重新整理失敗：' + msg + '（已停在原生畫面）', 0, HINT_ERROR);
      return;
    }
    if (this._resuming) {
      this._resuming = false;
      this._history.abort();
      this._updateBackButton();
      this._hint('回到斷線前的位置失敗：' + msg + '（已停在原生畫面）', 0, HINT_ERROR);
      this._endRun({ ok: false, error: msg });
      return;
    }
    // Where we ended up is unknown, so every anchor below is suspect: drop the
    // whole stack rather than offer a back that lands somewhere wrong.
    this._history.abort();
    this._updateBackButton();
    this._hint('AID 跳文失敗：' + msg + '（已停在原生畫面）', 0, HINT_ERROR);
    this._endRun({ ok: false, error: msg });
  },

  // The back affordance is a pure projection of (active, stack) — never
  // toggled by hand. Safe to call before term_view grows the overlay API.
  _updateBackButton: function() {
    const view = this._view;
    if (!view || !view.showBackButton || !view.hideBackButton) return;
    if (this.canGoBack()) {
      const entry = this._history.peek();
      view.showBackButton(entry ? entry.label : '', this.back.bind(this));
    } else {
      view.hideBackButton();
    }
  },

  // --- stack lifecycle notifications (pure: they must not touch the callers'
  // own state). All of them no-op while WE are driving: our own intermediate
  // screens are list/menu screens too.

  // From list_session._onScreenSettled, before queue.onSettle: the user landed
  // on a list or a menu without us — they left the article by themselves, so
  // the anchors no longer describe where they are.
  noteSettle: function(facts) {
    if (this.active || this._picking || !facts) return;
    if (facts.kind !== 'clean-list' && facts.kind !== 'menu') return;
    this._history.invalidate();
    this._updateBackButton();
  },

  // From easy_reading.leaveCurrentPost: covers the article→article keys
  // ([ ] a b f = + -) that never pass through a list screen.
  //
  // One structural exception (live-verified 2026-08-13, this check is why the
  // first live back run failed): OUR OWN landing produces one of these. The run
  // enters easy reading's functionMode, and when the target article settles the
  // functionMode exit takes its 'leave' branch → leaveCurrentPost(). That fires
  // AFTER onDone has already cleared `active`, so without the one-shot below it
  // wipes the stack we just pushed — every jump would end with no way back.
  noteLeftPost: function() {
    if (this.active) return;
    const list = this._core.listSession;
    // Either way the post on screen is no longer the one the list session
    // opened, so its coordinate must not seed the NEXT anchor.
    if (list && list.noteLeftPost) list.noteLeftPost();
    if (this._ownedLeave) {
      this._ownedLeave = false;
      return;
    }
    // 指定看板挑板中（preparePicked）：離開文章的是背景 `s` prompt，不是使用者。
    if (this._picking) return;
    this._history.invalidate();
    this._updateBackButton();
  },

  // Disconnect: the session (and pttbbs's per-board getkeep cursors) is gone.
  reset: function() {
    this._history.abort();
    this._updateBackButton();
  },

  // Whole native screen as one string — the escape steps decide "did ← actually
  // move us a level?" by content, never by timing (v5). \f (fullRepaint) makes
  // every judged frame complete, so an unchanged signature really means unchanged.
  _screenSignature: function() {
    const buf = this._termBuf;
    const rowTexts = [];
    for (let r = 0; r < buf.rows; ++r) rowTexts.push(buf.getRowText(r, 0, buf.cols));
    return screenSignature(rowTexts);
  },

  // Already at 主功能表 (the escape preamble's destination). Same literal test
  // _enqueueEscape's expect uses, read straight off the native buffer.
  _atMainMenu: function() {
    const buf = this._termBuf;
    return isMainMenuRow(buf.getRowText(0, 0, buf.cols));
  },

  // 'reading' → s/# are live in this pager; anything else → escape preamble.
  // Deliberately single-directional (see string_util.parsePagerFooterContext):
  // 'unknown' (footer squeezed out) degrades to the SLOW path, never the fast one.
  _pagerContext: function() {
    const buf = this._termBuf;
    return parsePagerFooterContext(buf.getRowText(buf.rows - 1, 0, buf.cols));
  },

  // board may be null when the #AID had no suffix AND the article header was
  // never parsed — nothing to navigate to, tell the user instead of guessing.
  // opts.inPager：呼叫端已證明畫面是 pager（deep link 收到時人在原生 pmore 讀文），
  // 不必等好讀開著。
  start: function(aid, board, opts) {
    if (this.active) return;
    if (!board) {
      this._hint('AID 跳文：無法判斷目標看板', 0, HINT_ERROR);
      return;
    }
    if (!this._termBuf.startedEasyReading && !(opts && opts.inPager)) {
      // AID links only render in easy reading; a click that somehow arrives
      // outside an open post (stale DOM during a transition) is ignored.
      return;
    }
    // 閱讀紀錄：閱讀位置＋身後的列表（返回時一起帶回）。currentAnchor 仍要在
    // _begin() 之前讀（beginExternalNavigation 會清掉 _openedNum）。Nothing is
    // pushed until the run lands (commitJump).
    const bm = recordFor(this._core).begin('aid-jump', this._ctx());
    const lineIndex = bm.article ? bm.article.lineIndex : this._currentLineIndex();
    const ls = this._core.listSession;
    // 列表好讀自己開的這篇（currentAnchor 非 null）⇒ 是從看板文章列表進來的，
    // currstat 必為 READING。超長文 footer 被行號擠掉時（見 _begin）這是唯一的證據。
    const listOpened = !!(ls && ls.currentAnchor && ls.currentAnchor());
    this._history.beginJump(this._withList(this._captureOriginAnchor(board, lineIndex), bm), {
      board: board,
      aid: aid
    });
    this._hint('跳至 #' + aid + ' (' + board + ')…', PROGRESS_HINT_MS);
    const run = makeRun({ board: board, kind: 'aid', aid: aid }, 'forward');
    // Carried so _enqueueOriginAid can hand the scroll position to an anchor
    // built from nothing (same-board jump, 站內信): chooseAnchor returned null
    // there, so there is no previous anchor to inherit it from.
    run.originLineIndex = lineIndex;
    run.originList = bm.list;
    run.listOpened = listOpened;
    this._begin(run);
  },

  // 指定看板的 AID 跳文，分兩段（無看板 #AID →「跳到其他看板…」，aid_board_choice.js）。
  // 挑板用的是 `s` 看板搜尋彈窗的原生補全橋接（board_search_bridge），它一開 `s` 就
  // 離開文章（pager 的 s 先收掉 pager 才進 do_select）⇒ 返回錨與閱讀位置只能在開橋接
  // **之前**量（preparePicked）。橋接送出板名、落地目標板列表後，continuePicked 從那個
  // 列表接手 #AID ⏎ ⏎ —— 板跳那一步就是橋接送出的那個 Enter。
  // 回 null ＝ 現在不能跳（另一趟在跑／不在好讀文章裡）。
  preparePicked: function(aid) {
    if (this.active || !aid || !this._termBuf.startedEasyReading) return null;
    // 決策表 'aid-board-pick'：送出＝跳文（不還原）；取消＝重開原文回原列（reopenPicked）。
    const bm = recordFor(this._core).begin('aid-board-pick', this._ctx());
    const token = {
      aid: aid,
      bm: bm,
      lineIndex: bm.article ? bm.article.lineIndex : this._currentLineIndex(),
      landed: this._history.landed(),
      articleBoard: this._view._articleBoard,
      // 文末網址列的免費路徑（零指令）；Q 不能用：人一離開文章就問不到本篇了。
      localAid: this.findLocalPostAid()
    };
    this._picking = token;
    return token;
  },

  // 挑板收尾但不再導航：stillInArticle ＝ prompt 根本沒開出來（人還在原文）⇒ 返回堆疊
  // 照舊有效；否則停在哪不確定 ⇒ 同使用者自己離開文章，堆疊作廢。
  endPicked: function(token, stillInArticle) {
    if (!token || this._picking !== token) return;
    this._picking = null;
    if (stillInArticle) return;
    this._history.invalidate();
    this._updateBackButton();
  },

  // 挑板取消（原生 `s` prompt 收到 Ctrl-C）：pager 收掉後的 `s` 取消只會停在原文所在的
  // 那份列表（do_select 失敗回 FULLUPDATE：不是 NEWDIRECT，read loop 的游標不動、搜尋
  // 結果也還在）⇒ 游標就停在原文上，直接 ⏎ 開它。不用 #AID：搜尋結果裡 # 被拒
  // （錄製檔 ptt-debug-20261018-173606），而且 ⏎ 連身後的搜尋結果都原樣保留。
  // 落地後閱讀紀錄還原原列（'aid-board-pick' cancel）。返回堆疊不動（挑板期間有保護）。
  reopenPicked: function(token) {
    if (!token || this._picking !== token) return false;
    this._picking = null;
    if (this.active || !token.articleBoard) {
      this._history.invalidate();
      this._updateBackButton();
      return false;
    }
    const run = makeRun({ board: token.articleBoard, kind: 'aid', aid: null }, 'reopen');
    run.bookmark = token.bm;
    run.picked = true;
    this.opHint = '回到原文中';
    this._begin(run);
    return true;
  },

  continuePicked: function(token, board) {
    if (this._picking === token) this._picking = null;
    if (this.active || !token || !board) return false;
    const anchor = chooseAnchor({
      landed: token.landed,
      articleBoard: token.articleBoard,
      targetBoard: board,
      lineIndex: token.lineIndex
    });
    this._history.beginJump(this._withList(anchor, token.bm), { board: board, aid: token.aid });
    if (token.localAid)
      this._history.upgradePendingOriginAid(
        token.localAid.board,
        token.localAid.aid,
        token.lineIndex,
        token.bm.list
      );
    this._hint('跳至 #' + token.aid + ' (' + board + ')…', PROGRESS_HINT_MS);
    const run = makeRun({ board: board, kind: 'aid', aid: token.aid }, 'forward');
    run.originLineIndex = token.lineIndex;
    run.originList = token.bm.list;
    run.picked = true;
    this._begin(run);
    return true;
  },

  // 閱讀紀錄量文章用的畫面（unit 的假 core 沒掛 view／buf）。
  _ctx: function() {
    return { view: this._view, buf: this._termBuf };
  },

  // 返回錨附上「身後的列表」：返回落地後退回列表時，列表好讀回到原本的視野。
  _withList: function(anchor, bm) {
    if (!anchor || !bm || !bm.list) return anchor;
    return Object.assign({}, anchor, { list: bm.list });
  },

  // A jump asked for from OUTSIDE the terminal (a deep link — see
  // deep_link_controller.js). Same machinery, three differences from start():
  //   - not gated on startedEasyReading: a deep link is normally consumed right
  //     after login, at 主功能表, where no article is open at all. start()'s
  //     gate would make it silently do nothing.
  //   - the origin comes from the reading record (externalOriginAnchor): an
  //     article list the user was looking at becomes a board anchor (back =
  //     `s<board>` and the list viewport is restored); 主功能表／看板列表 have
  //     nothing to go back to (no "← 返回" pill). When the user IS reading an
  //     article, the caller uses start() instead so the Q step captures a real
  //     anchor.
  //   - Q is skipped: there is no article to ask about.
  // Returns whether the run was started (false = busy / bad arguments).
  startExternal: function(aid, board, onEnd) {
    if (this.active) return false;
    if (!aid || !board) return false;
    this._onRunEnd = onEnd || null;
    const bm = recordFor(this._core).begin('deep-link-jump', this._ctx());
    this._history.beginJump(externalOriginAnchor(bm, board), { board: board, aid: aid });
    this._hint('跳至 #' + aid + ' (' + board + ')…', PROGRESS_HINT_MS);
    const run = makeRun({ board: board, kind: 'aid', aid: aid }, 'forward');
    run.originLineIndex = null;
    run.external = true;
    this._begin(run);
    return true;
  },

  // agent 工具（agent_tools.js）的兩種跳法，與 AID 跳文共用逃生前導／板跳／進板畫面
  // 處理，只換中段：
  //   startBoard：停在目標板的文章列表；opts.end ⇒ 再送 End 停在板尾（最新文章＋置底）；
  //               opts.num ⇒ 改送 `<編號>⏎` 停在那一篇所在的列表頁，不開文（列更舊的頁）。
  //   startNum：  `<編號>⏎` 停到那一篇再 ⏎ 開文（同 list_session open-jump 的指紋）。
  // dir 'goto'：不碰返回堆疊（沒有 Q 問原文 AID、成功就 invalidate，同使用者自己換板）。
  // onEnd({ ok, error? }) 在 run 結束時呼叫一次（成功或 _fail）。
  startBoard: function(board, opts, onEnd) {
    if (this.active || !board) return false;
    const num = opts && opts.num != null ? Number(opts.num) : null;
    if (num != null && !(num > 0)) return false;
    this._onRunEnd = onEnd || null;
    const run = makeRun(
      num != null
        ? { board: board, kind: 'board', aid: null, num: num, listOnly: true }
        : { board: board, kind: 'board', aid: null, end: !!(opts && opts.end) },
      'goto'
    );
    run.external = true;
    this._hint('前往 ' + board + ' 看板…', PROGRESS_HINT_MS);
    this._begin(run);
    return true;
  },

  // 置底文開文（agent ptt_read_article 的 pinned）：板跳 → End（游標停在最後一篇置底）
  // → ↑ 移到板尾畫面第 index 篇置底 → ⏎。置底文沒有編號、跳號跳不到，只能這樣走。
  startPinned: function(board, index, onEnd) {
    if (this.active || !board || !(Number.isInteger(index) && index >= 0)) return false;
    this._onRunEnd = onEnd || null;
    const run = makeRun({ board: board, kind: 'board', aid: null, end: true, pinnedIndex: index }, 'goto');
    run.external = true;
    this._hint('開啟 ' + board + ' 置底文…', PROGRESS_HINT_MS);
    this._begin(run);
    return true;
  },

  startNum: function(board, num, onEnd) {
    if (this.active || !board || !(num > 0)) return false;
    this._onRunEnd = onEnd || null;
    const run = makeRun({ board: board, kind: 'num', aid: null, num: num }, 'goto');
    run.external = true;
    this._hint('開啟 ' + board + ' 第 ' + num + ' 篇…', PROGRESS_HINT_MS);
    this._begin(run);
    return true;
  },

  // 搜尋結果／文摘裡的第 num 篇（next_article）：編號是子列表自己的空間（read.c MODE_SELECT
  // 重新編號），`s<板>`、`#` 都會離開它或被拒 ⇒ 文章內 ← 回到同一份子列表（pmore 結束回
  // i_read，搜尋條件不動），`<編號>⏎` 在子列表裡跳（read_cmd_num 的 search_num 只看目前
  // 列表的 last_line），verify(cursorRowText) 認得游標那一列才 ⏎ 開文；認不出就停在列表，
  // 不猜。只從已證明是 READING 的 pager 出發（← 在別的畫面意思不同）。
  startSubNum: function(board, num, verify, onEnd) {
    if (this.active || !board || !(num > 0) || typeof verify !== 'function') return false;
    if (this._pagerContext() !== 'reading') return false;
    this._onRunEnd = onEnd || null;
    const run = makeRun({ board: board, kind: 'num', aid: null, num: num, subList: true, verify: verify }, 'goto');
    run.external = true;
    this._hint('開啟搜尋結果第 ' + num + ' 篇…', PROGRESS_HINT_MS);
    this._begin(run);
    return true;
  },

  // 斷線重連後回到原處（reconnect_resume.js；docs/reading-record.md「斷線重連」）。
  // plan：reconnect_resume.resumePlanFrom 的輸出，bookmark 是斷線那一刻的閱讀紀錄。
  //   文章（plan.aid）：s<板> → #<aid> → ⏎，落地依決策表 'reconnect-resume' 還原列。
  //   列表（plan.num 可省）：s<板> → `<編號>⏎`（游標回到斷線前那篇）→ 停在列表，
  //     列表好讀 rebuild 時還原視野。
  // dir 'resume'：不碰返回堆疊（斷線時 reset 已經清空，重放錨的 getkeep 也跟著死了）。
  startResume: function(plan, onEnd) {
    if (this.active || !plan || !plan.board) return false;
    this._onRunEnd = onEnd || null;
    const run = makeRun(
      { board: plan.board, kind: plan.aid ? 'aid' : 'board', aid: plan.aid || null, num: plan.aid ? null : plan.num },
      'resume'
    );
    run.external = true;
    run.bookmark = plan.bookmark || { feature: 'reconnect-resume' };
    this._resuming = true;
    this.opHint = '回到斷線前的位置，請稍候…';
    this._hint('回到斷線前的位置：' + plan.board + (plan.aid ? ' #' + plan.aid : ' 看板') + '…', PROGRESS_HINT_MS);
    this._begin(run);
    return true;
  },

  // 本篇是哪一篇（斷線前記下來，重連後才回得去）。免費網址列優先；落空時用 AID 跳文
  // 落地記下的那篇（返回堆疊的 landed，使用者離開文章就會被 invalidate，所以仍是本篇）。
  // 都沒有 ⇒ null（**不按 Q**：斷線當下已經沒有連線可問）。
  currentPostAid: function() {
    const local = this.findLocalPostAid();
    if (local) return local;
    const buf = this._termBuf;
    const board = this._view && this._view._articleBoard;
    if (!buf || buf.pageState !== 3 || !board) return null;
    const landed = this._history.landed();
    if (!landed || !landed.aid || !landed.board) return null;
    return String(landed.board).toLowerCase() === String(board).toLowerCase() ? landed : null;
  },

  // 回到原處的列表收尾（含找不到原文、編號跳不到）：列表視野交給閱讀紀錄（只比板與
  // 編號空間 —— 新登入的 server 游標不會等於斷線前的本地選取），放開外部 hold。
  _finishResumeAtList: function(run, outcome, msg, level) {
    this.active = false;
    this.opHint = null;
    this._resuming = false;
    const bm = run.bookmark;
    const rr = recordFor(this._core);
    if (bm && bm.list)
      rr.end(Object.assign({}, bm, { list: Object.assign({}, bm.list, { matchBoardOnly: true }) }), outcome, {
        only: 'list'
      });
    rr.releaseExternal();
    this._updateBackButton();
    this._hint(msg || '已回到斷線前的位置：' + run.target.board + ' 看板', msg ? 6000 : 2000, level);
    this._endRun({ ok: outcome === 'done' });
  },

  _endRun: function(result) {
    const cb = this._onRunEnd;
    this._onRunEnd = null;
    if (cb) cb(result);
  },

  // Back to the article the last jump started from. Deliberately NOT gated on
  // startedEasyReading: the target article may be rendering natively (the user
  // toggled easy reading off), and the sequence drives the native screen anyway.
  back: function() {
    if (this.active) return;
    const anchor = this._history.beginBack();
    if (!anchor) {
      this._hint('沒有可返回的文章', 0, HINT_ERROR);
      return;
    }
    this._hint('返回 ' + anchor.label + '…', PROGRESS_HINT_MS);
    this._begin(makeRun(anchor, 'back'));
  },

  // 重新整理本篇（screen_refresh.js 的文章分支；docs/screen-refresh.md）。
  //
  // pmore 把文章整份讀進來就不再看檔案（mbbsd/pmore.c 沒有任何 reload 路徑），所以
  // 「看新推文」只能重開。**不用 ←→**（live 文小幫手的做法）：← 回列表後游標停在
  // 原本的 crs_ln，但列表重讀之後那個序號可能已經是別篇（置底文在新文進來時整排
  // 往後挪、上方有文被刪…），→ 會靜默開錯篇。改走跳文同一條路：
  //   (Q／免費網址列取 AID) → s<本板>⏎（文章內的 s，more.c → Select()，列表 NEWDIRECT
  //   重讀索引、不顯示進板畫面）→ #<AID>⏎ → ⏎，每一步依畫面內容驗證。
  // 落地後還原閱讀位置：原本停在文末就黏回文末（新推文就在那裡），否則回到同一列。
  //
  // 回 true ＝序列已開始；false ＝這個畫面不能這樣重整（呼叫端給提示）。
  // 跟歷史堆疊無關：dir 'refresh' 不 push、不 commit（返回鈕照舊指向跳文前那篇）。
  refresh: function() {
    if (this.active) return false;
    const buf = this._termBuf;
    if (!buf || buf.pageState !== 3) return false;
    const board = this._view && this._view._articleBoard;
    if (!board) return false;
    const last = buf.getRowText(buf.rows - 1, 0, buf.cols);
    const status = parseStatusRow(last);
    const ls = this._core.listSession;
    const listOpened = !!(ls && ls.currentAnchor && ls.currentAnchor());
    let context = this._pagerContext();
    if (context === 'unknown' && listOpened && status) context = 'reading';
    // 站內信／精華區：s 與 # 都不在（more.c 依 currstat 擋掉），沒有可驗證的重開路。
    if (context !== 'reading') return false;
    // 閱讀位置與「在不在文末」都由閱讀紀錄量（好讀：已讀到文末且捲到底 2 列內；
    // 原生：狀態列 100%）。
    const bm = recordFor(this._core).begin('article-refresh', this._ctx());
    const run = makeRun({ board: board, kind: 'aid', aid: null }, 'refresh');
    run.bookmark = bm;
    // 列表好讀從搜尋結果／文摘開的這篇：`s<板>` 回來的還是子列表（# 被拒、游標停板尾），
    // 改走「← 回列表 → ⏎ 開游標上的這篇」——pager 的 ← 是 FULLUPDATE，游標不動，
    // 身後的搜尋結果也原樣保留（_enqueueRefreshViaList）。
    run.viaList = listOpened && !!(bm.list && bm.list.mode === 'select');
    run.originLineIndex = bm.article ? bm.article.lineIndex : this._currentLineIndex();
    run.atBottom = !!(bm.article && bm.article.atBottom);
    this._refreshing = true;
    this.opHint = '重新整理中，請稍候…';
    this._hint('重新整理中…', PROGRESS_HINT_MS);
    this._begin(run);
    return true;
  },

  // 重整的第 0 步：取得本篇 AID（免費網址列優先，落空才按 Q）。
  _enqueueRefreshAid: function(run) {
    const self = this;
    this.resolvePostAid({
      kind: 'refresh-post-info',
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      onDone: function(info, meta) {
        if (!info || !info.aid) {
          // 這篇沒有 AID（極舊文章）。Q 已經把我們丟回列表、而且那個 FULLUPDATE
          // 本身就重讀了索引（read.c read_apply_mode）⇒ 關框＋⏎ 重開游標下那篇，
          // 是唯一剩下的路；序號可能已漂移，所以退到這條時明講。
          if (!meta.boxOpen) {
            self._fail('無法取得文章代碼');
            return;
          }
          self.reopenAfterPostInfo(run.originLineIndex, {
            onFlushed: function() {
              self._fail('畫面已變更');
            },
            onDone: function() {
              self._finishRefresh(run, '已重新整理（本篇無文章代碼，依列表位置重開）');
            },
            onFail: function(reason) {
              self._fail('重開文章失敗（' + reason + '）');
            }
          });
          return;
        }
        // Q 把我們丟回的是搜尋結果／文摘（標題列「系列《」／「文摘《」，框蓋不到第 0 列）：
        // 游標就在這篇上，關框＋⏎ 重開，不繞 `s<板>`（回來仍是子列表、# 被拒）。
        if (meta.boxOpen && isSubListTitle(self._termBuf.getRowText(0, 0, self._termBuf.cols))) {
          self.reopenAfterPostInfo(run.originLineIndex, {
            onFlushed: function() {
              self._fail('畫面已變更');
            },
            onDone: function() {
              self._finishRefresh(run);
            },
            onFail: function(reason) {
              self._fail('重開文章失敗（' + reason + '）');
            }
          });
          return;
        }
        run.target.aid = info.aid;
        if (info.board) {
          run.target.board = info.board;
          run.boardLower = String(info.board).toLowerCase();
        }
        self._enqueueBoardJump(run, false, meta.boxOpen);
      },
      onFail: function(reason) {
        self._fail('取得文章代碼失敗（' + reason + '）');
      }
    });
  },

  // 重整的另一條路（run.viaList）：← 離開 pager（pager_cmd_quit 回 FULLUPDATE，read loop
  // 游標仍在這篇）→ 確認回到這篇的看板列表 → ⏎（_enqueueOpen → _finishRefresh）。
  _enqueueRefreshViaList: function(run) {
    const self = this;
    const boardLower = run.boardLower;
    this._queue.enqueue({
      keys: KEY_LEFT,
      kind: 'refresh-leave-article',
      fullRepaint: true,
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      timeoutMs: STEP_PROBE_AFTER_MS,
      probeTimeoutMs: STEP_PROBE_WINDOW_MS,
      hardTimeoutMs: STEP_HARD_MS,
      expect: function(snapshot, facts) {
        return landedOnBoardList(facts, boardLower);
      },
      onDone: function() {
        self._enqueueOpen(run);
      },
      onFail: function(reason) {
        self._fail('回到列表失敗（' + reason + '）');
      }
    });
  },

  _finishRefresh: function(run, msg) {
    this.active = false;
    this.opHint = null;
    this._refreshing = false;
    const er = this._core.easyReading;
    if (er && er.ensureEnabledOnArticle) er.ensureEnabledOnArticle(true);
    // 決策表 'article-refresh' done ＝ 'auto'：在文末就黏回文末，否則同一列；原生
    // pmore 文末用原生 End（reading_record.restoreArticle）。好讀的還原是請求：
    // _pendingEnableOnArticle（落地幀還不完整）時先掛著，累積到位才生效。
    recordFor(this._core).end(
      run.bookmark,
      'done',
      {
        only: 'article',
        article: {
          lineIndex: run.originLineIndex,
          atBottom: run.atBottom,
          easy: run.bookmark && run.bookmark.article ? run.bookmark.article.easy : undefined
        }
      }
    );
    recordFor(this._core).releaseExternal();
    this._updateBackButton();
    this._hint(msg || '已重新整理', 1200);
  },

  // 返回落在列表上（看板錨 `s<板>`、或找不到原文停在列表）：把錨帶著的列表視野
  // 交給閱讀紀錄（只比板與編號空間：server 游標是 getkeep 的，不等於本地選取），
  // 再放開外部 hold 讓列表好讀接手。
  _restoreListOf: function(entry) {
    const rr = recordFor(this._core);
    if (entry && entry.list)
      rr.restoreList(Object.assign({}, entry.list, { matchBoardOnly: true }));
    rr.releaseExternal();
  },

  // Is a back run available right now (drives the button / the shortcut)?
  canGoBack: function() {
    return !this.active && this._history.canGoBack();
  },

  // The anchor for the article we are leaving, by priority (nav_history
  // .chooseAnchor). Must run before the mirrors are entered — see start().
  _captureOriginAnchor: function(targetBoard, lineIndex) {
    return chooseAnchor({
      landed: this._history.landed(),
      articleBoard: this._view._articleBoard,
      targetBoard: targetBoard,
      lineIndex: lineIndex
    });
  },

  // Scroll position as a LINE index rather than pixels: the article is re-read
  // from the server on the way back, so a raw scrollTop would only be right if
  // every row rendered at exactly the same height again.
  // 換算在 term_view.currentLineIndex（手機換行版面要量節點，不能 scrollTop/chh）。
  _currentLineIndex: function() {
    return this._view.currentLineIndex();
  },

  // Shared entry for every run: lock input, put the REAL native screen on
  // screen, then pick the fast (in-article s) or slow (escape preamble) path.
  _begin: function(run) {
    this.active = true;
    this._updateBackButton(); // active → hidden: no second run mid-flight
    // Claim the leaveCurrentPost that our own landing will produce — see
    // noteLeftPost. Armed here (not on success) so a failed run's exit is
    // absorbed too; _fail clears the stack anyway.
    this._ownedLeave = true;

    // Show the REAL native screen while we drive it. The article easy reading's
    // functionMode is the existing live-mirror mechanism; when we leave the
    // post its settle logic runs leaveCurrentPost, and the final 2→3 settle
    // edge re-enables easy reading on the TARGET article — zero new coupling.
    this._core.easyReading._enterFunctionMode();
    // Park an engaged list session in its functionMode (native mirror,
    // nativeHold, queue flushed) so the shared queue is empty and its reducer
    // absorbs our intermediate clean-list settles. Must run BEFORE we enqueue.
    // 回到原處從主功能表出發，列表 session 通常是 idle：也要停泊（見 fromIdle）。
    if (this._core.listSession)
      this._core.listSession.beginExternalNavigation({ fromIdle: run.dir === 'resume' });
    // 看板列表平滑捲動同理（AID 跳文的逃生前導會經過主功能表／看板列表）。
    if (this._core.boardListSession)
      this._core.boardListSession.beginExternalNavigation();

    // Already where the escape preamble would have taken us. Skipping it is not
    // just an optimisation: _enqueueEscape SENDS ← and only then judges, and ←
    // at 主功能表 moves the highlight onto G)oodbye (see its own comment on
    // overshoot). The deep-link entry point lands here almost every time — the
    // link is usually opened right after logging in.
    // 重整只從「已證明是 READING 的文章內」出發（refresh() 先驗過），走文章內 s 的快路徑。
    if (run.dir === 'refresh') {
      if (run.viaList) this._enqueueRefreshViaList(run);
      else this._enqueueRefreshAid(run);
      return;
    }
    // 指定看板（continuePicked）：橋接已經進板了，先確認真的停在目標板列表。
    if (run.picked) {
      this._enqueuePickedLanding(run);
      return;
    }
    // 子列表的編號（startSubNum 已驗過人在 pager）：← 回到同一份搜尋結果。
    if (run.target.subList) {
      this._enqueueBackToSubList(run);
      return;
    }
    if (this._atMainMenu()) {
      this._enqueueBoardJump(run, true, false);
      return;
    }
    let context = this._pagerContext();
    // 超長文（行號四位數以上）的 footer 放不下「(y)回應」那段：more.c#
    // common_pmore_footer_handler 依剩餘寬度退成「(h)說明 (←/q)離開」——與站內信／
    // 精華區的短版一字不差，footer 本身證明不了 READING。列表好讀自己開的文章
    // 有另一份證據（見 start()）；仍要求末列是 pager 狀態列，免得拿陳舊證據
    // 去認一張根本不是 pager 的畫面。有這份證據就能走文章內 `s` 的快路徑；
    // 沒有的話下面的 _enqueueOriginAidUnproven 照樣問 AID，只是改繞主功能表
    // （錄製檔 ptt-debug-20261012-235048：舊版在這裡不按 Q，返回跑到別篇）。
    if (
      context === 'unknown' &&
      run.listOpened &&
      parseStatusRow(this._termBuf.getRowText(this._termBuf.rows - 1, 0, this._termBuf.cols))
    )
      context = 'reading';
    if (context !== 'reading') {
      // Not provably a board article (站內信 / 精華區 / footer squeezed out):
      // s/# may be dead here, so the board jump goes via the escape preamble.
      // The back anchor is still worth an AID whenever the header names a board
      // — returning by article number is not allowed (see the file header).
      if (run.dir === 'forward' && !run.external && this._view._articleBoard) {
        this._enqueueOriginAidUnproven(run);
        return;
      }
      this._enqueueEscape(run, 0, this._screenSignature());
      return;
    }
    // run.external: no origin anchor was captured (startExternal), so there is
    // nothing for the Q answer to upgrade — spend the command on the jump.
    if (run.dir === 'forward' && !run.external) {
      this._enqueueOriginAid(run);
      return;
    }
    this._enqueueBoardJump(run, false, false);
  },

  // Step 0 (forward jumps only): Q → the post-info box, which is the ONLY way
  // to learn the AID of the article we are leaving (mbbsd/more.c:70 →
  // bbs.c#view_postinfo:3691-3705). That AID becomes the back anchor, and it is
  // the only anchor that survives a `/` search: MODE_SELECT renumbers the list
  // into its own space (read.c:661-665), so a number captured there points at a
  // different article once `s<board>` drops us back on the real list.
  // Same trick BePTT uses for ground truth (see docs/enhanced-addon.md §B).
  //
  // Best effort by design: every failure just continues WITHOUT the upgrade, so
  // the worst case is exactly today's behaviour. Only a flush (the navigation
  // context itself is gone) is fatal, like every other step.
  _enqueueOriginAid: function(run) {
    const self = this;
    this.resolvePostAid({
      kind: 'aid-origin-info',
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      onDone: function(info, meta) {
        if (info) {
          self._history.upgradePendingOriginAid(
            info.board,
            info.aid,
            run.originLineIndex,
            run.originList
          );
          self._updateBackButton();
        }
        // dismissFirst 只在真的按過 Q 時成立：那時框的 pressanykey 還在等，把關框
        // 併進板跳指令比再花一個指令便宜。走免費路徑時沒有框，多送的那個空白會
        // 被 pager 當成 PageDown。
        self._enqueueBoardJump(run, false, meta.boxOpen);
      },
      onFail: function() {
        // Degrade, never fail: the jump itself is still perfectly doable, the
        // back anchor just stays at whatever tier chooseAnchor picked.
        // onFail 只可能來自 Q 那條路（免費路徑沒有失敗這回事）⇒ 框一定開著。
        self._enqueueBoardJump(run, false, true);
      }
    });
  },

  // Step 0 when the footer cannot tell READING from 站內信／精華區 (the squeezed
  // footer of a very long post is byte-identical to theirs) but the header
  // names a board. Same free-path-then-Q as _enqueueOriginAid; what Q does in
  // each candidate context (CONFIRMED by reading the source):
  //   READING  bbs.c:2381 view_postinfo → the box (pressanykey) over the list.
  //            The box itself PROVES READING ⇒ continue exactly like the
  //            reading path (dismiss + `s` on the list).
  //   精華區   more() returns RET_DOQUERYINFO, announce.c:1185-1218's loop hits
  //            `else break` ⇒ back to the 精華區 menu, no box ⇒ probe → miss →
  //            onFail ⇒ escape preamble from wherever we now are.
  //   站內信   has no 看板 in its header (_articleBoard null) ⇒ never gets here.
  _enqueueOriginAidUnproven: function(run) {
    const self = this;
    this.resolvePostAid({
      kind: 'aid-origin-info',
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      onDone: function(info, meta) {
        if (info) {
          self._history.upgradePendingOriginAid(
            info.board,
            info.aid,
            run.originLineIndex,
            run.originList
          );
          self._updateBackButton();
        }
        if (meta.boxOpen) self._enqueueBoardJump(run, false, true);
        // Free path: nothing was sent, READING is still unproven.
        else self._enqueueEscape(run, 0, self._screenSignature());
      },
      onFail: function() {
        self._enqueueEscape(run, 0, self._screenSignature());
      }
    });
  },

  // 「本篇是哪一篇」的免費路徑：文章本文末尾那行
  //   ※ 文章網址: https://www.ptt.cc/bbs/<Board>/M.<v1>.A.<v2>.html
  // 已經把檔名寫在畫面上，aid_codec 直接換算成 AID ⇒ **零指令、畫面完全不動**。
  // 按 Q 相對之下很貴：mbbsd/bbs.c:2375-2377 回 FULLUPDATE，一定被抛回文章列表，
  // 得再花 ␣ + ⏎ 兩個指令回來（使用者看得到畫面在閃）。
  //
  // 回 { board, aid } 或 null（null ⇒ 呼叫端退回按 Q，行為與這個功能不存在時相同）。
  //
  // **看板守門不可省**：轉錄文會原樣複製原文內容、連原文那行網址一起帶進來
  // （mbbsd/bbs.c:2162-2179）。所幸 pttbbs 擋掉同板轉錄（bbs.c:2097「同板不需轉錄。」），
  // 所以「網址裡的看板 ≠ 目前文章的看板」就足以判定看板間轉錄的原文。
  // **但信箱轉錄擋不住**（mbbsd/mail.c:2067：先把文章寄到自己信箱、再從信箱轉回同一個
  // 看板 ⇒ 網址看板與本篇相同）：轉錄文本身沒有網址列，所以一看到列首的
  // 「※ [本文轉錄自 …]」就整篇放棄免費路徑、退回按 Q（aid_parse.isCrossPostHeaderLine）。
  findLocalPostAid: function() {
    const buf = this._termBuf;
    // pageState 3 = READING。不在文章裡時畫面上的網址列不代表「本篇」。
    if (!buf || buf.pageState !== 3 || !buf.getRowText) return null;
    const board = this._view && this._view._articleBoard;
    // 站內信／精華區沒有看板（comment_parse 會把 _articleBoard 清成 null）：
    // 沒有看板就守不了門，也組不出連結。
    if (!board) return null;

    const acc = buf.pageLines;
    let hit;
    if (acc && acc.length) {
      // 好讀累積長頁可以長到數千列，但它只會往後 concat（screen_annotate_cache.js
      // 的不變量），所以只掃「這次新增的那幾列」。換文章／_healFromTop 會把
      // pageLines 清掉重建 ⇒ 長度變短或首列變了就把游標與命中一起歸零。
      const head = acc.length ? buf.getRowText(0, 0, buf.cols, acc) : '';
      if (acc.length < this._urlScanLen || head !== this._urlScanHead)
        this.resetLocalPostAidScan();
      this._urlScanHead = head;
      if (!this._urlScanHit && !this._urlScanForwarded) {
        for (let r = this._urlScanRow; r < acc.length; ++r) {
          const text = buf.getRowText(r, 0, buf.cols, acc);
          // 轉錄標頭在網址之前 ⇒ 之後的網址都是被轉錄的原文（見 aid_parse.isCrossPostHeaderLine）。
          if (isCrossPostHeaderLine(text)) {
            this._urlScanForwarded = true;
            break;
          }
          const found = parseArticleUrlLine(text);
          if (found) {
            this._urlScanHit = found;
            break;
          }
        }
        this._urlScanRow = acc.length;
      }
      this._urlScanLen = acc.length;
      hit = this._urlScanForwarded ? null : this._urlScanHit;
    } else {
      // 原生模式沒有累積頁，只有眼前這 24 列——每次重掃即可（便宜，也不會過期）。
      // 轉錄標頭可能已經捲出這一屏：只看得到網址時仍會誤認 ⇒ 這是原生模式的已知
      // 盲點（看不到就不知道），好讀累積頁從第一列掃起才是完整判準。
      this.resetLocalPostAidScan();
      for (let r = 0; r < buf.rows && !hit; ++r) {
        const text = buf.getRowText(r, 0, buf.cols);
        if (isCrossPostHeaderLine(text)) return null;
        hit = parseArticleUrlLine(text);
      }
    }
    if (!hit) return null;
    return String(hit.board).toLowerCase() === String(board).toLowerCase()
      ? hit
      : null;
  },

  resetLocalPostAidScan: function() {
    this._urlScanRow = 0;
    this._urlScanLen = 0;
    this._urlScanHead = '';
    this._urlScanHit = null;
    this._urlScanForwarded = false;
  },

  // 取得本篇 AID 的統一入口：先試免費路徑，落空才按 Q。
  //
  // onDone(info, meta) 的 **meta.boxOpen 不可忽略**：它說的是「Q 的資訊框現在正開著、
  // 需要關掉」。走免費路徑時根本沒按 Q，若呼叫端照舊送關框的 ␣，那個空白會被 pager
  // 當成 PageDown、後面的 ⏎ 又再翻一頁 ⇒ 使用者的閱讀位置被弄丟。
  resolvePostAid: function(handlers) {
    const local = this.findLocalPostAid();
    if (local) {
      handlers.onDone(local, { boxOpen: false });
      return;
    }
    this.queryPostAid({
      kind: handlers.kind,
      onFlushed: handlers.onFlushed,
      onDone: function(info) {
        handlers.onDone(info, { boxOpen: true });
      },
      onFail: handlers.onFail
    });
  },

  // The Q post-info transaction itself, shared by the jump's anchor upgrade
  // above and by "複製本篇連結" (deep_link_controller): the three non-obvious
  // constraints — no fullRepaint, a pressanykey tail IS the answer "this post
  // has no AID", and the box may only be dismissed with KEY_DISMISS — must
  // exist in exactly one place.
  //
  // onDone receives { aid, board } (board may be null) or null. Dismissing the
  // box is the CALLER's job: the jump folds it into its next command, a caller
  // with no next command must send dismissPostInfo() itself or the user is left
  // staring at the box.
  queryPostAid: function(handlers) {
    this._queue.enqueue({
      keys: 'Q',
      kind: handlers.kind || 'aid-post-info',
      // NO fullRepaint: the appended \f would be eaten by view_postinfo's
      // closing pressanykey() and the box would be gone by the time the screen
      // settles — we would read the list back instead of the AID.
      fullRepaint: false,
      onFlushed: handlers.onFlushed,
      timeoutMs: STEP_PROBE_AFTER_MS,
      probeTimeoutMs: STEP_PROBE_WINDOW_MS,
      hardTimeoutMs: STEP_HARD_MS,
      expect: function(snapshot, facts) {
        let info = null;
        let fromUrl = null;
        for (let r = 0; r < facts.rowTexts.length; ++r) {
          if (!info) info = parsePostInfoAid(facts.rowTexts[r]);
          if (!fromUrl) fromUrl = parsePostInfoUrl(facts.rowTexts[r]);
        }
        // 同一個框的第二列（bbs.c:3713）帶著完整網址。currboard 為空時第一列的
        // 板名會印「不明」（bbs.c:3701），網址裡的看板卻一直是對的 ⇒ 補得回來。
        if (info && !info.board && fromUrl)
          info = { aid: info.aid, board: fromUrl.board };
        if (info) return { info: info };
        if (fromUrl) return { info: fromUrl };
        // Box is up but this post has no AID (bbs.c:3707 prints a bare frame
        // line). A real answer — stop waiting and move on without an upgrade.
        const lastRow = facts.rowTexts[facts.rows - 1] || '';
        return PRESS_ANY_KEY_RE.test(lastRow) ? { info: null } : false;
      },
      onDone: function(result) {
        handlers.onDone(result.info);
      },
      onFail: function(reason) {
        handlers.onFail(reason);
      }
    });
  },

  // Put the reader back on the post after a Q that was asked purely to LEARN the
  // AID (「複製本篇連結」). Reading the info box is not free: mbbsd/bbs.c:2375-2377
  // answers RET_DOQUERYINFO with `view_postinfo(...); return FULLUPDATE;` — the
  // FULLUPDATE leaves the pager and repaints the LIST. So after Q the user is on
  // the article list no matter what, with the cursor still parked on the post
  // (i_read never moved it). Two keys put it back:
  //   ␣  dismiss the box's pressanykey → the list
  //   ⏎  reopen the post under the cursor
  // The jump path never needed this because its next step (s<board>) is a list
  // command anyway — which is exactly why this only showed up once the copy
  // action started using the same Q (live-verified 2026-08-16: 複製完就跳出文章).
  //
  // lineIndex (optional): the reading position to restore once the post has
  // grown back — same one-shot easy reading uses for an AID back run.
  reopenAfterPostInfo: function(lineIndex, handlers) {
    const self = this;
    const h = handlers || {};
    this._queue.enqueue({
      keys: KEY_DISMISS,
      kind: 'aid-post-info-dismiss',
      fullRepaint: true,
      onFlushed: h.onFlushed,
      timeoutMs: STEP_PROBE_AFTER_MS,
      probeTimeoutMs: STEP_PROBE_WINDOW_MS,
      hardTimeoutMs: STEP_HARD_MS,
      // The list is where Q leaves us; a still-article frame means the box was
      // never up (nothing to dismiss) and we are already home.
      expect: function(snapshot, facts) {
        if (facts.kind === 'clean-list') return { onList: true };
        if (facts.kind === 'article') return { onList: false };
        return !!parseStatusRow(facts.rowTexts[facts.rows - 1] || '')
          ? { onList: false }
          : false;
      },
      onDone: function(result) {
        if (!result.onList) {
          if (h.onDone) h.onDone();
          return;
        }
        self._enqueueReopen(lineIndex, h);
      },
      onFail: h.onFail || function() {}
    });
  },

  _enqueueReopen: function(lineIndex, h) {
    const self = this;
    this._queue.enqueue({
      keys: '\r',
      kind: 'aid-post-info-reopen',
      fullRepaint: true,
      onFlushed: h.onFlushed,
      timeoutMs: STEP_PROBE_AFTER_MS,
      probeTimeoutMs: STEP_PROBE_WINDOW_MS,
      hardTimeoutMs: STEP_HARD_MS,
      expect: function(snapshot, facts) {
        if (facts.kind === 'article') return true;
        return !!parseStatusRow(facts.rowTexts[facts.rows - 1] || '');
      },
      onDone: function() {
        recordFor(self._core).restoreArticle({ lineIndex: lineIndex }, 'origin');
        if (h.onDone) h.onDone();
      },
      onFail: h.onFail || function() {}
    });
  },

  // Step 0 (only when the pager is not currstat == READING): ← until 【主功能表】.
  // One press per command so every level is confirmed by CONTENT before the next
  // key goes out — a blind burst would be typeahead-swallowed (protocol §1/§2)
  // and could overshoot into 主功能表's ← (which highlights G)oodbye).
  _enqueueEscape: function(run, step, prevSig) {
    const self = this;
    this._queue.enqueue({
      keys: KEY_LEFT,
      kind: 'aid-escape',
      fullRepaint: true,
      // Same reason as the other steps: flush() is silent by contract, and a
      // dropped command would leave `active` stuck true (every keystroke
      // swallowed at the term_view entry point, with no way back).
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      timeoutMs: STEP_PROBE_AFTER_MS,
      probeTimeoutMs: STEP_PROBE_WINDOW_MS,
      hardTimeoutMs: STEP_HARD_MS,
      expect: function(snapshot, facts) {
        if (isMainMenuRow(facts.rowTexts[0] || ''))
          return { menu: true };
        // ← 往上退一層永遠不會落在文章畫面（文章→列表、信件→信箱、精華區文章→
        // 目錄）。文章幀只可能是好讀自動翻頁那個還在線上的 PageUp/PageDown 的遲到
        // 回應：算成「退了一層」會讓之後每一步都慢一拍，最後一個 ← 落在主功能表上
        // （反白移到 G)oodbye）。繼續等真正的回應。
        if (facts.kind === 'article') return false;
        const sig = screenSignature(facts.rowTexts);
        // Unchanged screen = ← did nothing (or was swallowed): NOT a level up.
        // Stay in flight → probe → miss → visible fail, never a silent retry.
        return sig === prevSig ? false : { sig: sig };
      },
      onDone: function(result) {
        if (result.menu) {
          self._enqueueBoardJump(run, true, false);
          return;
        }
        if (step + 1 >= MAX_ESCAPE_STEPS) {
          self._fail('退不回主功能表（層數過多）');
          return;
        }
        self._enqueueEscape(run, step + 1, result.sig);
      },
      onFail: function(reason) {
        self._fail('退不回主功能表（' + reason + '）');
      }
    });
  },

  // Dismiss the 進板畫面 that ReadSelect() → Read() shows on this session's first
  // entry to a board (mbbsd/bbs.c:4482-4492: more(notes) then pressanykey()).
  // ← leaves the pmore pager AND satisfies pressanykey, so one key handles both.
  _enqueueEnterBoardDismiss: function(run, round) {
    const self = this;
    this._queue.enqueue({
      keys: KEY_LEFT,
      kind: 'aid-board-enter',
      fullRepaint: true,
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      timeoutMs: STEP_PROBE_AFTER_MS,
      probeTimeoutMs: STEP_PROBE_WINDOW_MS,
      hardTimeoutMs: STEP_HARD_MS,
      expect: this._boardLandingExpect(run.boardLower),
      onDone: function(result) {
        self._onBoardLanding(run, result, round);
      },
      onFail: function(reason) {
        self._fail('進入看板 ' + run.target.board + ' 失敗（' + reason + '）');
      }
    });
  },

  // Shared by the via-menu board jump and its dismiss rounds: the landing is the
  // target board's clean list; a 進板畫面 or a pressanykey tail is a known
  // intermediate, everything else keeps waiting.
  _boardLandingExpect: function(boardLower) {
    return function(snapshot, facts) {
      if (landedOnBoard(facts, boardLower)) return { landed: true };
      const lastRow = facts.rowTexts[facts.rows - 1] || '';
      if (PRESS_ANY_KEY_RE.test(lastRow)) return { dismiss: true };
      // We are between 主功能表 and the list here, so an article screen can only
      // be the 進板畫面 pager — the target post is still two commands away.
      if (facts.kind === 'article') return { dismiss: true };
      // The OTHER shape of the same 進板畫面. mbbsd/bbs.c#Read:4470 shows the
      // board notes with more(buf, NA), and NA == PMORE_AUTO_EXIT
      // (pmore.c:199-200) — that mode draws NO footer prompt, so the bottom row
      // is blank and the cursor parks there ⇒ classifyListScreen says 'prompt',
      // not 'article'. Live-verified 2026-08-16 on Steam: with only the three
      // checks above, the whole jump wedged here (probe → miss → 「切換看板失敗」),
      // which is exactly what a deep link opened from a cold start hits, every
      // time, on any board that has notes.
      //
      // Still 主功能表 in row 0 means we never left it (the s was swallowed, or
      // the board name was rejected): NOT a 進板畫面, and a ← there would only
      // move the highlight onto G)oodbye. Keep waiting → probe → visible miss.
      if (
        facts.kind === 'prompt' &&
        !isMainMenuRow(facts.rowTexts[0] || '')
      )
        return { dismiss: true };
      return false;
    };
  },

  _onBoardLanding: function(run, result, round) {
    if (result.landed) {
      this._enqueueMiddle(run);
      return;
    }
    if (round + 1 >= MAX_ENTER_DISMISS) {
      this._fail('進板畫面未關閉（' + run.target.board + '）');
      return;
    }
    this._enqueueEnterBoardDismiss(run, round + 1);
  },

  // The board is now open on its clean list: pick the step that parks the
  // cursor on the target article: #<aid>, or stop on the list (board anchor —
  // see nav_history.js for why there is no article-number tier).
  _enqueueMiddle: function(run) {
    // # 與跳號都要完整列表（子列表的 # 被拒、編號是另一個空間）。只停在列表的那幾種
    // 收尾（看板錨、goto）與重開游標上的原文（reopen）照舊留在子列表。
    if (run.onSubList && (run.target.aid || run.target.num != null)) {
      this._enqueueLeaveSubList(run);
      return;
    }
    if (run.target.aid) {
      this._enqueueAidSearch(run);
      return;
    }
    if (run.target.num != null) {
      this._enqueueNumJump(run);
      return;
    }
    // 挑板取消後重開原文：游標就停在原文上（reopenPicked）。
    if (run.dir === 'reopen') {
      this._enqueueOpen(run);
      return;
    }
    if (run.dir === 'goto') {
      if (run.target.end) this._enqueueEnd(run);
      else this._finishGoto(run);
      return;
    }
    if (run.dir === 'resume') {
      this._finishResumeAtList(run, 'done');
      return;
    }
    this._finishAtList(run);
  },

  _finishGoto: function(run) {
    this.active = false;
    this.opHint = null;
    recordFor(this._core).releaseExternal();
    this._history.invalidate();
    this._updateBackButton();
    this._hint('已進入 ' + run.target.board + ' 看板', 1200);
    this._endRun({ ok: true });
  },

  // `<編號>⏎`：落地指紋同 list_session 的 open-jump（游標停在該編號、在條目區、
  // 行首）。fullRepaint：跳到游標已在的那列時 server 零回應（見 list_session
  // _enqueueCursorSyncJump）。刪除文／鎖文按 ⏎ 開不出來 ⇒ 由 _enqueueOpen 逾時失敗。
  _enqueueNumJump: function(run) {
    const self = this;
    const num = run.target.num;
    this._queue.enqueue({
      keys: String(num) + '\r',
      kind: 'agent-num-jump',
      fullRepaint: true,
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      timeoutMs: STEP_PROBE_AFTER_MS,
      probeTimeoutMs: STEP_PROBE_WINDOW_MS,
      hardTimeoutMs: STEP_HARD_MS,
      expect: function(snapshot, facts) {
        if (!numJumpLanded(facts, num)) return false;
        return { cursorRowText: (facts.rowTexts || [])[facts.curY] || '' };
      },
      onDone: function(result) {
        // 子列表（startSubNum）：游標那一列要是呼叫端要的那篇才開（搜尋結果可能已經不是
        // 快照裡那一份）。認不出 ⇒ 停在列表。
        if (run.target.verify && !run.target.verify(result.cursorRowText)) {
          self._fail('第 ' + num + ' 篇已不是原本那篇');
          return;
        }
        // 回到原處只把游標放回那一篇，不開（編號會因刪文漂移，開錯篇比停在列表糟）。
        if (run.dir === 'resume') self._finishResumeAtList(run, 'done');
        // agent 列更舊的頁（startBoard opts.num）：停在列表，不開。
        else if (run.target.listOnly) self._finishGoto(run);
        else self._enqueueOpen(run);
      },
      onFail: function(reason) {
        // 回到原處：板已經進了，編號跳不到（文章被刪、編號超出）只是游標不在原篇，
        // 視野照樣還原（rebuild 只比板與編號空間）。
        if (run.dir === 'resume') {
          self._finishResumeAtList(run, 'done');
          return;
        }
        self._fail(reason === 'miss' ? '找不到第 ' + num + ' 篇' : '跳至第 ' + num + ' 篇逾時');
      }
    });
  },

  // End：停在板尾（置底文之後的最後一列）。落地指紋見 endLanded。
  _enqueueEnd: function(run) {
    const self = this;
    this._queue.enqueue({
      keys: '\x1b[4~',
      kind: 'agent-list-end',
      // 已在板尾時原生 End 零回應（list_session jump-end 同理）。
      fullRepaint: true,
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      timeoutMs: STEP_PROBE_AFTER_MS,
      probeTimeoutMs: STEP_PROBE_WINDOW_MS,
      hardTimeoutMs: STEP_HARD_MS,
      expect: function(snapshot, facts) {
        if (!endLanded(facts)) return false;
        run.endFacts = facts;
        return true;
      },
      onDone: function() {
        if (run.target.pinnedIndex != null) self._enqueuePinnedPick(run);
        else self._finishGoto(run);
      },
      onFail: function(reason) {
        self._fail('移到 ' + run.target.board + ' 板尾失敗（' + reason + '）');
      }
    });
  },

  // 板尾 → 第 pinnedIndex 篇置底：游標在最後一個非空列（endLanded），置底文排在一般
  // 文章之後（read.c 的 .DIR.bottom 接在 last_line 之後）⇒ 往上數 k 列就到。認不出
  // （畫面上沒有那一篇、游標不在它下方）就停手，不猜。
  _enqueuePinnedPick: function(run) {
    const self = this;
    const facts = run.endFacts;
    const rows = pinnedRowsOnScreen(facts);
    const target = rows[run.target.pinnedIndex];
    if (target == null || !facts || target > facts.curY) {
      this._fail('找不到 ' + run.target.board + ' 第 ' + (run.target.pinnedIndex + 1) + ' 篇置底文');
      return;
    }
    const steps = facts.curY - target;
    if (steps === 0) {
      this._enqueueOpen(run);
      return;
    }
    this._queue.enqueue({
      keys: '\x1b[A'.repeat(steps),
      kind: 'agent-pinned-pick',
      fullRepaint: true,
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      timeoutMs: STEP_PROBE_AFTER_MS,
      probeTimeoutMs: STEP_PROBE_WINDOW_MS,
      hardTimeoutMs: STEP_HARD_MS,
      expect: function(snapshot, f) {
        if (!f || f.curY !== target || f.curX > 1) return false;
        const e = parseListEntry((f.rowTexts || [])[target] || '');
        return !!(e && e.pinned);
      },
      onDone: function() {
        self._enqueueOpen(run);
      },
      onFail: function(reason) {
        self._fail('移到置底文失敗（' + reason + '）');
      }
    });
  },

  // Board-only anchor: pttbbs restored this board's cursor for us (getkeep,
  // mbbsd/read.c:105/1171), so the article we left is under the cursor — but
  // nothing here IDENTIFIES it, so the last keypress is the user's to make.
  _finishAtList: function(run) {
    this.active = false;
    const entry = this._history.commitBack();
    this._restoreListOf(entry);
    this._updateBackButton();
    this._hint(
      '已回到 ' + run.target.board + ' 看板，游標停在原文章（按 Enter 開啟）',
      6000
    );
  },

  // Step 1: s <board> ⏎ — the board-search jump. Lands on the target board's
  // clean list; a candidate menu / typo never satisfies the expect and ends as a
  // visible miss on the probed full frame.
  //   viaMenu=false: sent from INSIDE the article (pmore handles s directly,
  //     more.c:177 → Select() only). No 進板畫面 is possible → the expect stays
  //     exactly what it always was.
  //   viaMenu=true:  sent at 主功能表 after the escape preamble (menu.c:498 →
  //     ReadSelect() → do_select() + Read()), so the landing may be preceded by
  //     the board's 進板畫面 + pressanykey — dismissed by _onBoardLanding.
  //   dismissFirst: the Q post-info box is still up (its pressanykey is waiting
  //     for exactly one key), so the sequence is prefixed with a space — see
  //     KEY_DISMISS for why that key and not \f. Sent in the SAME write as the
  //     rest: pttbbs drains the whole input buffer without pausing, so the
  //     dismissal and the board switch land in one output burst and the screen
  //     never settles in between.
  _enqueueBoardJump: function(run, viaMenu, dismissFirst) {
    const self = this;
    const board = run.target.board;
    const boardLower = run.boardLower;
    this._queue.enqueue({
      keys: (dismissFirst ? KEY_DISMISS : '') + 's' + board + '\r',
      kind: 'aid-board-jump',
      fullRepaint: true,
      // The queue is SHARED with list_session, whose cleanup / native-mirror
      // switches / disconnect all call flush() — which is silent by contract
      // (no onFail). Without this hook the dropped step would leave `active`
      // stuck true forever and every keystroke swallowed at the term_view
      // entry point, with no way back.
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      timeoutMs: BOARD_PROBE_AFTER_MS,
      probeTimeoutMs: STEP_PROBE_WINDOW_MS,
      hardTimeoutMs: BOARD_HARD_MS,
      // 文章內的 s 從搜尋結果出發時落在目標板的搜尋結果（landedOnBoardList）；主功能表的
      // s 走 ReadSelect→Read()，新的 i_read 不繼承搜尋模式（read.c#i_read 開頭清 MODE_SELECT）。
      expect: viaMenu
        ? this._boardLandingExpect(boardLower)
        : function(snapshot, facts) {
            return landedOnBoardList(facts, boardLower);
          },
      onDone: function(result) {
        if (viaMenu) {
          self._onBoardLanding(run, result, 0);
          return;
        }
        run.onSubList = !!result.sub;
        self._enqueueMiddle(run);
      },
      onFail: function(reason) {
        self._fail('切換看板 ' + board + ' 失敗（' + reason + '）');
      }
    });
  },

  // continuePicked 的第一步：只送 \f 拿一幀整畫面，確認停在目標板的乾淨列表才送 #。
  // 不是（板名被 PTT 判成別的、進板失敗）就停手：在別的畫面送 # 會被當成別的指令。
  _enqueuePickedLanding: function(run) {
    const self = this;
    const boardLower = run.boardLower;
    this._queue.enqueue({
      keys: '',
      kind: 'aid-picked-landing',
      fullRepaint: true,
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      timeoutMs: STEP_PROBE_AFTER_MS,
      probeTimeoutMs: STEP_PROBE_WINDOW_MS,
      hardTimeoutMs: STEP_HARD_MS,
      expect: function(snapshot, facts) {
        return landedOnBoardList(facts, boardLower);
      },
      onDone: function(result) {
        run.onSubList = !!result.sub;
        self._enqueueMiddle(run);
      },
      onFail: function(reason) {
        self._fail('未進入看板 ' + run.target.board + '（' + reason + '）');
      }
    });
  },

  // 搜尋結果／文摘裡 # 被拒（read.c select_by_aid：MODE_SELECT 一律「此狀態下無法使用
  // 搜尋文章代碼(AID)功能」），編號也是子列表自己的空間 ⇒ 先 ← 回完整列表。子列表上的 ←
  // 是 read_cmd_quit 的「離開搜尋」分支（board_select＋游標留在同一篇的真實位置），
  // 不會離開看板；完整列表上的 ← 才是離板，所以只在認得出子列表時送。
  _enqueueLeaveSubList: function(run) {
    const self = this;
    const boardLower = run.boardLower;
    run.onSubList = false;
    run.leftSubList = true;
    this._queue.enqueue({
      keys: KEY_LEFT,
      kind: 'aid-leave-sublist',
      fullRepaint: true,
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      timeoutMs: STEP_PROBE_AFTER_MS,
      probeTimeoutMs: STEP_PROBE_WINDOW_MS,
      hardTimeoutMs: STEP_HARD_MS,
      expect: function(snapshot, facts) {
        const landed = landedOnBoardList(facts, boardLower);
        return landed && !landed.sub ? landed : false;
      },
      onDone: function() {
        self._enqueueMiddle(run);
      },
      onFail: function(reason) {
        self._fail('離開搜尋結果失敗（' + reason + '）');
      }
    });
  },

  // startSubNum 的第一步：文章內 ← 回到同一板的子列表（搜尋結果／文摘）。落在完整列表
  // （認不出的版本差異）不算：那裡的編號是另一個空間，等到逾時、停在 PTT 給的畫面。
  _enqueueBackToSubList: function(run) {
    const self = this;
    const boardLower = run.boardLower;
    this._queue.enqueue({
      keys: KEY_LEFT,
      kind: 'aid-back-sublist',
      fullRepaint: true,
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      timeoutMs: STEP_PROBE_AFTER_MS,
      probeTimeoutMs: STEP_PROBE_WINDOW_MS,
      hardTimeoutMs: STEP_HARD_MS,
      expect: function(snapshot, facts) {
        // 文章幀＝好讀自動翻頁還在線上的遲到回應（同 _enqueueEscape），繼續等。
        if (facts.kind === 'article') return false;
        const landed = landedOnBoardList(facts, boardLower);
        return landed && landed.sub ? landed : false;
      },
      onDone: function() {
        self._enqueueNumJump(run);
      },
      onFail: function(reason) {
        self._fail('回到搜尋結果失敗（' + reason + '）');
      }
    });
  },

  // Step 2: # <aid> ⏎ — the in-board AID search. Landing judgement (including
  // the ★pinned case) lives in aidSearchLanded, shared with long_push_session.
  _enqueueAidSearch: function(run) {
    const self = this;
    const aid = run.target.aid;
    this._queue.enqueue({
      keys: '#' + aid + '\r',
      kind: 'aid-search',
      fullRepaint: true,
      // The queue is SHARED with list_session, whose cleanup / native-mirror
      // switches / disconnect all call flush() — which is silent by contract
      // (no onFail). Without this hook the dropped step would leave `active`
      // stuck true forever and every keystroke swallowed at the term_view
      // entry point, with no way back.
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      timeoutMs: STEP_PROBE_AFTER_MS,
      probeTimeoutMs: STEP_PROBE_WINDOW_MS,
      hardTimeoutMs: STEP_HARD_MS,
      expect: function(snapshot, facts) {
        return aidSearchLanded(facts);
      },
      onDone: function() {
        self._enqueueOpen(run);
      },
      onFail: function(reason) {
        // Going back, a miss means the post is really gone (deleted) — a
        // PINNED post is findable, see aidSearchLanded. There is no number
        // to fall back to by design: say so and stay on the board's list.
        // (_finishAtList's 「游標停在原文章」 would be a lie: the cursor is
        // wherever the failed search left it.)
        if (run.dir === 'back' && reason === 'miss') {
          self.active = false;
          // 停在原文章的看板列表：列表視野回到當初離開時（只比板與編號空間，
          // 游標停在哪由失敗的搜尋決定）。
          self._restoreListOf(run.target);
          self._history.abort();
          self._updateBackButton();
          self._hint(
            '找不到原文章 #' + aid + '（可能已被刪除），已停在 ' + run.target.board + ' 列表',
            6000,
            HINT_ERROR
          );
          return;
        }
        // 回到原處：原文不見了 ⇒ 停在該板列表，列表視野回到斷線前（決策表 fail）。
        if (run.dir === 'resume' && reason === 'miss') {
          self._finishResumeAtList(
            run,
            'fail',
            '找不到斷線前的文章 #' + aid + '（可能已被刪除），已停在 ' + run.target.board + ' 列表',
            HINT_ERROR
          );
          return;
        }
        self._fail(
          reason === 'miss' ? '找不到文章 #' + aid : 'AID 搜尋逾時'
        );
      }
    });
  },

  // Step 3: ⏎ opens the article under the cursor. The article settle also
  // drives the normal handoffs (list session → suspended; easy reading
  // re-enters on its settled edge), so finishing here is just an unlock.
  _enqueueOpen: function(run) {
    const self = this;
    this._queue.enqueue({
      keys: '\r',
      kind: 'aid-open',
      fullRepaint: true,
      // The queue is SHARED with list_session, whose cleanup / native-mirror
      // switches / disconnect all call flush() — which is silent by contract
      // (no onFail). Without this hook the dropped step would leave `active`
      // stuck true forever and every keystroke swallowed at the term_view
      // entry point, with no way back.
      onFlushed: function() {
        self._fail('畫面已變更');
      },
      timeoutMs: STEP_PROBE_AFTER_MS,
      probeTimeoutMs: STEP_PROBE_WINDOW_MS,
      hardTimeoutMs: STEP_HARD_MS,
      expect: function(snapshot, facts) {
        if (facts.kind === 'article') return true;
        // Some posts open straight onto a short page whose bottom row is the
        // reading status row even if the classifier hesitates — accept that too.
        const lastRow = facts.rowTexts[facts.rows - 1] || '';
        return !!parseStatusRow(lastRow);
      },
      onDone: function() {
        if (run.dir === 'refresh') {
          // 同下面的 ORDER INVARIANT：_finishRefresh 先解鎖 active 再交給好讀。
          self._finishRefresh(run);
          return;
        }
        self.active = false;
        // ORDER INVARIANT: unlock `active` FIRST, then hand over to easy reading.
        // easy_reading._send's first gate is `if (aidNavigation.active) return`, so
        // calling enterEasyReading() before the unlock would let the PageDown its
        // replayed notify queues be swallowed whole — the article would sit on page
        // one with the paging transaction already marked in-flight.
        //
        // And BEFORE requestScrollRestore below: the restore is driven by
        // _onViewUpdated, which only runs while easy reading is accumulating.
        //
        // Why this call is needed at all: the target article arrives on a 0→3
        // settle edge (the preceding AID-search screen has a blank footer row —
        // see _enqueueAidSearch — so it settles as pageState 0), which
        // nextEasyReadingState deliberately does not accept. See
        // nextEasyReadingExternalLanding.
        if (self._core.easyReading && self._core.easyReading.ensureEnabledOnArticle)
          self._core.easyReading.ensureEnabledOnArticle(true);
        // Only here — with the article really open — does the stack move.
        if (run.dir === 'back') {
          const entry = self._history.commitBack();
          self._updateBackButton();
          // Reading position: easy reading re-reads the article from the top
          // and grows it page by page, so this is a REQUEST that lands once
          // enough of the post has accumulated (easy_reading#requestScrollRestore).
          // 決策表 'aid-back' done ＝ 'origin'，列從返回錨帶。身後的列表也換回這篇
          // 當初的那一份（使用者接著按 ← 回列表時還原）。
          const rr = recordFor(self._core);
          if (entry) {
            rr.end({ feature: 'aid-back' }, 'done', { only: 'article', article: entry });
            rr.noteBehindList(entry.list || null);
          }
          self._hint('已返回 ' + (entry ? entry.label : ''), 1200);
        } else if (run.dir === 'resume') {
          self.opHint = null;
          self._resuming = false;
          // 決策表 'reconnect-resume' done：文章 'auto'（斷線前在文末就黏回文末，否則
          // 原列）。好讀的還原是請求，累積到位才套用。
          recordFor(self._core).end(run.bookmark, 'done', { only: 'article' });
          self._updateBackButton();
          self._hint('已回到斷線前的文章', 1500);
        } else if (run.dir === 'reopen') {
          self.opHint = null;
          // 決策表 'aid-board-pick' cancel：回原列（好讀的還原是請求，累積到位才套用）。
          recordFor(self._core).end(run.bookmark, 'cancel', { only: 'article' });
          self._updateBackButton();
          self._hint('已回到原文', 1200);
        } else if (run.dir === 'goto') {
          self.opHint = null;
          self._history.invalidate();
          self._updateBackButton();
          self._hint('已開啟第 ' + run.target.num + ' 篇', 1200);
        } else {
          self._history.commitJump();
          self._updateBackButton();
          // Replace the long-lived "跳至…" progress banner (15s) with a short
          // confirmation so it fades right away instead of lingering into the
          // opened article.
          self._hint('已跳至 #' + run.target.aid, 1200);
        }
        recordFor(self._core).releaseExternal();
        self._endRun({ ok: true });
      },
      onFail: function(reason) {
        self._fail('開啟文章失敗（' + reason + '）');
      }
    });
  }
};

export default AidNavigation;
