import { parseStatusRow } from './string_util';
import { readValuesWithDefault } from './pref_storage';
import { ACT_EXIT_ARTICLE } from './mouse_regions';
import { TRACE } from './util';

// Pure decision for auto-enabling easy reading, evaluated once per settle edge
// (term_buf 'pageStateSettled'), not per redraw frame. Kept side-effect free so it
// can be regression-tested in tests/unit/easy_reading_logic.test.js.
//
// It operates on term_buf's DEBOUNCED pageState stream: settledPageState only
// advances once the screen has been quiet for SETTLE_MS, so the transient
// half-painted frames (empty last row -> pageState 0) that PTT emits while painting
// an article never appear here. That lets us use a clean, edge-correct "settled into
// an article (3) from a list/menu" check without the transient-frame race the old
// `cameFromList` latch had to work around. Because it is edge-triggered (the caller
// only invokes it on a settle transition), the in-post flicker after
// switchToNativeAtBottom (still pageState 3, settled stays 3 → no new edge) can no
// longer re-enable against the user's choice; likewise a pass/edit/normal screen
// (5/6/0) is excluded, so e.g. returning from in-article help does not re-enable.
// See docs/easy-reading.md.
export function nextEasyReadingState({ settledPageState, prevSettledPageState, enabled, enablePref, supported, navActive }) {
  // navActive：AID 跳文／deep link 正在驅動畫面。導航途中的每一張畫面都是「別人
  // 的」—— 尤其進板畫面是不折不扣的 pmore（與文章同形，pageState 3），在主功能表
  // (1) 之後就構成一個 1→3 edge，好讀會把進板公告當成文章開始累積（送鍵雖然被
  // _send 的閘門擋住，_enabled 卻已經被翻成 true）。目標文章的落地改由
  // ensureEnabledOnArticle 負責 —— 只有它知道哪一張畫面才是真的目標。
  if (navActive) return false;
  // Re-enable when we settled INTO an article (3) FROM a screen you open articles
  // from: a board LIST (2) or a MENU (1). The 1 covers 精華區 (essence): its top
  // level (首列【精華文章】) settles to MENU(1) and sub-folder listings to MENU(1)
  // or LIST(2) — both let you Enter straight into an article. Without the 1, after
  // switchToNativeAtBottom inside 精華區 the next article arrives on a 1->3 (not
  // 2->3) edge, so easy reading never re-enabled — stuck native until you backed out
  // to a real board list. 主功能表/分類看板 are also MENU(1) but you can't open an
  // article directly from them (you pass through a board LIST first), so a 1->3 edge
  // in practice only comes from 精華區.
  return settledPageState === 3 &&
    (prevSettledPageState === 2 || prevSettledPageState === 1) &&
    !enabled && enablePref && supported;
}

// Pure decision for the SECOND auto-enable route: easy reading is off because the user
// switched to native inside a post (the End/F8 key), and the screen has now settled on
// the FIRST page of a DIFFERENT post. nextEasyReadingState cannot see this — `[`/`]`/
// `a`/`b`/`f`/`=` keep pageState at 3 the whole way, so there is no settle edge at all,
// and easy reading stayed off until the user went back through a list. That is the
// "半永久原生模式" report.
//
// Keyed on article IDENTITY, deliberately not on a pageState edge:
//   - docs/easy-reading.md forbids treating "dipped out of 3 and came back" as a new
//     article (a mid-article status-row misparse does exactly that, and re-enabling
//     there would re-send a PageDown for the same page — the P4 duplicate);
//   - the one false positive an edge-based rule cannot exclude is the user pressing
//     native Home/0/g back to line 1 of the SAME post. Comparing the header rows kills
//     it outright.
// `articleKey` = the post's 作者/標題/時間 rows; row 0 alone collides on an `a`
// (same-author) jump. `nativeArticleKey` is the key of the post the user switched away
// from — see _applyRowState for where it is captured (every CONFIRMED first page, not
// once per enterEasyReading: that older single capture point stored the WRONG post on
// two paths and made the comparison below vacuous, which is the 「原生下按 Home 就被切
// 回好讀」 report).
//
// Both keys must be KNOWN — this route exists solely for "the user switched to native
// themselves and has since jumped elsewhere", so not knowing which post they switched
// away from means staying native (the hotkey is always there). Treating an unknown
// `nativeArticleKey` as "easy reading was never on here ⇒ re-enable" is fail-OPEN: any
// missed capture turns a same-post native Home back into a false re-entry. The ordinary
// list→article enable is nextEasyReadingState's job, not this one's.
export function nextEasyReadingReentry({
  pageState, complete, enabled, enablePref, supported, functionMode,
  statusStart, articleKey, nativeArticleKey, navActive
}) {
  if (enabled || !enablePref || !supported || functionMode || navActive) return false;
  if (pageState !== 3 || !complete) return false;
  if (statusStart !== 1) return false;          // only ever on a post's first page
  if (!articleKey || !nativeArticleKey) return false;  // can't tell → stay native
  return articleKey !== nativeArticleKey;
}

// 第三條自動開好讀的路線：**外部導航 run 的落地**（aid_navigation._enqueueOpen 的
// onDone —— 全專案唯一「run 確定落在目標文章上」的點）。另外兩條在這裡結構性地
// 不可能成立：
//
//   - nextEasyReadingState 要的是 settled 1|2 → 3 edge，但文章的前一步是 AID 搜尋
//     落地，而 pttbbs 把那張畫面的 footer 列留成空白（見 aid_navigation
//     ._enqueueAidSearch 的註解：# prompt 清掉它、跳轉重畫不補、\f 也補不回來）
//     ⇒ term_buf.setPageState 末段的 isLineEmpty 分支 ⇒ pageState 0 ⇒ 目標文章是
//     踩著 0→3 進來的，edge 永遠不成立。
//   - nextEasyReadingReentry 要 nativeArticleKey 已知，而冷啟動 deep link 從來沒
//     開過任何一篇文章，那個 key 必然是 null（fail-safe 設計，不能為此放寬）。
//
// 刻意**不是**去放寬 nextEasyReadingState 的 edge 條件（「0→3 也算」）：文章中途
// 任何一次 prompt／編輯器／footer 半畫的 dip 都會產生 3→0→3，那會在同一頁重新
// enterEasyReading（它會 _resetPagingState 清掉 _inFlightSig）並重送一次 PageDown
// ⇒ pttbbs typeahead skip ⇒ 整頁文字永久遺失（P4）。docs/easy-reading.md 明文禁止。
// 所以本路線 edge-free 但**一次性**：只由導航自己的落地 callback 觸發。
//
// `enabled` 那道 gate 是整個設計最不能拿掉的一行：既有 edge 路線若已經開了好讀，
// 這裡必須是 no-op，否則就是上面說的那個重複 enterEasyReading。
export function nextEasyReadingExternalLanding({
  pageState, complete, statusStart, enabled, enablePref, supported, navActive
}) {
  if (enabled || !enablePref || !supported || navActive) return false;
  if (pageState !== 3 || !complete) return false;
  return statusStart === 1;   // 只認文章第一頁：從中途頁開始累積會少掉前面的內容
}

// Pure per-frame row-state machine for _onChanged: given the current pageState and
// cursor position (the status-row parse is computed by the caller and passed in as a
// boolean, keeping this free of string_util/DOM), decide the next easy-reading render
// state. Returns the next flag values plus three control signals: `pageStateOverride`
// (5 when a non-article "press any key" screen is detected, else null),
// `consumeIgnoreOneUpdate` (clear the one-shot suppression), and `halt` (the caller had
// an early return here — purely informational now since nothing follows the apply).
// Side-effect free so the branchy logic is regression-tested in
// tests/unit/easy_reading_logic.test.js.
//
// 只認「游標停在末列末欄」的完整幀：文章內的 prompt / 選單 / 編輯器一律由 functionMode
// 鏡像原生畫面處理（_onKeyDownProcessUI 對任何單字元鍵都先 _enterFunctionMode，而
// _onChanged 在 functionMode 下直接 return），所以這裡不需要、也不應該再去辨識
// 推文輸入列 / 回應選單那類 prompt 幀。
export function nextEasyReadingRowState({
  pageState, startedEasyReading,
  reachedPageEnd, sendCommandAfterUpdate, ignoreOneUpdate,
  curX, curY, lastRowNum, lastColNum,
  isStatusRow, lastRowFirstChFg, lastRowFirstChBg, pagePercent
}) {
  let pageStateOverride = null;
  let consumeIgnoreOneUpdate = false;
  let halt = false;

  // dealing with page state jump to 0 because last row wasn't updated fully
  startedEasyReading = (pageState == 3);

  if (startedEasyReading) {
    if (curY == lastRowNum && curX == lastColNum) {
      if (ignoreOneUpdate) {
        consumeIgnoreOneUpdate = true;
        halt = true;
      } else if (isStatusRow) {
        // 「已看完整篇」的判準（pttbbs @ efc21a30）：
        //
        // 主判準 = footer 的百分比（P3）。mf_display_footer 算
        //   progress = (int)((dispe - start) * 100 / len)
        // 整數除法使 progress==100 ⟺ dispe >= end ⟺ mf_viewedAll()，**完全等價**。
        //
        // 次判準 = footer 第一段的配色（mf_display_footer 依 mf_viewedAll()/
        // mf_viewedNone() 選色）：
        //   PMORE_COLOR_FOOTER1_VIEWALL  ANSI_COLOR(37;44) → fg 7 / bg 4 ← 這裡
        //   PMORE_COLOR_FOOTER1_VIEWNONE ANSI_COLOR(33;45) → fg 3 / bg 5
        //   PMORE_COLOR_FOOTER1          ANSI_COLOR(34;46) → fg 4 / bg 6
        // 保留為 fallback（pagePercent 拿不到時），但**不再是主判準**：pfterm 是
        // per-cell dirty 更新（P6），(rows-1, 0) 這一格只有在真的變色時才會重畫，
        // 用單一格的顏色推論全域狀態比讀百分比脆弱。
        if (pagePercent >= 100 ||
            (pagePercent == null && lastRowFirstChBg == 4 && lastRowFirstChFg == 7)) {
          reachedPageEnd = true;
        } else {
          reachedPageEnd = false;
          if (!sendCommandAfterUpdate) {
            // send page down
            sendCommandAfterUpdate = '[6~';
          }
        }
      } else {
        pageStateOverride = 5;
        startedEasyReading = false;
      }
    } else {
      // 游標不在末列末欄 ⇒ 這一幀不是「PTT 畫完、正在等輸入」的完整文章畫面
      // （半畫好的幀、或 prompt 幀——後者已由 functionMode 接手）。什麼都不做。
      halt = true;
    }
  }

  return {
    startedEasyReading, reachedPageEnd,
    sendCommandAfterUpdate, pageStateOverride, consumeIgnoreOneUpdate, halt
  };
}

// How many times the recovery path may re-send a PageDown that produced no response.
export const PAGE_DOWN_MAX_RETRIES = 1;

// How long after OUR OWN send a recovery trigger must wait before it may conclude the
// key was lost. See nextPageDownDecision's `recovery` note for why the settle event
// alone is not evidence of a lost key.
//
// 600ms ≈ 3x the worst frame cycle and ~8x the worst send→receive RTT observed in the
// 4700-line recording (ptt-debug-20260809). The two error costs are wildly asymmetric:
// too short ⇒ a duplicate key ⇒ P4 ⇒ a page lost for good; too long ⇒ one extra pause
// in the rare genuinely-lost-key case, invisible next to the 200ms frame period a long
// article already has. Deliberately a constant, not an adaptive RTT estimate: the only
// measurable input (settle latency) is itself polluted by render time, and a moving
// threshold makes the decision untestable. Tune it from recordings — _maybeSendPageDown
// logs sinceSentMs on every non-send/wait action.
export const PAGE_DOWN_GRACE_MS = 600;

// Precise gap seeks allowed per article before falling back to the whole-article
// re-read. A seek costs one round trip and keeps everything already accumulated, so it
// is worth retrying a few times; the Home fallback costs the entire article.
export const HEAL_GOTO_MAX = 3;

// Pure decision for the auto page-down loop, expressed as a SINGLE IN-FLIGHT
// request/response transaction. See docs/pttbbs-screen-protocol.md §13.
//
// WHY a transaction and not "send whenever the screen looks ready":
//   P4 — pfterm.c#refresh returns WITHOUT drawing while the client still has keys in
//   pttbbs' input buffer (`if (ft.typeahead && fterm_typeahead()) return;`). So if a
//   second PageDown reaches PTT while it is still drawing the answer to the first, the
//   intermediate screen is never sent — that page's text is lost for good. This is the
//   "※ 發信站 / ※ 文章網址 那段消失" report: not a parse bug, a lost screen.
//   The previous code only deduped on the settle path; the fast path (_onViewUpdated)
//   recorded the page signature but never checked it, so any second "complete-looking"
//   frame on the SAME page (functionMode resume's forced notify, a waterball repaint,
//   any other forced notify) fired a duplicate PageDown.
//
// The response ack is the page SIGNATURE — the status row's "第 S~E 行" range, which
// changes on every successful page-down (P1/P2). While it still equals what we sent
// from, the response has not arrived and we must not send again.
//
//   P3 — progress==100 ⟺ mf_viewedAll() (the integer division makes them exactly
//   equivalent), and PMORE_UINAV_FORWARDPAGE returns immediately when viewedAll, i.e.
//   PTT answers a PageDown at the bottom with COMPLETE SILENCE. So percent is the
//   authoritative "stop" signal — more robust than the footer's first-cell colour,
//   which pfterm only repaints when that cell actually changes (P6).
//
//   P6 — only a frame whose cursor is parked at (rows-1, cols-1) is a complete server
//   response; anything else still carries the previous page's footer.
//
// `recovery` marks a path that is ALLOWED to re-send: the settle event, or the
// send-anchored watchdog (_armWatchdog). A resend is only safe once PTT has flushed and
// is blocked in dogetch, with no in-flight repaint left for the key to be swallowed by.
//
// `sinceSentMs` — ms since WE sent the outstanding key — is what actually establishes
// that. The settle event does NOT: term_buf's settle timer is armed by the frames that
// arrived BEFORE our send, and on a long article (4600+ accumulated rows) the React
// render pushes its callback out past our own send, so the quiet period it measured
// says nothing about whether PTT answered us. That is the 4700-line "自動跳回第一頁"
// report: settle fired 77ms after the send, in the same millisecond the answer arrived,
// concluded the key was lost, and the duplicate PageDown cost a whole page to P4 —
// which the gap self-heal then "fixed" by re-reading the article from line 1.
//
// null sinceSentMs is treated as elapsed (fail-open): the caller always stamps it
// alongside inFlightSig, and a missing stamp must never wedge the transaction.
// Returns the next state alongside the action so the caller stays a thin shim.
export function nextPageDownDecision({
  enabled, functionMode, complete, isStatusRow, pagePercent,
  sig, inFlightSig, retries, recovery, sinceSentMs, graceMs
}) {
  const keep = { action: 'none', inFlightSig, retries, reachedPageEnd: undefined };
  if (!enabled || functionMode || !complete || !isStatusRow || sig == null)
    return keep;
  if (pagePercent >= 100)
    return { action: 'done', inFlightSig: null, retries: 0, reachedPageEnd: true };
  if (inFlightSig != null && sig === inFlightSig) {
    const elapsed = sinceSentMs == null ? Infinity : sinceSentMs;
    const grace = graceMs == null ? PAGE_DOWN_GRACE_MS : graceMs;
    if (!recovery || elapsed < grace)
      return { action: 'wait', inFlightSig, retries, reachedPageEnd: false };
    if (retries < PAGE_DOWN_MAX_RETRIES)
      return { action: 'retry', inFlightSig, retries: retries + 1, reachedPageEnd: false };
    return { action: 'giveup', inFlightSig, retries, reachedPageEnd: false };
  }
  return { action: 'send', inFlightSig: sig, retries: 0, reachedPageEnd: false };
}

// Pure decision for leaving functionMode, evaluated on each settle (screenSettled)
// while functionMode is on. Side-effect free so it can be regression-tested.
//   'resume' — back to a clean article reading page (status row at the bottom with the
//              cursor parked on it): turn functionMode off and resume the accumulated
//              long page (same article).
//   'leave'  — the screen settled into a board LIST (2) or MENU (1): the user navigated
//              out of the post; drop easy-reading per-post state and let the normal
//              settle re-enable pick up the next article.
//   'stay'   — anything else (the prompt/menu is still up, or an editor/pass screen
//              5/6/0, or a transient): keep mirroring native.
export function functionModeExitDecision({ pageState, isStatusRow, curY, lastRowNum }) {
  if (pageState === 3 && isStatusRow && curY === lastRowNum) return 'resume';
  if (pageState === 1 || pageState === 2) return 'leave';
  return 'stay';
}

// 「關設定頁」要對好讀做哪些事——App.switchToEasyReadingMode 的純決策（unit 守護：
// tests/unit/switch_mode_plan.test.js）。
//
// PrefModal 的 X／點空白／Esc 全部匯流到 onPrefSaveImpl → switchToEasyReadingMode(
// view.useEasyReadingMode)。它原本無條件重置（leaveCurrentPost + 清 pageLines），但
// 使用者可能正停在 PTT 的 prompt 上（X 推文、r 回應、y 收暫存檔…），此時好讀在
// functionMode 鏡像原生畫面。重置會清掉 _functionMode ⇒ ^L 回來的整頁重繪落進好讀
// 文章分支 ⇒ 但游標停在輸入欄（不是 (rows-1, cols-1)）⇒ accumulatePageLines 的 P6
// gate 判 complete=false ⇒ decideAccumulateBranch 回 'skip' ⇒ pageLines 維持 []
// ⇒ 渲染 0 列 ⇒ **整頁全黑**，且之後每一幀游標都在 prompt 上，永遠回不來（實測 100%
// 複現，只能離開文章再進）。所以鏡像原生時只重繪，什麼狀態都不准動。
//
//   leavePost        — easyReading.leaveCurrentPost()（含清 _functionMode）
//   restoreNativeView— 還原 overlay 列／底部 padding（好讀關掉時）
//   clearPageLines   — 丟掉累積長頁
//   cursorNudge      — 送 \x1b[D\x1b[C（原本用來把文章畫面推一下）；在 prompt 上那是
//                      vgets 的左右移游標（實測回 BEL），一個 byte 都不該多送。
// ^L 一律送：pttbbs 的 system_key_hook 把 Ctrl('L') 攔成 redrawwin()+refresh() 並回
// KEY_INCOMPLETE（mbbsd/io.c），prompt 底下也只是重繪，不會被當成輸入內容。
export function switchModePlan({ doSwitch, functionMode, pageState }) {
  if (doSwitch && functionMode)
    return { leavePost: false, restoreNativeView: false, clearPageLines: false, cursorNudge: false };
  return {
    leavePost: true,
    restoreNativeView: !doSwitch,
    clearPageLines: true,
    cursorNudge: !!doSwitch && pageState === 3
  };
}

export function EasyReading(core, view, termBuf) {
  this._core = core;
  this._view = view;
  this._termBuf = termBuf;

  this._turnPageLines = 22;

  this.easyReadingReachedPageEnd = false;
  this.sendCommandAfterUpdate = '';
  this.ignoreOneUpdate = false;
  // Auto-paging transaction state (see nextPageDownDecision). _inFlightSig = the page
  // signature ("第 a~b 行" range) we issued the outstanding PageDown FROM, or null when
  // idle; the response is acked by the signature CHANGING. BOTH the fast path
  // (_onViewUpdated) and the settle recovery (_onScreenSettled) go through it, so a
  // duplicate PageDown — which pttbbs' typeahead skip turns into a permanently lost
  // page (P4) — is impossible. Reset per article (enterEasyReading / leaveCurrentPost).
  this._inFlightSig = null;
  this._pageDownRetries = 0;
  // The exact bytes of the outstanding request, and when they went out. The watchdog
  // re-sends _inFlightKeys (never the caller's keys — the transaction may be a gap
  // heal, not a PageDown), and sinceSentMs is the ONLY evidence that a key was lost;
  // see nextPageDownDecision.
  this._inFlightKeys = null;
  this._inFlightSentAt = null;
  // Send-anchored recovery timer. term_buf's settle timer is re-armed only by SERVER
  // activity (term_buf.notify → _armSettleTimer), so a key that PTT never answered
  // produces no further settle at all — grace-gating the settle path without this
  // would turn a false retry into a permanent stall.
  this._watchdogTimer = null;
  this._watchdogSig = null;
  // 被 _wireBusy 延後的那一次自動翻頁請求（bytes），等 onWireIdle 補送。這不是
  // 「已送出」的 in-flight，所以刻意跟 _inFlightKeys 分開放。per-article：
  // _resetPagingState 會清掉它。
  this._deferredPageDownKeys = null;
  // Gap self-heal budget, per article (see _healGap): a few cheap precise seeks, then
  // one expensive re-read from the top, then give up — bounded so a pathological
  // article can never loop.
  this._healGotoCount = 0;
  this._healHomeUsed = false;
  // functionMode: while the user is interacting with a native PTT prompt/menu/editor
  // triggered from inside the article (r 回應、X/% 推文、y 收暫存檔…), we stop the
  // easy-reading accumulation/overlay illusion and mirror the native 24-row screen
  // LIVE so whatever PTT draws appears exactly as native. Entered key-driven
  // (_onKeyDownProcessUI default → _enterFunctionMode), exited by content judgement on
  // settle (_evalFunctionModeExit). buf.pageLines is preserved throughout so the
  // accumulated long page resumes without re-paging. See docs/easy-reading.md.
  this._functionMode = false;
  this._savedScrollTop = null;
  // One-shot reading-position restore for an AID back run (requestScrollRestore).
  // Deliberately NOT _savedScrollTop: that one is the functionMode round trip and
  // is cleared by every enter/leave, so it cannot survive across articles.
  this._pendingScrollRestore = null;
  // One-shot retry for the external-landing enable (ensureEnabledOnArticle): the
  // navigation's onDone fires before the screen is necessarily complete, so it may
  // ask to be re-evaluated on the NEXT settle — once, then dropped.
  this._pendingEnableOnArticle = false;
  // Article identity (作者/標題/時間 rows) — see nextEasyReadingReentry. _articleKey is
  // re-read on every confirmed first-page frame while easy reading is on (_applyRowState,
  // which is the only capture point that covers all the ways a post becomes current);
  // _nativeArticleKey is the one we left behind on a switch-to-native, and is what tells
  // "another post" apart from "the same post, scrolled back to the top by a native Home".
  // null on either side means "unknown" and blocks the re-entry route (fail-safe).
  this._articleKey = null;
  this._nativeArticleKey = null;

  function bindProperty(target, name, obj, prop) {
    if (!prop) prop = name;
    Object.defineProperty(obj, prop, {
      get: function() { return target[name]; },
      set: function(val) { target[name] = val; }
    });
  }
  bindProperty(this._view, 'useEasyReadingMode', this, '_enabled');
  bindProperty(this._termBuf, 'startedEasyReading', this);
  // Exposed on term_buf so term_view.redraw / onKeyDown can read it (mirrors
  // startedEasyReading above). Setting this._functionMode writes buf.easyReadingFunctionMode.
  bindProperty(this._termBuf, 'easyReadingFunctionMode', this, '_functionMode');

  this._termBuf.addEventListener('change', this._onChanged.bind(this));
  this._termBuf.addEventListener('viewUpdate', this._onViewUpdated.bind(this));
  // Auto re-enable is driven by the debounced pageState (see nextEasyReadingState),
  // fired once per settle edge — not by every per-frame 'change'.
  this._termBuf.addEventListener('pageStateSettled', this._onPageStateSettled.bind(this));
  // Settle-driven page-down recovery: 'screenSettled' fires every quiet window (even
  // while pageState stays 3), catching the case where the per-frame loop stalled
  // because the cursor parked on the status row in a content-less (changed=false)
  // frame _onChanged never sees. See _onScreenSettled and docs/easy-reading.md.
  this._termBuf.addEventListener('screenSettled', this._onScreenSettled.bind(this));
};

// Fired once per term_buf settle edge. Auto-enable easy reading when we have just
// settled from a board list (2) into an article (3) with the pref on.
EasyReading.prototype._onPageStateSettled = function() {
  // ARTICLE BOUNDARY — the only structural place the per-article paging transaction is
  // guaranteed to be reset. Do NOT rely on the key handlers for this: ← leaves an
  // article through stopEasyReading() (never leaveCurrentPost), and while easy reading
  // is already on, opening the next article does NOT go through enterEasyReading()
  // either (nextEasyReadingState requires !enabled). So the previous article's state
  // used to follow the user into the next one, wedging it permanently — see
  // _resetPagingState.
  //
  // Edge-scoped on purpose (3 <-> list/menu only). A mid-article dip (footer caught
  // half-repainted → pageState 0/5 for one settle) must NOT reset: dropping
  // _inFlightSig there would let the SAME page be paged down twice, which is exactly
  // the typeahead-skip page loss (P4) the transaction exists to prevent.
  const settled = this._termBuf.settledPageState;
  const prevSettled = this._termBuf.prevSettledPageState;
  const enteringArticle = settled === 3 && (prevSettled === 1 || prevSettled === 2);
  const leavingArticle = prevSettled === 3 && (settled === 1 || settled === 2);
  if (enteringArticle || leavingArticle)
    this._resetPagingState();

  const values = readValuesWithDefault();
  const shouldEnable = nextEasyReadingState({
    settledPageState: this._termBuf.settledPageState,
    prevSettledPageState: this._termBuf.prevSettledPageState,
    enabled: this._enabled,
    enablePref: values.enableEasyReading,
    supported: this._core.connectedUrl.easyReadingSupported,
    navActive: this._navActive()
  });
  if (shouldEnable) {
    this.enterEasyReading();
  }
};

// AID 跳文／deep link 正在驅動畫面嗎？導航途中的畫面不屬於使用者的閱讀動線，
// 兩條自動開好讀的路線都要避開它（見 nextEasyReadingState 的 navActive 註解）。
EasyReading.prototype._navActive = function() {
  const nav = this._core.aidNavigation;
  return !!(nav && nav.active);
};

EasyReading.prototype._onChanged = function(e) {
  if (TRACE)
    console.log("page state: " + this._termBuf.prevPageState + "->" + this._termBuf.pageState);
  const values = readValuesWithDefault()
  // Auto-enable is handled on the settle edge (_onPageStateSettled, see
  // nextEasyReadingState). Here we only react to the pref being turned off
  // mid-post: flipping _enabled alone would switch back to the React renderScreen
  // path while #mainContainer still holds the DOM that easy reading mutated
  // directly, so React keeps updating detached Row nodes and the view freezes.
  // Run the full exit recipe instead.
  if (!values.enableEasyReading && this._enabled) {
    this.exitEasyReading();
  }

  if (!this._enabled)
    return;

  // functionMode mirrors the native screen LIVE (term_view.redraw handles rendering);
  // the auto-paging row-state machine must NOT run here (no page-downs while a prompt
  // is up). Exit is decided on settle by _evalFunctionModeExit.
  if (this._functionMode)
    return;

  this._applyRowState(this._computeRowState());
};

// Run the pure per-frame row-state machine against the CURRENT term_buf state.
// Reads the live cursor / last-row parse, returns the rowState the caller applies.
// Shared by _onChanged (fast path, per redraw frame) and _onScreenSettled (recovery,
// per quiet window) so both drive the exact same decision.
EasyReading.prototype._computeRowState = function() {
  const lastColNum = this._termBuf.cols - 1;
  const lastRowNum = this._termBuf.rows - 1;
  const lastRowText = this._termBuf.getRowText(lastRowNum, 0, this._termBuf.cols);
  const lastRowFirstCh = this._termBuf.lines[lastRowNum][0];
  const status = parseStatusRow(lastRowText);
  const rowState = nextEasyReadingRowState({
    // P3: progress==100 ⟺ mf_viewedAll(). Authoritative "already at the bottom" signal;
    // the footer colour below stays only as a fallback (see nextEasyReadingRowState).
    pagePercent: status ? status.pagePercent : null,
    pageState: this._termBuf.pageState,
    startedEasyReading: this.startedEasyReading,
    reachedPageEnd: this.easyReadingReachedPageEnd,
    sendCommandAfterUpdate: this.sendCommandAfterUpdate,
    ignoreOneUpdate: this.ignoreOneUpdate,
    curX: this._termBuf.cur_x,
    curY: this._termBuf.cur_y,
    lastRowNum,
    lastColNum,
    isStatusRow: !!status,
    lastRowFirstChFg: lastRowFirstCh.getFg(),
    lastRowFirstChBg: lastRowFirstCh.getBg()
  });
  // Carried alongside the pure result (not an input to it): _applyRowState needs to know
  // whether this frame is a post's FIRST page to refresh the article identity, and the
  // status row is already parsed here — no second parse. See _applyRowState.
  rowState.statusStart = status ? status.rowIndexStart : null;
  return rowState;
};

// Apply a computed rowState back onto term_buf / this. Idempotent on a stable frame.
EasyReading.prototype._applyRowState = function(rowState) {
  this.startedEasyReading = rowState.startedEasyReading;
  this.easyReadingReachedPageEnd = rowState.reachedPageEnd;
  this.sendCommandAfterUpdate = rowState.sendCommandAfterUpdate;
  if (rowState.consumeIgnoreOneUpdate)
    this.ignoreOneUpdate = false;
  if (rowState.pageStateOverride !== null)
    this._termBuf.pageState = rowState.pageStateOverride;
  // ARTICLE IDENTITY — the 作者/標題/時間 header is only on screen on a post's FIRST
  // page, so re-read it on every confirmed first-page frame. This is the ONLY point
  // that covers all three ways a post becomes "the current post":
  //   - settle edge list/menu → article (enterEasyReading, then its replayed notify);
  //   - `[` `]` `a` `b` `f` `=` jumps, which do NOT go through enterEasyReading at all
  //     (nextEasyReadingState requires !enabled — see _onPageStateSettled);
  //   - the Home landing frame after reenterFromTop (the F8 toggle enters easy reading
  //     while still MID-post, where rows 0..2 are body text, not the header).
  // Capturing once inside enterEasyReading stored the previous post's key on the second
  // path and body text on the third; nextEasyReadingReentry's identity check was then
  // vacuous and a plain native Home re-enabled easy reading. Callers are gated on
  // _enabled && !_functionMode (_onChanged), so prompt/menu frames never capture.
  if (rowState.statusStart === 1) {
    const key = this._readArticleKey();
    if (key) this._articleKey = key;
  }
};

// Identity of the article page currently shown, taken from the status row's
// "目前顯示: 第 a~b 行" range (unique per page; advances on every page-down). Returns
// null off a status row. Used to dedup the per-frame send against the settle recovery.
EasyReading.prototype._currentPageSignature = function() {
  const s = this._currentPageStatus();
  return s ? (s.rowIndexStart + '~' + s.rowIndexEnd) : null;
};

// parseStatusRow of the CURRENT bottom row (null off an article page).
EasyReading.prototype._currentPageStatus = function() {
  const lastRowText = this._termBuf.getRowText(this._termBuf.rows - 1, 0, this._termBuf.cols);
  return parseStatusRow(lastRowText);
};

// Identity of the post currently on screen, from its header rows (作者 / 標題 / 時間).
// Only meaningful on a post's FIRST page — every caller checks statusStart === 1 first.
// Read through getRowText so both capture sites (enter, and the re-entry check) build
// the string exactly the same way.
EasyReading.prototype._readArticleKey = function() {
  const cols = this._termBuf.cols;
  const parts = [];
  for (let r = 0; r < 3; ++r)
    parts.push((this._termBuf.getRowText(r, 0, cols) || '').replace(/\s+$/, ''));
  const key = parts.join('|');
  return key.replace(/\|/g, '') === '' ? null : key;
};

// One clean auto-paging transaction per ARTICLE. Every field here is per-post state
// that MUST NOT survive into the next article:
//   _inFlightSig        — the page signature is NOT unique across articles: every
//                         article's first page is "1~22". A leftover "1~22" makes the
//                         next article's first page look like "the response we are
//                         still waiting for" ⇒ 'wait' forever on the fast path,
//                         'giveup' forever on the settle path ⇒ stuck on page 1.
//   _pageDownRetries    — a spent retry budget would carry the giveup into the next
//                         article as well.
//   easyReadingReachedPageEnd — set once an article is read to the bottom
//                         (pagePercent 100); it used to veto the whole settle recovery
//                         for the NEXT article, which is the "很容易卡在第一頁" report.
//   _healGotoCount / _healHomeUsed — each article gets its own gap self-heal budget.
// Callers: the settle article boundary (_onPageStateSettled), leaveCurrentPost (the
// article→article jumps that never pass a list: [ ] a b f = + -), enterEasyReading /
// exitEasyReading, and _healFromTop.
EasyReading.prototype._resetPagingState = function() {
  this.sendCommandAfterUpdate = '';
  this.easyReadingReachedPageEnd = false;
  this._inFlightSig = null;
  this._pageDownRetries = 0;
  this._inFlightKeys = null;
  this._inFlightSentAt = null;
  // 待補送的鍵是「這一篇」的：跨文章帶過去就是在新文章上憑空多送一次 PageDown
  // （P4 重複送鍵）。與 _pendingScrollRestore / _pendingEnableOnArticle 同規。
  this._deferredPageDownKeys = null;
  this._clearWatchdog();
  this._healGotoCount = 0;
  this._healHomeUsed = false;
  this._termBuf.easyReadingHealInFlight = false;
  // ignoreOneUpdate is per-post too, and leaving it set is not "one skipped frame":
  // the frame it halts is usually enterEasyReading()'s own replayed notify(), which is
  // a LOCAL repaint (no _touchRows ⇒ term_buf._serverActivity stays false ⇒ the settle
  // timer is NOT re-armed) ⇒ no 'screenSettled' either ⇒ not a single PageDown goes out
  // for the whole article. That is the "F8 之後下一篇卡在第一頁" report. Callers that
  // genuinely want the one-shot (leaveCurrentPost) re-arm it AFTER this runs.
  this.ignoreOneUpdate = false;
};

// Arm the recovery timer for the outstanding request. _watchdogSig is the identity
// guard: if the answer arrives inside the grace the transaction has already moved on to
// another page, and a timer that fired anyway would send a second key on top of an
// in-flight repaint — exactly the P4 duplicate this whole transaction exists to prevent.
EasyReading.prototype._armWatchdog = function() {
  this._clearWatchdog();
  this._watchdogSig = this._inFlightSig;
  this._watchdogTimer = setTimeout(() => {
    this._watchdogTimer = null;
    if (this._inFlightSig == null || this._inFlightSig !== this._watchdogSig)
      return;  // answered (or reset) in the meantime — nothing to recover
    this._maybeSendPageDown(this._inFlightKeys, /* recovery */ true);
  }, PAGE_DOWN_GRACE_MS + 20);
};

EasyReading.prototype._clearWatchdog = function() {
  if (this._watchdogTimer != null) {
    clearTimeout(this._watchdogTimer);
    this._watchdogTimer = null;
  }
  this._watchdogSig = null;
};

// Single gate every auto page-down goes through — both the per-frame fast path
// (_onViewUpdated) and the settle recovery (_onScreenSettled). Gathers the facts,
// runs the pure nextPageDownDecision, writes the resulting transaction state back and
// sends at most one key. See nextPageDownDecision for the pmore invariants behind it.
EasyReading.prototype._maybeSendPageDown = function(keys, recovery) {
  // 線路上有別人的交易：這一次請求**延後**，不是丟棄。決策連跑都不跑，所以
  // _inFlightSig／_inFlightSentAt／_pageDownRetries 全部原封不動，也不上膛 watchdog
  // ——留下一筆「送出去了」的假紀錄正是 620ms 死時間與 giveup 的來源（見 onWireIdle）。
  if (this._wireBusy()) {
    this._deferredPageDownKeys = keys || this._inFlightKeys || '\x1b[6~';
    this._core.debugRecorder?.log('easyReading.pageDown', {
      action: 'blocked',
      recovery: !!recovery,
      navActive: !!this._core.aidNavigation?.active,
      inFlightKind: this._core.commandQueue?.inFlightKind || null
    });
    return 'blocked';
  }
  const status = this._currentPageStatus();
  const sinceSentMs = this._inFlightSentAt == null
    ? null : Date.now() - this._inFlightSentAt;
  const d = nextPageDownDecision({
    enabled: this._enabled,
    functionMode: this._functionMode,
    // P6: the cursor is parked at (rows-1, cols-1) only at the end of a full response.
    complete: this._termBuf.cur_y === this._termBuf.rows - 1 &&
              this._termBuf.cur_x === this._termBuf.cols - 1,
    isStatusRow: !!status,
    pagePercent: status ? status.pagePercent : null,
    sig: status ? (status.rowIndexStart + '~' + status.rowIndexEnd) : null,
    inFlightSig: this._inFlightSig,
    retries: this._pageDownRetries,
    recovery: !!recovery,
    sinceSentMs: sinceSentMs,
    graceMs: PAGE_DOWN_GRACE_MS
  });
  if (d.action === 'none')
    return d.action;
  // Record the transaction's turning points. Without this, every way the auto-paging
  // can stall looks the same in a debug capture — "not a single send event after the
  // article opened" — and there is no way to tell a spent retry budget from a stale
  // reachedPageEnd. 'send'/'wait' are left out: one is visible as the send event
  // itself, the other fires on every frame.
  if (d.action !== 'send' && d.action !== 'wait') {
    this._core.debugRecorder?.log('easyReading.pageDown', {
      action: d.action,
      recovery: !!recovery,
      sig: status ? (status.rowIndexStart + '~' + status.rowIndexEnd) : null,
      // state BEFORE the decision is applied — that is what explains the action
      wasInFlightSig: this._inFlightSig,
      wasRetries: this._pageDownRetries,
      // The field that makes a recurrence self-diagnosing: a `retry` with a small
      // sinceSentMs is the false-retry bug, a large one is a genuinely lost key.
      sinceSentMs: sinceSentMs
    });
  }
  this._inFlightSig = d.inFlightSig;
  this._pageDownRetries = d.retries;
  if (d.reachedPageEnd !== undefined)
    this.easyReadingReachedPageEnd = d.reachedPageEnd;
  if (d.action === 'send' || d.action === 'retry') {
    // A retry re-sends the ORIGINAL bytes, never the caller's: the outstanding request
    // may be a gap heal (':N\r'), and the watchdog has no idea what it is recovering.
    const bytes = d.action === 'retry' ? (this._inFlightKeys || keys) : keys;
    this._inFlightKeys = bytes;
    this._inFlightSentAt = Date.now();
    this._send(bytes);
    this._armWatchdog();
  } else if (d.action === 'done' || d.action === 'giveup') {
    this._clearWatchdog();
    // Bounded escape for a seek PTT never answered: without this the heal gate would
    // stay up forever and the settle teardown could never run again.
    this._termBuf.easyReadingHealInFlight = false;
  }
  return d.action;
};

// User-driven rescue for a stalled auto-paging transaction, wired to PageDown (key and
// mouse) when the accumulated page cannot scroll any further. Auto-paging is supposed
// to be invisible, but every failure mode of it looks identical to the user — the long
// page just stops growing and PgDn does nothing at all. Clearing the transaction and
// re-issuing is safe here by the same argument as the settle retry: this runs from a
// user keypress, long after PTT flushed its response, so there is no in-flight repaint
// for the key to be swallowed by (P4). Does nothing once the status row says 100%
// (pmore answers a PageDown at the bottom with silence anyway, P3).
EasyReading.prototype._kickPageDown = function() {
  const status = this._currentPageStatus();
  if (!status || status.pagePercent >= 100)
    return;
  this._core.debugRecorder?.log('easyReading.pageDownKick', {
    sig: status.rowIndexStart + '~' + status.rowIndexEnd,
    inFlightSig: this._inFlightSig,
    retries: this._pageDownRetries
  });
  this._inFlightSig = null;
  this._pageDownRetries = 0;
  this._inFlightSentAt = null;  // user-driven: the grace has nothing to measure against
  this._clearWatchdog();
  this._maybeSendPageDown('\x1b[6~', /* recovery */ true);
};

// Gap self-heal (pmore invariant P1, raised by term_view.accumulatePageLines as
// buf.easyReadingGapDetected). A page was swallowed — pmore will never send its text
// again on its own, so we must navigate back to it.
//
// Strategy order per article: up to HEAL_GOTO_MAX precise seeks, then ONE re-read from
// the top, then give up (leave the page as is; PgDn and the switch-to-native key both
// still work). The precise seek costs one round trip and keeps everything already
// accumulated; the Home re-read costs the whole article, which on a 4700-line post is
// the "讀到一半自動從第一頁重讀" report — so it is the fallback, not the first move.
EasyReading.prototype._healGap = function() {
  // 線路上有別人的交易：整個自癒延後到下一次 settle（旗標刻意還沒清）。不能往下走
  // 的理由是 _healFromTop 會先清掉 pageLines 才送 Home——被 _send 的閘門吞掉就只剩
  // 一片空白畫面，而它沒有 watchdog 兜底。
  if (this._wireBusy())
    return;
  this._termBuf.easyReadingGapDetected = false;
  // Never stack heals: the outstanding one either lands (accumulatePageLines clears
  // easyReadingHealInFlight on the append) or the watchdog gives up on it.
  if (this._termBuf.easyReadingHealInFlight) {
    this._core.debugRecorder?.log('easyReading.gapHeal', { mode: 'busy' });
    return;
  }
  const status = this._currentPageStatus();
  const accEndRow = this._view ? this._view._accEndRow : null;
  const base = {
    accEndRow: accEndRow,
    lastAccumulatedSig: this._view ? this._view._lastAccumulatedSig : null,
    screenStart: status ? status.rowIndexStart : null,
    screenEnd: status ? status.rowIndexEnd : null,
    missingLines: (status && accEndRow != null) ? status.rowIndexStart - accEndRow - 1 : null,
    gotoCount: this._healGotoCount,
    homeUsed: this._healHomeUsed
  };
  if (accEndRow != null && accEndRow >= 1 && this._healGotoCount < HEAL_GOTO_MAX) {
    this._core.debugRecorder?.log('easyReading.gapHeal',
      Object.assign({ mode: 'goto', targetLine: accEndRow }, base));
    this._healAtLine(accEndRow);
    return;
  }
  if (!this._healHomeUsed) {
    this._core.debugRecorder?.log('easyReading.gapHeal', Object.assign({ mode: 'home' }, base));
    this._healFromTop();
    return;
  }
  console.log('easy reading: gap again after healing — leaving the page as is');
  this._core.debugRecorder?.log('easyReading.gapHeal', Object.assign({ mode: 'exhausted' }, base));
};

// Seek straight to the first missing line with pmore's goto-line
// (pmore.c#pmore `case ':'` → pageMode 0 → getdata_buf(PMORE_MSG_GOTO_LINE) →
// `if (i-- > 0) mf_goto(i)` → mf.lineno = N-1), so the landing screen's status row
// reads exactly "第 N~… 行".
//
// N = _accEndRow, NOT _accEndRow + 1: statusStart === accEndRow is pmore's own
// PageDown post-condition (P1, S' == E), so the landing frame is shaped exactly like a
// normal page-down — classifyPageTransition 'continuation', resolvePageOverlap k = 1,
// decideAccumulateBranch 'append'. No new code path, and the one overlapping row is a
// free content cross-check. (Clamping by mf.maxdisps near the end only makes the
// overlap bigger, which those same functions already handle.)
//
// Nothing accumulated is touched: pageLines, _accEndRow, _lastAccumulatedSig, the
// scroll position and the article instance id all stay put — the missing rows are
// spliced in on the landing frame's append.
EasyReading.prototype._healAtLine = function(line) {
  console.log('easy reading: lost page, seeking back to line ' + line);
  ++this._healGotoCount;
  // Two separate gates, both needed while the prompt row is up (the bottom row shows
  // 「跳至第幾行:」 so parseStatusRow fails and pageState can drop out of 3):
  //   buf.easyReadingHealInFlight — term_view.redraw writes buf.prevPageState on EVERY
  //     rendered frame, so one prompt frame classified as non-3 would make the landing
  //     frame take decideAccumulateBranch's `prevPageState !== 3 → rebuild` path and
  //     restart pageLines from the middle of the article, silently dropping everything
  //     above it. Worse than the gap it is healing.
  //     It is also what makes _onScreenSettled early-return: its
  //     `pageState !== 3 → teardown` calls hideEasyReadingOverlays(), which empties
  //     pageLines outright.
  this._termBuf.easyReadingHealInFlight = true;
  // The seek is a transaction like any page-down: ack = the signature changing, and the
  // watchdog re-sends _inFlightKeys if PTT never answers. Without this the paging
  // machine would see the next complete frame with inFlightSig null and fire a
  // PageDown on top of the in-flight seek — the very P4 duplicate we are recovering from.
  this._inFlightSig = this._currentPageSignature();
  this._inFlightKeys = ':' + line + '\r';
  this._inFlightSentAt = Date.now();
  this._pageDownRetries = 0;
  this._send(this._inFlightKeys);
  this._armWatchdog();
};

// Last-resort heal: re-read the whole article. Home is pmore's KEY_HOME → mf_goTop
// (pmore.c:2585). Used once per article, only after the precise seeks are spent or
// when there is no accumulated position to seek back to.
EasyReading.prototype._healFromTop = function() {
  console.log('easy reading: lost page detected, re-reading from the top');
  this._resetPagingState();
  this._healHomeUsed = true;  // AFTER the reset — this article's Home budget is spent
  this._termBuf.easyReadingHealInFlight = false;
  this._termBuf.pageLines = [];
  this._termBuf.easyReadingPendingReset = true;
  this._termBuf.prevPageState = 0;
  if (this._view) {
    this._view._accEndRow = null;
    this._view._lastAccumulatedSig = null;
    if (this._view.mainDisplay) this._view.mainDisplay.scrollTop = 0;
  }
  this._send('\x1b[1~');  // KEY_HOME → mf_goTop
};

// Settle-driven page-down recovery. Fired once per quiet window (term_buf 'screenSettled'),
// i.e. after BOTH content and the cursor have stopped. The per-frame fast path
// (_onChanged) can stall: PTT parks the cursor on the bottom status row in a
// content-less (changed=false) notify, so the 'change'/'viewUpdate' events never fire
// for that frame and the next PageDown is never queued, truncating the accumulated
// page (most often on the heavy first article after login). When the screen is stable
// we re-evaluate the SAME pure decision and, if a page-down is warranted AND we have
// not already paged down from THIS exact page, send it — the page signature dedups
// against the fast path so a slow PTT response cannot trigger a double page-down (which
// would skip a page). See docs/easy-reading.md.
EasyReading.prototype._onScreenSettled = function() {
  if (!this._enabled) {
    // 導航落地當下判不出來（游標還沒 park 之類）才會留下這個一次性旗標，只在這裡
    // 重試這一次就丟掉 —— 不做重試迴圈。見 ensureEnabledOnArticle。
    if (this._pendingEnableOnArticle && this.ensureEnabledOnArticle(false))
      return;
    this._maybeReenterOnNewArticle();
    return;
  }
  // While mirroring native (functionMode), the only thing settle decides is whether to
  // leave functionMode — never a page-down. Handle it first (the pageState !== 3 guard
  // below would otherwise skip the editor/menu screens we need to evaluate).
  if (this._functionMode) {
    this._evalFunctionModeExit();
    return;
  }
  // A gap seek (':N\r') is in flight: PTT is showing its 「跳至第幾行:」 prompt, which
  // has no status row, so pageState may momentarily leave 3. The teardown below would
  // read that as "the user left the article" and empty the accumulated page. The screen
  // WILL come back to 3 — and if it doesn't, the transaction watchdog gives up and
  // clears the flag, so this cannot wedge. See _healAtLine.
  if (this._termBuf.easyReadingHealInFlight)
    return;
  if (this._termBuf.pageState !== 3) {
    // Settled OFF the article. term_view.redraw deliberately KEEPS the accumulated page
    // while settledPageState is still 3 (a per-frame pageState dip mid-article must not
    // throw the long page away), so the teardown moved here: the debounced state now
    // agrees we really left, and this is the last chance to run it — no further redraw
    // is guaranteed after the list has finished painting.
    this._teardownAccumulationOffArticle();
    return;
  }
  // P1 violated on the last accumulate → a page was lost; nothing else matters.
  if (this._termBuf.easyReadingGapDetected) {
    this._healGap();
    return;
  }
  // A response whose cursor park landed in a CURSOR-ONLY notify window never reached
  // redraw (notify only calls view.update() on the 'changed' branch), so its page was
  // never accumulated. The screen is quiet and the cursor parked now, so replay one
  // full repaint — accumulatePageLines then sees a complete frame and appends it.
  const sig = this._currentPageSignature();
  if (sig && this._view && this._view._lastAccumulatedSig !== sig) {
    this._forceRepaint();
    if (this._termBuf.easyReadingGapDetected) {
      this._healGap();
      return;
    }
    // _forceRepaint replays 'change'/'viewUpdate', so the fast path has already run
    // the paging decision for this screen; nothing left for the settle path to do.
    return;
  }

  if (this.sendCommandAfterUpdate)  // a command is mid-flight (incl. skipOne) — let the frame loop drive
    return;
  // NOTE: deliberately NO `if (this.easyReadingReachedPageEnd) return;` here. The
  // settle path must be idempotent on the CURRENT screen — "already at the bottom" is
  // re-derived from this screen's status row twice over (pagePercent in
  // _computeRowState and again in nextPageDownDecision, P3), so letting a possibly
  // stale flag veto the whole recovery bought nothing and wedged the next article.
  const rowState = this._computeRowState();
  this._applyRowState(rowState);  // fix any cursor-dependent flag against the now-stable cursor

  if (rowState.sendCommandAfterUpdate && rowState.sendCommandAfterUpdate !== 'skipOne') {
    // A settle-path send has no following 'viewUpdate' to flush the queue, so never
    // leave the command queued — it would re-fire on the next frame's viewUpdate.
    this.sendCommandAfterUpdate = '';
    this._maybeSendPageDown(rowState.sendCommandAfterUpdate, /* fromSettle */ true);
  }
};

// Second auto-enable route, evaluated on every settle while easy reading is OFF: the
// user switched to native inside a post and has since navigated to a DIFFERENT post
// without passing a list ([ ] a b f = + -), which produces no settled 1|2 → 3 edge for
// nextEasyReadingState to fire on. See nextEasyReadingReentry for why this is keyed on
// article identity rather than on a pageState edge.
EasyReading.prototype._maybeReenterOnNewArticle = function() {
  const status = this._currentPageStatus();
  const values = readValuesWithDefault();
  const articleKey = status && status.rowIndexStart === 1 ? this._readArticleKey() : null;
  const ok = nextEasyReadingReentry({
    pageState: this._termBuf.pageState,
    // P6: only a parked cursor means the whole response has arrived.
    complete: this._termBuf.cur_y === this._termBuf.rows - 1 &&
              this._termBuf.cur_x === this._termBuf.cols - 1,
    enabled: this._enabled,
    enablePref: values.enableEasyReading,
    supported: this._core.connectedUrl.easyReadingSupported,
    functionMode: this._functionMode,
    statusStart: status ? status.rowIndexStart : null,
    articleKey: articleKey,
    nativeArticleKey: this._nativeArticleKey,
    navActive: this._navActive()
  });
  if (!ok)
    return;
  this._core.debugRecorder?.log('easyReading.reenter', {
    reason: 'newArticleInNative', articleKey: articleKey
  });
  // Already on line 1 — no rewind needed, enterEasyReading accumulates from here.
  this.enterEasyReading();
};

// Replay one full repaint of the CURRENT screen.
//
// MUST go through term_buf.notify() rather than view.redraw(true) directly: notify is
// what runs updateCharAttr(), which is where a Big5 lead byte gets its isLeadByte flag.
// A settle can fire between "bytes arrived" and "the 30ms notify timer ran", so a bare
// redraw there would clone rows whose DBCS pairs are not yet marked — rowToText then
// returns raw Big5 (¡° instead of ※), those rows go into pageLines, and the NEXT page's
// overlap comparison against them fails ⇒ overlap 0 ⇒ the shared row is appended twice
// (a duplicated 「※ 文章網址」 line). Caught by the offline split-frame test.
EasyReading.prototype._forceRepaint = function() {
  this._termBuf.lineChangeds.fill(true);
  this._termBuf.changed = true;
  this._termBuf.notify();
};

// Drop the accumulated long page + its padding/scroll once the DEBOUNCED state says we
// are off the article for good. Counterpart to term_view.redraw's transient guard.
EasyReading.prototype._teardownAccumulationOffArticle = function() {
  const view = this._view;
  if (!view || typeof view.hideEasyReadingOverlays !== 'function')
    return;
  const hasPage = !!(this._termBuf.pageLines && this._termBuf.pageLines.length);
  const hasPadding = !!(view.mainContainer && view.mainContainer.style &&
                        view.mainContainer.style.paddingBottom);
  if (!hasPage && !hasPadding)
    return;
  view.hideEasyReadingOverlays();
  this._forceRepaint();
};

// Enter functionMode: stop the easy-reading illusion and mirror the native 24-row
// screen LIVE. Called from _onKeyDownProcessUI when the user presses a key that falls
// through to native and may open a prompt/menu (r/X/%/y…). Saves the current scroll so
// _evalFunctionModeExit('resume') can restore the reading position, then forces one
// repaint so the native screen shows immediately (before PTT's response arrives).
EasyReading.prototype._enterFunctionMode = function() {
  // functionMode 只在好讀**開著**時才有意義：term_view.redraw 的分支條件是
  // `useEasyReadingMode && buf.easyReadingFunctionMode`，而唯一的出口
  // _evalFunctionModeExit 只能經 _onScreenSettled 進入 —— 那裡第一行就是
  // `if (!this._enabled) { _maybeReenterOnNewArticle(); return; }`。
  //
  // 所以在好讀關閉時設這個旗標：畫面上什麼都不會變，卻**永遠清不掉**，而且一次
  // 同時廢掉兩條回好讀的路 —— nextEasyReadingReentry 的 functionMode gate（自動
  // 重入），以及 term_view.onKeyDown 的 `!buf.easyReadingFunctionMode` gate
  // （End/F8 手動切回）。冷啟動 deep link 就是這樣鎖死整個 session 的：
  // aid_navigation._begin 無條件呼叫本函式，而那時使用者還沒開過任何文章。
  // 好讀關著時畫面本來就是原生的，這裡什麼都不用做。
  // 守護：tests/unit/easy_reading_function_mode_gate.test.js
  if (!this._enabled)
    return;
  if (this._functionMode)
    return;
  console.log('enter function mode');
  // Drop any in-flight auto page-down so it can't fire (via _onViewUpdated) while we
  // are mirroring a native prompt.
  this.sendCommandAfterUpdate = '';
  this._savedScrollTop = this._view.mainDisplay.scrollTop;
  this._functionMode = true;
  this._termBuf.lineChangeds.fill(true);
  this._termBuf.changed = true;
  this._termBuf.notify();
};

// 使用者「送了一段文字給 PTT」——不是按鍵，所以繞過了 _onKeyDown 那條進 functionMode
// 的路。兩個實例，同一個缺口：
//   a) 中文 IME 開著時按 X 推文：keydown 的 e.key 是 'Process'（keyCode 229），
//      `e.key.length === 1` 不成立 ⇒ 不進鏡像；字元改由 input 事件（term_view.onInput
//      的 IME 特判刻意放行 'X'）→ onTextInput → _convSend 送出。PTT 開了推文 prompt
//      （只 patch 最後一列），好讀長頁卻原封不動 ⇒ **看不到輸入框，字卻真的送出去了**。
//   b) 貼上：App.onPasteDone 早就自己補過這一刀（同樣理由）。
// 由 term_view.onTextInput 這條共用漏斗統一呼叫，keydown／IME／貼上三條入口行為一致。
// _enterFunctionMode 本身有 _enabled 與重入 gate，這裡只多一道「文章真的開著」。
// 守護：tests/unit/easy_reading_text_input.test.js。
EasyReading.prototype.noteTextInput = function() {
  if (!this._enabled || !this.startedEasyReading)
    return;
  this._enterFunctionMode();
};

// Decide (pure functionModeExitDecision) and act when functionMode settles. 'resume'
// turns it off and replays one render so accumulatePageLines continues the SAME article
// (prevPageState=3 → continuation branch; findPageOverlap dedups the unchanged screen to
// a no-op append), then restores the saved scroll. 'leave' drops per-post state so the
// normal settle re-enable handles the next article. 'stay' keeps mirroring native.
EasyReading.prototype._evalFunctionModeExit = function() {
  const lastRowNum = this._termBuf.rows - 1;
  const lastRowText = this._termBuf.getRowText(lastRowNum, 0, this._termBuf.cols);
  const decision = functionModeExitDecision({
    pageState: this._termBuf.pageState,
    isStatusRow: !!parseStatusRow(lastRowText),
    curY: this._termBuf.cur_y,
    lastRowNum
  });
  if (decision === 'stay')
    return;
  console.log('exit function mode: ' + decision);
  this._functionMode = false;
  if (decision === 'resume') {
    this._termBuf.prevPageState = 3;  // force accumulatePageLines continuation branch
    // Resume = SAME article: a leftover pending-reset would make a short article's
    // first page rebuild (drop accumulation) — clear it explicitly.
    this._termBuf.easyReadingPendingReset = false;
    this._termBuf.lineChangeds.fill(true);
    this._termBuf.changed = true;
    this._termBuf.notify();
    if (this._savedScrollTop != null)
      this._view.mainDisplay.scrollTop = this._savedScrollTop;
  } else {  // 'leave'
    this.startedEasyReading = false;
    this.leaveCurrentPost();
    this._termBuf.lineChangeds.fill(true);
    this._termBuf.changed = true;
    this._termBuf.notify();
  }
  this._savedScrollTop = null;
};

EasyReading.prototype._onViewUpdated = function(e) {
  if (TRACE) console.log('view update');
  // accumulatePageLines (which just ran inside view.update()) may have found a lost
  // page — handle that before anything else, it invalidates the whole transaction.
  if (this._enabled && !this._functionMode && this._termBuf.easyReadingGapDetected) {
    this.sendCommandAfterUpdate = '';
    this._healGap();
    return;
  }
  if (this.sendCommandAfterUpdate) {
    const keys = this.sendCommandAfterUpdate;
    this.sendCommandAfterUpdate = '';
    if (keys != 'skipOne') {
      // Fast path goes through the SAME single-in-flight gate as the settle recovery.
      // It used to send unconditionally (recording the signature but never checking
      // it), so a second complete-looking frame on the same page fired a duplicate
      // PageDown → pttbbs typeahead skip → that page's text lost. See
      // nextPageDownDecision.
      // 送鍵絕不可以寫在 log 的字串運算式裡：一旦哪天把 log 包進條件式就會連送鍵
      // 一起關掉，而那正是好讀唯一的翻頁動力。
      const action = this._maybeSendPageDown(keys, false);
      if (TRACE) console.log("send:" + keys + " -> " + action);
    }
  }
  // Last: the page that just merged in may finally make the saved reading
  // position reachable (AID back run). No-op when nothing is pending.
  this._advanceScrollRestore();
};

// "Leaving this post" hook: stays in easy reading (does NOT touch _enabled) but
// resets the per-post render state. Called directly by the in-post key/mouse
// handlers, and transitively by switchToEasyReadingMode (pttchrome.js:344) on every
// manual exit. Zeroing prevPageState forces the next article down
// accumulatePageLines' "new article" branch (restart pageLines) even on a direct
// article->article jump with no list in between. Auto re-enable is now edge-triggered
// on the settle stream (nextEasyReadingState), so there is no latch to clear here.
// See docs/easy-reading.md.
EasyReading.prototype.leaveCurrentPost = function() {
  console.log('leave curent post');
  // Read BEFORE _resetPagingState (which clears both flags) and re-arm AFTER it —
  // otherwise the reset silently eats the one-shot this function exists to set.
  const wasAtEnd = this.easyReadingReachedPageEnd;
  this._termBuf.prevPageState = 0;
  // Sticky companion to the one-shot prevPageState=0 above: redraw overwrites
  // prevPageState every frame, so a stale old-article frame between here and the
  // new article's first page can eat the one-shot and the new article would take
  // the continuation branch (pile-up). This flag is only consumed by
  // accumulatePageLines on a CONFIRMED first article page (statusStart===1) — see
  // decideAccumulateBranch.
  this._termBuf.easyReadingPendingReset = true;
  // New post → a clean auto-paging transaction. Covers the article→article jumps that
  // never pass through a list ([ ] 同標題、a/b/f/=/+/-), which the settle article
  // boundary in _onPageStateSettled cannot see. See _resetPagingState.
  this._resetPagingState();
  if (!wasAtEnd)
    this.ignoreOneUpdate = true;
  this._functionMode = false;
  this._savedScrollTop = null;
  // Leaving the post the restore was meant for: drop it (a later article must
  // never inherit someone else's reading position).
  this._pendingScrollRestore = null;
  // Same reasoning for the external-landing one-shot: it was aimed at the post we
  // are leaving, so a later article must not inherit it.
  this._pendingEnableOnArticle = false;
  // Structural belt-and-braces for the article identity: this is the jump-to-another-post
  // path ([ ] a b f = + -), and the OLD post's key must not survive into the new one even
  // for the few frames before _applyRowState re-captures it (an F8 in that window would
  // hand nextEasyReadingReentry the wrong nativeArticleKey).
  this._articleKey = null;
  // Pure notification (changes nothing here): this is the only hook that sees
  // an article→article jump, which never passes a list screen — aid_navigation's
  // back anchors describe the post we just left, so they are now stale. No-ops
  // while aid_navigation itself is driving.
  if (this._core.aidNavigation) this._core.aidNavigation.noteLeftPost();
};

EasyReading.prototype.stopEasyReading = function() {
  console.log('stop easy reading');
  this.sendCommandAfterUpdate = 'skipOne';
};

EasyReading.prototype._send = function(data) {
  // **有序列化交易在飛時，好讀模式一個 byte 都不准送。**
  //
  // CommandQueue 的整個設計前提是「同時只有一個鍵在線上，回應由畫面內容判定」
  // （v5，見 command_queue.js）。使用者的鍵盤早就被 term_view.onKeyDown /
  // App.onMouse_click 的入口擋掉了；漏掉的是好讀**狀態機自己送的鍵**——它繞過
  // queue 直接送，過去沒有交叉場景所以沒事，deep link 把兩者湊在一起就爆了。
  //
  // 實測 2026-08-16 的兩個症狀，同一個根因：
  //   a) 跳到有進板畫面的看板（Steam）卡死：進板畫面是 pmore，與一篇文章同形，
  //      好讀把公告當文章開始累積並送 PageDown → 餵掉了進板畫面收尾的
  //      pressanykey（bbs.c:4470-4477）→ 導航的 ← 永遠等不到它要的畫面。
  //   b) 「複製本篇連結」複製完就跳出文章：落地後好讀正把文章自動翻到底，它的
  //      PageDown 先關掉了 Q 資訊框、又把 pager 翻到 100%，於是 dismissPostInfo
  //      送的空白鍵成了 pmore 的「離開」。
  //
  // 只擋 aidNavigation.active 不夠（b 不在導航中），只進 functionMode 也不夠：
  // _onViewUpdated 處理 sendCommandAfterUpdate 那段沒有看 functionMode，進入
  // 鏡像模式**之前**就排好的 PageDown 照樣送得出去。
  //
  // 反過來不會卡到好讀：queue 的交易都在列表／選單／prompt 畫面上跑，而好讀只在
  // pageState 3 才送鍵；真的卡住也有 hardTimeout 兜底。
  // 守護：tests/unit/easy_reading_send_gate.test.js。
  // 最後一道防線：自動翻頁那條路在 _maybeSendPageDown 開頭就先攔下來並保留待補送
  // （見 _wireBusy／onWireIdle）；這裡涵蓋其餘直接送鍵的呼叫點（_onKeyDown 的
  // 方向鍵、switchToNativeAtBottom 的 End…），它們被吞掉只是該次動作沒發生，
  // 不會像翻頁那樣留下假的 in-flight。
  if (this._wireBusy()) return;
  // 走 TermView._send（內含 `if (this.conn)`）：view.conn 只在 App.onConnect 被設，
  // 連線從未成功時是 undefined，直接 deref 會 TypeError。見 pttchrome.jsx
  // switchToEasyReadingMode 的同類註解。
  this._view._send(data);
};

// 線路上有別人的交易嗎？（AID 跳文／deep link 導航，或 CommandQueue 的序列化指令）
EasyReading.prototype._wireBusy = function() {
  const core = this._core;
  if (core.aidNavigation && core.aidNavigation.active) return true;
  if (core.commandQueue && core.commandQueue.inFlightKind) return true;
  return false;
};

// 線路空出來了（CommandQueue.onIdle → pttchrome 接線）。把被閘門延後的那個自動翻頁
// 補送出去。
//
// 為什麼一定要有這條路：文章落地的那一個 settle 上，好讀**必然**比 queue 早一步跑
// （pttchrome.jsx 的「ORDER MATTERS」刻意保證的註冊順序），所以它送第一個 PageDown
// 時 open-enter／aid-open 都還掛在線上 → 一定被擋。少了這個通知，就只剩 _armWatchdog
// 的 620ms 能救，等於每篇文章開頭固定卡一下（2026-08-17 回報），而且那次 retry 若又
// 撞上別的交易就 giveup，整篇停在第一頁。
//
// 刻意不做重試迴圈：仍然忙的話 _maybeSendPageDown 會把鍵原封不動存回 _deferredPageDownKeys，
// 下一次 idle 通知再試——自我保持，沒有 timer。
EasyReading.prototype.onWireIdle = function() {
  const keys = this._deferredPageDownKeys;
  if (!keys) return;
  // 好讀已關 / 進了鏡像模式：這個補送已無意義（換文章的清除見 _resetPagingState）。
  if (!this._enabled || this._functionMode) {
    this._deferredPageDownKeys = null;
    return;
  }
  this._deferredPageDownKeys = null;
  // recovery：這條路不是「畫面剛更新」的 fast path，而是補送一次從未上線的請求。
  this._maybeSendPageDown(keys, /* recovery */ true);
};

// Temporarily leave easy reading: switch back to native rendering and jump to
// the bottom of the post. Auto-paging stops, so the native in-post search ('/')
// and navigation become usable. Easy reading is re-enabled automatically by
// _onPageStateSettled when the next post settles in from a list (settled 2 -> 3).
// The other half of switchToNativeAtBottom: pressing the same configurable key again
// while in native puts easy reading back on for THIS post. Called from
// term_view.onKeyDown's native path (the easy-reading key gate below it requires
// useEasyReadingMode, which is false here). Returns true when it handled the key.
//
// `$` / `G` deliberately do NOT toggle back: in native pmore they are real navigation
// (mf_goBottom), and their meaning is "jump to the end", not "switch modes".
EasyReading.prototype.tryReenterFromNative = function(e) {
  const prefs = readValuesWithDefault();
  if (!prefs.easyReadingEndSwitchNative || e.key !== prefs.easyReadingEndSwitchKey)
    return false;
  if (!prefs.enableEasyReading || !this._core.connectedUrl.easyReadingSupported)
    return false;
  // pageState can be stale on a prompt frame (term_buf.setPageState has no default
  // branch), so require a real status row rather than trusting pageState alone.
  const status = this._currentPageStatus();
  if (!status)
    return false;
  this.reenterFromTop(status);
  return true;
};

// Turn easy reading back on for the post we are sitting in, and rewind to line 1 so the
// accumulated page holds the WHOLE post rather than starting from wherever native left
// the cursor.
//
// Order matters: enterEasyReading() ends with a replayed notify() whose fast path would
// otherwise issue a PageDown from the middle of the post — arming the rewind as the
// outstanding transaction first is what keeps exactly one key in flight (P4).
EasyReading.prototype.reenterFromTop = function(status) {
  const sig = status.rowIndexStart + '~' + status.rowIndexEnd;
  this.enterEasyReading();
  // pfterm diffs the screen and parks the cursor with fterm_rawmove_opt, so a Home that
  // changes nothing is answered with ZERO bytes — an unanswerable transaction. Only
  // rewind when there is something to rewind.
  if (status.rowIndexStart > 1) {
    this._inFlightSig = sig;
    this._inFlightKeys = '\x1b[1~';  // KEY_HOME → mf_goTop
    this._inFlightSentAt = Date.now();
    this._pageDownRetries = 0;
    this._send(this._inFlightKeys);
    this._armWatchdog();
  }
};

EasyReading.prototype.switchToNativeAtBottom = function() {
  console.log('switch to native at bottom');
  // jump to the bottom of the post with native End
  this._send('\x1b[4~');
  this.exitEasyReading();
};

// Single entry point that turns easy reading ON for the current article, symmetric
// with exitEasyReading(). Driven by _onPageStateSettled (the settle edge), which
// fires AFTER the first page has painted and the screen went quiet — i.e. outside
// the normal per-frame 'change' loop. So, unlike the old inline `_enabled = true`,
// we must replay one render+viewUpdate cycle ourselves to (a) repaint the
// already-drawn page in easy-reading mode and (b) kick off the auto page-down loop.
EasyReading.prototype.enterEasyReading = function() {
  console.log('enter easy reading');
  this._core.debugRecorder?.log('easyReading.enter');
  this._enabled = true;
  this._functionMode = false;
  this._savedScrollTop = null;
  // Opening a post in easy reading retires whatever native excursion came before it.
  // The identity itself is NOT captured here: reenterFromTop calls us while the screen
  // is still mid-post (it only sends Home afterwards), so rows 0..2 would be body text.
  // _applyRowState re-reads it on the next confirmed first-page frame — the replayed
  // notify() below when we are already there, the Home landing frame otherwise.
  this._articleKey = null;
  this._nativeArticleKey = null;
  // Force accumulatePageLines down its "new article" branch (restart pageLines as
  // the whole screen) instead of the same-article continuation branch, and start
  // page accumulation from empty.
  this._termBuf.prevPageState = 0;
  this._termBuf.easyReadingPendingReset = true; // sticky twin — see leaveCurrentPost
  this._termBuf.pageLines = [];
  this._termBuf.easyReadingGapDetected = false;
  this._resetPagingState();  // fresh article → nothing in flight, own heal budget
  // Mark every row dirty so the forced redraw actually paints (update() only redraws
  // changed rows), then replay a full notify so 'change' (_onChanged sets the first
  // page-down) and 'viewUpdate' (_onViewUpdated sends it) both fire.
  this._termBuf.lineChangeds.fill(true);
  this._termBuf.changed = true;
  this._termBuf.notify();
};

// Full recipe to leave easy reading rendering. Single exit point: every code path
// that turns easy reading off mid-post (End/$/G, ContextMenu 取消好讀, pref-off)
// MUST go through this; see docs/enhanced-addon.md 踩坑 #11. NOTE the transitive
// chain: this -> _core.switchToEasyReadingMode() -> easyReading.leaveCurrentPost()
// (pttchrome.js:344), which resets per-post render state. Easy to miss — that
// hidden hop is what an earlier bug tripped on.
EasyReading.prototype.exitEasyReading = function() {
  console.log('exit easy reading');
  this._core.debugRecorder?.log('easyReading.exit');
  // Stop any pending/in-flight auto page down. This also clears
  // easyReadingReachedPageEnd, which the transitive switchToEasyReadingMode() →
  // leaveCurrentPost() below reads to decide ignoreOneUpdate — so leaving from the
  // bottom now arms that one-shot too. Harmless: it only skips ONE frame's paging
  // decision, and the settle recovery re-runs it right after.
  this._resetPagingState();
  this._functionMode = false;
  this._savedScrollTop = null;
  // Switch off easy reading and restore the native view. switchToEasyReadingMode()
  // restores the overlay rows / padding / pageLines and forces a full redraw via
  // Ctrl-L. Both modes now render through <Screen> (React owns #mainContainer), so
  // turning easy reading off just re-renders with the 24-row screen and React
  // reconciles the long accumulated page down — no unmount hack needed any more
  // (the old vdom-desync freeze is gone now that nothing mutates #mainContainer
  // by hand).
  this._enabled = false;
  // Retire the debounced pageState snapshot: from here on it must speak for THIS
  // screen, not for whatever was on it before the post was opened.
  //
  // docs/easy-reading.md used to claim the exit suppression was structurally correct
  // because settledPageState is already 3 here and never advances again. That holds
  // if the article settled at least once while it was open — and the auto page-down
  // loop makes that the exception, not the rule: it repaints every ~30-40ms, so the
  // 50ms settle timer is re-armed continuously and NEVER fires for the whole article
  // (long posts = more page-downs = more likely). settledPageState then still holds
  // the LIST(2) value from before we entered, and the first quiet moment after this
  // exit — the ^L repaint below — settles to 3 and looks exactly like a fresh
  // "list -> article" edge, so _onPageStateSettled turns easy reading straight back
  // on. The user sees the F8 land on the post's last page and freeze there: easy
  // reading re-accumulates from the bottom page, whose footer already reads 100%, so
  // no further PageDown is ever sent. That is the 「F8 切原生卡在最後一頁」 report
  // (recorded: ptt-debug-20260815-204141.json, easyReading.exit t=2035 →
  // easyReading.enter t=2135).
  this._termBuf.syncSettledPageState();
  // Remember which post we are leaving behind, so the settle re-entry route can tell a
  // genuinely different post from a native Home back to this one's line 1.
  this._nativeArticleKey = this._articleKey;
  this._core.switchToEasyReadingMode();
  // --- everything below must run AFTER switchToEasyReadingMode: it transitively
  // calls leaveCurrentPost(), which re-arms ignoreOneUpdate.
  //
  // startedEasyReading means "a post is open IN EASY READING". Its only clear site is
  // _applyRowState, reachable only through _onChanged, which early-returns while
  // disabled — so without this line it stays true forever and
  // list_session._engageEligible() (which reads it) never lets the list easy reading
  // engage again: the "半永久原生模式" report.
  this.startedEasyReading = false;
  // See _resetPagingState: a leftover ignoreOneUpdate halts the next article's only
  // locally-replayed frame and there is no settle to fall back on.
  this.ignoreOneUpdate = false;
  // Local safety net for "F8 → 卡在最底部, PgUp 沒反應". switchToEasyReadingMode asks
  // PTT for a full repaint with ^L, but that is a SERVER round trip and pfterm skips
  // refreshes while the client still has keys queued (P4) — if a PageDown was still in
  // flight when the user hit the key, the DOM keeps showing the multi-thousand-row
  // accumulated page, scrolled to the bottom, until the input buffer drains. Collapse
  // it to the native 24 rows right now, locally.
  //
  // MUST go through term_buf.notify() (_forceRepaint), never view.redraw() —
  // updateCharAttr (the Big5 lead-byte pass) only runs inside notify. Also note the
  // native redraw branch guards its scroll/overlay reset with `if (useEasyReadingMode)`,
  // which is already false here, so nothing else resets the scroll position.
  if (this._view && this._view.mainDisplay)
    this._view.mainDisplay.scrollTop = 0;
  this._termBuf.easyReadingGapDetected = false;
  this._forceRepaint();
};

EasyReading.prototype._onKeyDown = function(e) {
  if (!this._enabled || !this.startedEasyReading)
    return;

  // The user took over: a pending AID-back scroll restore must not yank the
  // view out from under them a page later.
  this._pendingScrollRestore = null;

  this._onKeyDownProcessUI(e);
  if (e.defaultPrevented)
    return;

  var stop = false;
  if (!e.ctrlKey && !e.altKey) {
    switch (e.key) {
      case 'Backspace':
      case 'ArrowUp':
        this._send('\x1b[D\x1b[A\x1b[C');
        stop = true;
        break;
      case 'ArrowDown':
        this._send('\x1b[D\x1b[B\x1b[C');
        stop = true;
        break;
    }
  } else if (e.ctrlKey && !e.altKey) {
    switch (e.key) {
      case 'h':
        this._send('\x1b[D\x1b[A\x1b[C');
        stop = true;
        break;
    }
  }
  if (stop)
    e.preventDefault();
};

// Scroll restore after an AID back run (aid_navigation): the article is re-read
// from the server, so easy reading starts at the top and grows page by page
// (nextEasyReadingRowState keeps sending PageDown until the footer reads 100%).
// The saved position is therefore only reachable once enough of the article has
// accumulated — this decides, per view update, whether we can land yet.
//
// Pure so it can be unit-tested: no DOM, no state.
export const MAX_SCROLL_RESTORE_TRIES = 120;

export function nextScrollRestoreStep({
  lineIndex, tries, chh, scrollHeight, clientHeight, reachedPageEnd
}) {
  if (tries > MAX_SCROLL_RESTORE_TRIES) return { action: 'giveup' };
  const max = Math.max(0, scrollHeight - clientHeight);
  const target = lineIndex * chh;
  if (max >= target) return { action: 'apply', scrollTop: target };
  // Whole article loaded and it still isn't that tall (window resized, images
  // collapsed, the post shrank): land as close as we can instead of hanging on.
  if (reachedPageEnd) return { action: 'apply', scrollTop: max };
  return { action: 'wait' };
}

// 導航（AID 跳文／deep link）落地在目標文章上時呼叫，補上 settle edge 給不了的那次
// 開啟。回傳是否真的開了好讀。
//
// allowRetry：來自落地 callback 時傳 true —— 判斷不過就留一個一次性旗標，由**下一
// 次** screenSettled 再試一次然後丟掉（_onScreenSettled 的 disabled 分支消費）。與
// _pendingScrollRestore 同規：這是補償而不是輪詢，落地那一刻若畫面還沒完整，通常
// 下一個 settle 就完整了；再判不過就退化成今天的行為（維持原生），不會更糟。
//
// 為什麼不會造成重複 PageDown（P4）：同一次 settle 的順序是 _onPageStateSettled →
// _onScreenSettled → CommandQueue 的 onDone（後者由 list_session._onScreenSettled
// 驅動，而 pttchrome.jsx 先建 easyReading 才建 listSession）。既有 edge 路線若成立，
// _enabled 早已是 true，nextEasyReadingExternalLanding 第一個條件就直接擋掉。
EasyReading.prototype.ensureEnabledOnArticle = function(allowRetry) {
  this._pendingEnableOnArticle = false;
  const values = readValuesWithDefault();
  const status = this._currentPageStatus();
  const ok = nextEasyReadingExternalLanding({
    pageState: this._termBuf.pageState,
    // P6：只有游標停在 (rows-1, cols-1) 的畫面才是一次完整的 server 回應。
    complete: this._termBuf.cur_y === this._termBuf.rows - 1 &&
              this._termBuf.cur_x === this._termBuf.cols - 1,
    statusStart: status ? status.rowIndexStart : null,
    enabled: this._enabled,
    enablePref: values.enableEasyReading,
    supported: this._core.connectedUrl.easyReadingSupported,
    navActive: this._navActive()
  });
  if (!ok) {
    if (allowRetry && !this._enabled) this._pendingEnableOnArticle = true;
    return false;
  }
  this._core.debugRecorder?.log('easyReading.enter', { reason: 'externalLanding' });
  this.enterEasyReading();
  return true;
};

// Ask for the reading position to be restored once the article has grown enough.
// lineIndex 0 (or null) means "was at the top" — nothing to do.
EasyReading.prototype.requestScrollRestore = function(lineIndex) {
  if (!lineIndex) return;
  this._pendingScrollRestore = { lineIndex: lineIndex, tries: 0 };
};

EasyReading.prototype._advanceScrollRestore = function() {
  const pending = this._pendingScrollRestore;
  if (!pending) return;
  const disp = this._view.mainDisplay;
  if (!disp || !this._view.chh) {
    this._pendingScrollRestore = null;
    return;
  }
  pending.tries++;
  const step = nextScrollRestoreStep({
    lineIndex: pending.lineIndex,
    tries: pending.tries,
    chh: this._view.chh,
    scrollHeight: disp.scrollHeight,
    clientHeight: disp.clientHeight,
    reachedPageEnd: this.easyReadingReachedPageEnd
  });
  if (step.action === 'wait') return;
  if (step.action === 'apply') disp.scrollTop = step.scrollTop;
  this._pendingScrollRestore = null;
};

EasyReading.prototype._scrollBy = function(lines) {
  var cont = this._view.mainDisplay;
  if (lines < 0 && cont.scrollTop == 0)
    return false;
  if (lines > 0 && cont.scrollTop >=
    this._view.mainContainer.clientHeight -
      this._view.chh * this._termBuf.rows)
    return false;
  cont.scrollTop += this._view.chh * lines;
  return true;
};

EasyReading.prototype._scrollTop = function() {
  this._view.mainDisplay.scrollTop = 0;
  return true;
};

EasyReading.prototype._scrollBottom = function() {
  this._view.mainDisplay.scrollTop = this._view.mainDisplay.scrollHeight;
  return true;
};

EasyReading.prototype._onKeyDownProcessUI = function(e) {
  var stop = false;
  // Configurable "switch to native at bottom" key (default End; $/G kept as fixed
  // vi aliases). When the pref is off we don't preventDefault, so the key falls
  // through to the native terminal (term_view.onKeyDown continues past us).
  if (!e.ctrlKey && !e.altKey) {
    const prefs = readValuesWithDefault();
    if (prefs.easyReadingEndSwitchNative &&
        (e.key === prefs.easyReadingEndSwitchKey || e.key === '$' || e.key === 'G')) {
      this.switchToNativeAtBottom();
      e.preventDefault();
      return;
    }
  }
  if (!e.ctrlKey && !e.altKey) {
    switch (e.key) {
      case 'Backspace':
        stop = this._scrollBy(-this._turnPageLines);
        if (!stop)
          this.leaveCurrentPost();
        break;
      case 'ArrowRight':
      case ' ':
      case 't':
        stop = this._scrollBy(this._turnPageLines);
        if (!stop)
          this.leaveCurrentPost();
        break;
      case 'PageUp':
        this._scrollBy(-this._turnPageLines);
        stop = true;
        break;
      case 'PageDown':
        // Can't scroll any further AND the article isn't fully loaded ⇒ the auto-paging
        // transaction is stuck, and PgDn would silently do nothing (the reported
        // symptom). Kick it. See _kickPageDown.
        if (!this._scrollBy(this._turnPageLines))
          this._kickPageDown();
        stop = true;
        break;
      case 'ArrowLeft':
        this.stopEasyReading();
        break;
      case 'ArrowUp':
        stop = this._scrollBy(-1);
        if (!stop)
          this.leaveCurrentPost();
        break;
      case 'Enter':
      case 'ArrowDown':
        stop = this._scrollBy(1);
        if (!stop)
          this.leaveCurrentPost();
        break;
      case 'k':
        this._scrollBy(-1);
        stop = true;
        break;
      case 'j':
        this._scrollBy(1);
        stop = true;
        break;
      case 'Home':
      case '0':
      case 'g':
        stop = this._scrollTop();
        break;
      // "Switch to native at bottom" is handled at the top of this function
      // (configurable key + on/off pref). When that did NOT fire (pref off, or the
      // pressed key isn't the configured switch key), End/$/G still jump to the
      // article bottom — but stay in easy reading, like the official term. Symmetric
      // with Home/0/g (_scrollTop).
      case 'End':
      case '$':
      case 'G':
        stop = this._scrollBottom();
        break;
      case 'Tab':
        stop = true;
        break;
      default:
        if ("abf=+-[]ABF".indexOf(e.key) >= 0) {
          this.leaveCurrentPost();
          break;
        }
        // Any other key falls through to native PTT and may open an in-post prompt /
        // menu / editor (r 回應、X/% 推文、y 收暫存檔、h 說明、o 選項、p 播放、\ 色彩、
        // / 搜尋、; 指定頁、: 指定行、# 文章代碼、s 切換看板、數字 指定頁、左右捲 ,.<>…).
        // Switch to functionMode so we mirror whatever PTT draws LIVE (no hardcoded
        // overlay, no per-prompt parsing); do NOT preventDefault — the key still reaches
        // PTT. Exit is content-judged on settle (_evalFunctionModeExit).
        //
        // NOTE: there used to be a `"123456789hops;,./\\H#OP:<>"` swallow list here (an
        // upstream pre-functionMode leftover, robertabcd b346f46) that preventDefault'd
        // all those pmore function keys to a no-op, because the old self-drawn long page
        // had no way to show the native in-place menu they open and would cover it. With
        // functionMode that's solved — those keys now fall through here like any other.
        // Removed so 說明(h)/選單/搜尋/指定頁… work again. See docs/easy-reading.md.
        if (e.key.length === 1) {
          this._enterFunctionMode();
        }
        break;
    }
  } else if (e.ctrlKey && !e.altKey) {
    switch (e.key) {
      case 'f':
        this._scrollBy(this._turnPageLines);
        stop = true;
        break;
      case 'b':
        this._scrollBy(-this._turnPageLines);
        stop = true;
        break;
      case 'h':
        stop = this._scrollBy(-this._turnPageLines);
        if (!stop)
          this.leaveCurrentPost();
        break;
      default:
        if ("@^_?".indexOf(e.key) >= 0) {
          stop = true;
          break;
        }
    }
  }
  if (stop)
    e.preventDefault();
};

// 好讀長頁裡的滑鼠點擊。文章模式現在只有一種滑鼠動作：左側帶＝離開。
//
// 舊版還依 mouseCursor 分派 PageUp/PageDown/Home/End/`[`/`]`/`=`/重新整理，但那些
// 區域在重新設計後已經不存在（滾輪與鍵盤仍可翻頁；好讀長頁本來就交給瀏覽器捲動）。
//
// **刻意不 preventDefault**：讓上層 App.onMouse_click 的 ACT_EXIT_ARTICLE 真的把
// 左方向鍵送出去，server 端才會真的離開文章 —— 這裡只負責先把好讀狀態機收掉。
EasyReading.prototype._onMouseClick = function(e) {
  if (!this._enabled || !this.startedEasyReading)
    return;
  // `buf.mouseAction` 是**刻意**的單一真相源：純函式決策層 mouse_regions.js 算出動作
  // 後寫進 termBuf，所有消費端（這裡、App.onMouse_click、底色）讀同一格。契約見
  // docs/mouse.md —— 這裡不要自己另算一份區域判斷。
  if (this._termBuf.mouseAction === ACT_EXIT_ARTICLE)
    this.stopEasyReading();
};
