// 看板列表平滑捲動（我的最愛／分類看板子分類）——把「列表好讀」那套捲動模型
// 搬到 PTT `choose_board` 的畫面上。
//
// 與 `list_session.js`（文章列表好讀 v5）**平行新寫、共用基礎設施**，不去泛化那支
// 3300 行的檔案：它的 v5 合約（封閉互動＋確定性交易）已經穩定，adapter 化會同時
// 動到已上線的路徑，風險／報酬不成比例（handoff §6.1）。共用的是純函式與 render
// 層：`list_scroll.js`（捲動數學）、`render/screen.js` 的 `.listBodyView` 視口、
// `command_queue.js`（同一條佇列，一次只有一個鍵在線上）、`list_window.js` 的
// `labelListCursor` 與 `pruneListToSegment`（由 term_view 的累積端呼叫）、
// `list_session.js` 的 `mergeListPage` / `flattenListBuffer` / `evictListBuffer` /
// `bufferEdgeNum`。
//
// 與文章列表的四個**結構性差異**（決定了這支為什麼比較短）：
//   1. 編號＝1-based 絕對位置且**分頁對齊**（board.c:1710-1716）⇒ 跨頁零重疊，
//      抓頁只要一腿跳號（board_list_parse.boardListFetchTarget），連「錨點跳號
//      ＋PgUp/PgDn」的兩腿都省了，也不必處理 PgUp/PgDn 的 wrap（board.c:1760-1785）。
//   2. 沒有置底文、沒有黑名單過濾 ⇒ 序列就是整份緩衝，`windowVisibleSequence` /
//      `visibleListIndices` / pinned 那整套全部不需要。
//   3. 使用者可就地編輯清單（`a`/`t`/`D`/`m`/`S`/`y`/`c`/`/`）⇒ 這些鍵一律走
//      passthrough（切原生鏡像＋代送），回來時**整份重建**，不 resume 舊緩衝。
//   4. 離開畫面就收攤（不跨畫面保留緩衝）：`y`/`c`/`/`／進出分類都會換掉整個
//      編號空間，預設每次進入重新 seed 才是安全的（handoff §6.5）。
//
// 詳細設計與 PTT 端事實見 docs/board-list-smooth-scroll.md。

import {
  BRD_HEADER_ROWS,
  classifyBoardListScreen,
  boardListContextKind,
  boardListFetchTarget,
  boardListFetchVerdict,
  isBoardListSeparatorRow,
  isBoardListBlockedRow
} from './board_list_parse';
import { bufferEdgeNum } from './list_session';
import { rowToText } from './comment_parse';
import {
  topPosFromScrollTop,
  anchorScrollTop,
  revealScrollTop,
  revealPlan,
  maxScrollTopFor,
  isRowVisible
} from './list_scroll';
import {
  defineOwnedRenderMode,
  OWNER_BOARD_LIST,
  BRD_CMD_PREFIX,
  isBoardListCommandKind
} from './list_render_owner';
import { keyEventToBytes } from './term_keyboard';
import { u2b, ansiHalfColorConv, normalizePasteText } from './string_util';
import { clickableColStart } from './mouse_regions';
import { LEFT_ARROW } from './function_key_plan';
import { readValuesWithDefault } from './pref_storage';

// 進佇列的命令一律帶 BRD_CMD_PREFIX（'brd-'）：那是兩個列表 session 共用同一條
// CommandQueue 的所有權判準，定義在 js/list_render_owner.js（兩邊都 import 的葉子
// 模組，避免 list_session ↔ board_list_session 的循環相依）。

// 預設值與理由完全比照 list_session.js（同一個 PTT、同一條線路）：
// PTT 約 90ms 回應 ＋ term_buf 的 SETTLE_MS(50ms) ⇒ 250ms 靜默已屬異常，
// 先送 \f 探針拿確定的全幅畫面，而不是凍著畫面空等秒級逾時。
const CMD_PROBE_AFTER_MS = 250;
const CMD_PROBE_WINDOW_MS = 600;
const CMD_HARD_MS = 1200;
const PREFETCH_HARD_MS = 1500;
// passthrough／開文／離開這類「畫面已經是原生鏡像或即將換頁」的命令：窗開大一點，
// 它們沒有凍住任何東西，提早收掉只會讓 functionMode 提前結束吸收（同 list_session）。
const NATIVE_PASSTHROUGH_MS = 3000;
// 凍結畫面的絕對後盾：任何一條回呼沒跑到都不能讓畫面永遠凍住 ＋ 永遠吞鍵。
const FROZEN_WATCHDOG_MS = 2500;
// 非導覽操作結束後自動切回平滑捲動（pref enableListNativeAutoResume）。兩個常數
// 的取值與理由完全同 list_session.js，那裡有完整說明（RESUME_QUIET_MS 不是體感
// 旋鈕，它堵的是「一個回應 settle 兩次」那個洞；RESUME_GRACE_MS 擋回復後的殘餘幀）。
const RESUME_QUIET_MS = CMD_PROBE_AFTER_MS;
const RESUME_GRACE_MS = 400;
// A 類鍵＝原地重繪、清單內容與編號空間不變（mbbsd/board.c#choose_board 的 case 表，
// 枚舉即合約）：
//   t     fav_tag/admtag → head=9999 全重畫，並 fall through 到 KEY_DOWN（游標下移一列）
//   v V   brc_toggle_all_read → show_brdlist(head,0,newflag) 原地重畫
// **`*`（tag all）刻意不在這一組**：它一次翻掉整份清單的 tag 標記，緩衝裡其他頁
// 會殘留舊標記 ⇒ 走 B 類（切原生，回來整份重建）。同理 `/` `S` `s` `y` `a` `m` `D`…
const INPLACE_KEYS = 'tvV';

// 切原生時提示語的尾巴。自動回復開著＝「做完就回來」；關掉＝維持舊措辭（那時行為
// 也真的是舊的）。留著舊措辭比沒提示更糟，所以每一處都走這一支。
function nativeResumeHint() {
  return readValuesWithDefault().enableListNativeAutoResume
    ? '（操作完成後自動恢復）'
    : '（進入看板或回上層後恢復平滑捲動）';
}
// 背景預抓最多幾頁（每頁 20 列）。看板列表通常只有幾十到幾百項，三頁足以蓋滿
// 視口與前後緩衝，其餘由 demand 補。
const FILL_MAX_PAGES = 3;
// 連發判定（同 list_session.NAV_BURST_MS）：連續導覽一律 instant，否則瀏覽器的
// programmatic 平滑捲動每次都從曲線起點重跑 ⇒ 按住鍵只會慢慢爬。
const NAV_BURST_MS = 250;
const SCROLL_ANIM_MAX_MS = 1000;

function prefersReducedMotion() {
  return !!(
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

// ---------------------------------------------------------------------------
// 狀態機（純 reducer）
// ---------------------------------------------------------------------------
//
// idle         沒接管（原生畫面、原生鍵盤）
// active       畫累積緩衝，本地導覽
// functionMode 原生 LIVE 鏡像，所有鍵放行（自癒與 passthrough 的落點，黏性）
// opening      序列化交易在飛（開看板／離開／跳號），畫面凍住＋吞鍵
//
// 事件（全部是先算好的布林，便於窮舉測試）：
//   { type:'settle', ctx, inFlightKind, consumed, sameVariant, holdReason,
//     withinResumeGrace, engageEligible }
//   { type:'key', keyClass }
//   { type:'resume-probe', ... }（同 settle 的欄位；靜置探針量當下畫面合成）
//   { type:'pref-off' } | { type:'transaction-failed' }
//
// holdReason（functionMode 的停泊理由，同 list_session）：
//   'passthrough' 非白名單鍵／自癒降級 —— 靜置後由 resume-probe 自動重新 engage
//   'external'    aid_navigation／long_push 的多步序列停泊 —— **永不自動解除**
//   null          沒有停泊
export function transitionBoardListSession(state, event) {
  const stay = { next: state, actions: [] };

  if (event.type === 'pref-off')
    return state === 'idle' ? stay : { next: 'idle', actions: ['cleanup'] };

  switch (state) {
    case 'idle':
      if (event.type === 'settle' && event.ctx === 'brdlist' && event.engageEligible)
        return { next: 'active', actions: ['seed', 'start-fill'] };
      return stay;

    case 'active':
      if (event.type === 'settle') {
        switch (event.ctx) {
          case 'brdlist':
            // 同一份清單（footer 變體沒變）＝ 一般的重繪／我們自己的抓頁落地：
            // 累積已在 redraw 做完，這裡只要續抓。變體換了＝整個編號空間換了
            //（`y` 全部看板↔最愛 之類），必須重建。
            return event.sameVariant
              ? { next: 'active', actions: ['continue-fill'] }
              : { next: 'active', actions: ['rebuild'] };
          case 'article-list':
          case 'menu':
            // 真的離開看板列表了（進板／回主功能表）⇒ 收攤，畫面交給另一邊。
            return { next: 'idle', actions: ['cleanup'] };
          default:
            // brdlist-other（全部看板／newflag：本期不做，handoff I10）與各種
            // prompt／半繪。交易在飛或這一幀剛被命令消費掉 ⇒ 是預期中的中間幀；
            // 否則顯性降級到原生鏡像（v5 合約：失敗不得靜默）。
            // withinResumeGrace（不變量 N4）：剛自動回到平滑捲動的那一瞬間，
            // server 的殘餘幀還在路上，打到這裡就是「剛回來又被 banner 踢回原生」。
            return event.inFlightKind || event.consumed || event.withinResumeGrace
              ? stay
              : { next: 'functionMode', actions: ['enter-native'] };
        }
      }
      if (event.type === 'key') {
        switch (event.keyClass) {
          case 'nav':
            return { next: 'active', actions: ['move-selection'] };
          case 'open':
            return { next: 'opening', actions: ['begin-open'] };
          case 'leave':
            return { next: 'opening', actions: ['begin-leave'] };
          case 'passthrough':
          case 'transact':
            // 實際的序列由呼叫端跑（sync 腿 → 切鏡像 → 代送），reducer 只負責
            // 把狀態挪過去，好讓在途的 settle 被吸收、其他鍵被吞掉。
            return { next: 'functionMode', actions: [] };
          case 'native-inplace':
            // A 類鍵（INPLACE_KEYS）：**全程不切原生**。同樣借用 functionMode
            // 吸收在途 settle／吞鍵，但 render 維持 frozen，落地由
            // _enqueueInplaceKey 的 expect 判定後 _resumeInPlace 直接回 buffer。
            return { next: 'functionMode', actions: [] };
          default:
            return stay;
        }
      }
      return stay;

    case 'functionMode':
      // 靜置探針：非導覽操作做完了 ⇒ 自動回到平滑捲動。
      // **不可以走「回 idle 等下一個 settle」**：畫面靜止時不會再有 settle，那會
      // 卡死（list_session 的 menu 分支註解已經寫過一次這個坑）。所以這裡直接
      // 送到 active 並自己 seed —— `_enterNative` 已經把緩衝整份丟掉了，本來就
      // 該重建（非白名單鍵每一個都會改寫清單內容或整個編號空間）。
      if (event.type === 'resume-probe') {
        if (event.holdReason !== 'passthrough') return stay; // 不變量 N1
        if (event.inFlightKind) return stay;
        if (event.ctx !== 'brdlist') return stay;
        if (!event.engageEligible) return stay;
        return { next: 'active', actions: ['seed', 'start-fill'] };
      }
      if (event.type === 'settle') {
        if (event.inFlightKind) return stay; // 序列化交易在飛，繼續鏡像
        // 黏性原生（同 list_session 的 holdReason）：切原生之後就**停在原生**，
        // 只有真正的情境變換（進板／回選單）或上面那個靜置探針才放開；否則反覆
        // 按 y/v 會讓畫面在緩衝與原生之間閃動。
        if (event.ctx === 'article-list' || event.ctx === 'menu')
          return { next: 'idle', actions: ['cleanup'] };
        return stay;
      }
      return stay; // 原生鏡像下鍵盤 hook 根本不會呼叫進來

    case 'opening':
      if (event.type === 'transaction-failed')
        return { next: 'functionMode', actions: ['enter-native'] };
      // 交易的落地由 CommandQueue 的 expect 判定（onDone 會自己收攤），這裡只要
      // 把使用者的鍵吞掉、把中間幀吸收掉。
      return stay;

    default:
      return stay;
  }
}

// ---------------------------------------------------------------------------
// BoardListSession
// ---------------------------------------------------------------------------

export function BoardListSession(core, view, termBuf, queue) {
  this._core = core;
  this._view = view;
  this._termBuf = termBuf;
  this._queue = queue;

  this.state = 'idle';
  this._variant = null; // 'fav' | 'class'（編號空間的別名守門）
  this._selectedNum = null; // 游標選的看板編號
  this._serverNum = null; // server 真游標所在的編號（null＝不確定）
  this._topNum = null; // 捲動錨：視口頂那一列的編號
  this._scrollFrac = 0;
  this._edgeUp = false;
  this._edgeDown = false;
  this._fillPages = 0;
  this._fillTarget = 0;
  this._frozenWatchdog = null;
  // functionMode 的停泊理由（'passthrough' | 'external' | null）——語意與拆分的
  // 理由同 list_session._holdReason（'external' 永不自動解除，不變量 N1）。
  this._holdReason = null;
  // 靜置探針的 timer 與它的兩個時鐘來源（見 RESUME_QUIET_MS）。
  this._resumeProbe = null;
  this._lastServerActivityAt = 0;
  this._lastUserByteAt = 0;
  this._resumedAt = 0;
  // pruneListToSegment 的樞紐覆寫（undefined ＝用選取）。遠跳期間換成落點所在的
  // 那一段，否則新頁與舊緩衝之間的「洞」會讓連續段守門把**剛抓到的落點**丟掉。
  this._prunePivotOverride = undefined;
  this._seqCache = null;

  this._anchorOverride = false;
  this._pendingReveal = null;
  this._scrollRaf = null;
  this._lastScrollTop = 0;
  this._scrollAnim = null;
  this._lastNavAt = 0;

  defineOwnedRenderMode(this, termBuf, OWNER_BOARD_LIST);
  termBuf.addEventListener('screenSettled', this._onScreenSettled.bind(this));
}

BoardListSession.prototype = {
  // ---- settle pipeline ------------------------------------------------------

  _onScreenSettled: function() {
    const snap = this._termBuf.settleSnapshot;
    // 純本地重繪（server 這個視窗一列都沒寫、游標也沒動）不得驅動狀態轉移，
    // 也不得餵給 queue 的 expect —— 同 list_session 的第一道守門。
    if (snap && snap.changedRows && snap.changedRows.size === 0 && !snap.cursorMoved)
      return;
    // server 活動後的靜止點 ⇒ 自動回復的時鐘從這裡起算（上面已排除純本地重繪）。
    this._lastServerActivityAt = Date.now();
    // 還沒接管、pref 又關著 ⇒ 這一幀不可能有我們的事。提早退出省掉 24 次
    // getRowText —— 這個功能預設是關的，而 settle 在每篇文章的每次翻頁都會來。
    if (this.state === 'idle' && !this._engageEligible()) return;
    const facts = this._collectFacts(snap);
    // **佇列所有權**：只在 in-flight 是我們自己的命令時才 onSettle，否則會把
    // ListSession／AidNavigation／LongPush 的命令用錯的 facts 判掉（見
    // BRD_CMD_PREFIX 的說明）。
    const consumed = isBoardListCommandKind(this._queue.inFlightKind)
      ? this._queue.onSettle(snap, facts)
      : null;
    if (consumed === 'done' && (this._renderMode === 'frozen' || this.state === 'opening'))
      this._armFrozenWatchdog();
    this._dispatch(this._settleEvent(facts, consumed), facts);
    this._scheduleResumeProbe();
  },

  _collectFacts: function(snap) {
    const buf = this._termBuf;
    const rowTexts = [];
    for (let r = 0; r < buf.rows; ++r) rowTexts.push(buf.getRowText(r, 0, buf.cols));
    const facts = {
      rowTexts: rowTexts,
      curX: snap ? snap.curX : buf.cur_x,
      curY: snap ? snap.curY : buf.cur_y,
      rows: buf.rows,
      changedRows: snap ? snap.changedRows : null
    };
    facts.brd = classifyBoardListScreen(facts);
    facts.ctx = facts.brd
      ? facts.brd.engageable
        ? 'brdlist'
        : 'brdlist-other'
      : boardListContextKind(facts);
    return facts;
  },

  _settleEvent: function(facts, consumed) {
    return {
      type: 'settle',
      ctx: facts.ctx,
      inFlightKind: this._queue.inFlightKind,
      consumed: !!consumed,
      sameVariant: !!(facts.brd && facts.brd.variant === this._variant),
      holdReason: this._holdReason,
      withinResumeGrace: Date.now() - this._resumedAt < RESUME_GRACE_MS,
      engageEligible: this._engageEligible()
    };
  },

  // pref 開著＝L1 凍結交易＋L2 自動回復生效；關掉＝逐位元回到 2026-09-03 之前。
  _autoResumeEnabled: function() {
    return !!readValuesWithDefault().enableListNativeAutoResume;
  },

  // pref 開著 ∧ 標準 24 列終端 ∧ 文章好讀沒有正在讀文（同 list_session 的守門，
  // 那條是為了不與文章模式的 render 分支搶畫面）。
  _engageEligible: function() {
    return (
      !!readValuesWithDefault().enableBoardListSmoothScroll &&
      this._termBuf.rows === 24 &&
      !this._termBuf.startedEasyReading
    );
  },

  // ---- 靜置探針（非導覽操作完成 → 自動回平滑捲動）----------------------------
  // 形狀與 list_session 完全相同（同一個 PTT、同一條線路、同一組洞），差別只有
  // 「回復＝重新 seed」而不是 resume 舊緩衝：_enterNative 已經把緩衝丟光了。

  // 使用者往 PTT 送了 byte。**只記時間戳，不得有任何其他副作用**（不變量 N2）。
  noteNativeInput: function() {
    this._lastUserByteAt = Date.now();
    this._scheduleResumeProbe();
  },

  _scheduleResumeProbe: function(delay) {
    if (this._resumeProbe) {
      clearTimeout(this._resumeProbe);
      this._resumeProbe = null;
    }
    if (this._holdReason !== 'passthrough') return;
    if (!this._autoResumeEnabled()) return;
    const self = this;
    this._resumeProbe = setTimeout(function() {
      self._resumeProbe = null;
      self._tryResumeProbe();
    }, delay == null ? RESUME_QUIET_MS : delay);
  },

  _cancelResumeProbe: function() {
    if (!this._resumeProbe) return;
    clearTimeout(this._resumeProbe);
    this._resumeProbe = null;
  },

  // 只讀不寫（不變量 N2）：量當下畫面，唯一的輸出是一個合成事件。
  _tryResumeProbe: function() {
    if (this._holdReason !== 'passthrough' || !this._autoResumeEnabled()) return;
    const quietSince = Math.max(this._lastServerActivityAt, this._lastUserByteAt);
    const waited = Date.now() - quietSince;
    if (waited < RESUME_QUIET_MS) return this._scheduleResumeProbe(RESUME_QUIET_MS - waited);
    // 「PTT 完全忽略這個鍵」是零 byte 零 settle ⇒ 命令只能等 timeout，這裡補排一次。
    if (this._queue.inFlightKind) return this._scheduleResumeProbe();
    const facts = this._collectFacts(null);
    if (facts.ctx !== 'brdlist') return; // 等下一個 settle 重新排
    const event = this._settleEvent(facts, null);
    event.type = 'resume-probe';
    const before = this.state;
    this._dispatch(event, facts);
    // 換畫面永不靜默（不變量 N7）：使用者沒按任何鍵，畫面卻換回來了。
    if (before !== this.state && this.state === 'active' && this._view.flashListHint)
      this._view.flashListHint('操作完成，已回到平滑捲動', 2000);
  },

  _dispatch: function(event, facts) {
    const r = transitionBoardListSession(this.state, event);
    if (r.next !== this.state)
      this._core.debugRecorder?.log('boardList.transition', {
        from: this.state,
        event: event,
        to: r.next
      });
    this.state = r.next;
    for (let i = 0; i < r.actions.length; ++i) this._runAction(r.actions[i], facts);
  },

  _runAction: function(action, facts) {
    switch (action) {
      case 'seed':
        return this._seed(facts);
      case 'start-fill':
        return this._startFill();
      case 'continue-fill':
        return this._maybeFill();
      case 'rebuild':
        return this._rebuild(facts);
      case 'enter-native':
        return this._enterNative(facts);
      case 'cleanup':
        return this._cleanup();
      default:
        return; // move-selection / begin-* 帶鍵盤上下文，由 onKeyDown 執行
    }
  },

  // ---- 外部入口 --------------------------------------------------------------

  // pref 在畫面靜止時被打開（不會再有 settle 了）：把當下畫面當成剛 settle 評估。
  evaluateNow: function() {
    if (this.state !== 'idle') return;
    const facts = this._collectFacts(null);
    this._dispatch(this._settleEvent(facts, null), facts);
  },

  disable: function() {
    this._dispatch({ type: 'pref-off' }, null);
  },

  // 外部序列化導覽（aid_navigation / long_push）要接管這條線路：先停到原生鏡像，
  // 把中間的 settle 吸收掉，別讓我們自己的交易插隊。
  beginExternalNavigation: function() {
    if (this.state === 'idle') return;
    this.state = 'functionMode';
    // 'external'：**永不自動解除**（不變量 N1）——序列途中的 brdlist 幀很多，
    // 讓靜置探針看到就會把別人的序列從中間截斷。
    this._enterNative(null, { hold: 'external' });
  },

  // ---- 鍵盤 -----------------------------------------------------------------

  onKeyDown: function(e) {
    // 瀏覽器／app 層的剪貼簿組合鍵留給 term_view 後面那幾個 handler。
    const clipboard =
      (e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        ['c', 'a', 'v', 'x'].indexOf((e.key || '').toLowerCase()) !== -1) ||
      (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'Insert');
    if (clipboard || e.altKey || e.metaKey) return;

    if (this._busyHint()) {
      e.preventDefault();
      return;
    }
    if (this.state !== 'active') return;

    const key = this._classifyKey(e);
    if (key.class === 'ignore') return; // 不 preventDefault：F12／CapsLock 歸瀏覽器
    if (key.class === 'passthrough') {
      this._beginNativePassthrough(e);
      return;
    }
    e.preventDefault();
    if (key.class === 'jump-digit') {
      this._beginJumpCollect(key.digit);
      return;
    }
    if (key.class === 'native-inplace') {
      this._beginInplaceTransaction(key.bytes);
      return;
    }
    this._runKeyClass(key, { repeat: !!e.repeat });
  },

  _runKeyClass: function(key, opts) {
    const r = transitionBoardListSession(this.state, {
      type: 'key',
      keyClass: key.class
    });
    this.state = r.next;
    for (let i = 0; i < r.actions.length; ++i) {
      const a = r.actions[i];
      if (a === 'move-selection') this._moveSelection(key.op, opts);
      else if (a === 'begin-open') this._beginOpen();
      else if (a === 'begin-leave') this._beginLeave();
      else this._runAction(a, null);
    }
  },

  // 白名單即合約。同義鍵集合照 board.c:1751-1840 的 switch：
  //   PgUp: KEY_PGUP / 'P' / 'b'（**多了 'b'**，read.c 沒有）
  //   PgDn: KEY_PGDN / ' ' / 'N'
  //   ↑: KEY_UP / 'p' / 'k'   ↓: KEY_DOWN / 'n' / 'j'
  //   End: KEY_END / '$'      Home: KEY_HOME / '0'（'0' 在 board.c 就是 Home）
  //   開: KEY_RIGHT / KEY_ENTER / 'r' / 'l'
  //   離開: KEY_LEFT / 'q'（**沒有 'e'**，那是 read.c 才有的同義鍵）
  // Ctrl-F/Ctrl-B 刻意不納入，維持 Ctrl 組合與瀏覽器快捷鍵的分界（同 list_session）。
  _classifyKey: function(e) {
    // 送不出任何 byte 的鍵（CapsLock / F1-F12 / NumLock…）：吞掉、不轉態。
    // 判準就是送出路徑本身（term_keyboard），不硬列鍵清單。
    if (keyEventToBytes(e) == null) return { class: 'ignore' };
    if (e.ctrlKey) return { class: 'passthrough' };
    switch (e.key) {
      case 'ArrowUp':
      case 'k':
      case 'p':
        return { class: 'nav', op: 'up' };
      case 'ArrowDown':
      case 'j':
      case 'n':
        return { class: 'nav', op: 'down' };
      case 'PageUp':
      case 'P':
      case 'b':
        return { class: 'nav', op: 'pgup' };
      case 'PageDown':
      case ' ':
      case 'N':
        return { class: 'nav', op: 'pgdn' };
      case 'Home':
      case '0':
        return { class: 'nav', op: 'home' };
      case 'End':
      case '$':
        return { class: 'nav', op: 'end' };
      case 'Enter':
      case 'ArrowRight':
      case 'r':
      case 'l':
        return { class: 'open' };
      case 'ArrowLeft':
      case 'q':
        return { class: 'leave' };
      default:
        if (/^[1-9]$/.test(e.key)) return { class: 'jump-digit', digit: e.key };
        // A 類鍵（INPLACE_KEYS）：原地重繪 ⇒ 凍結交易，全程不切原生。
        // pref 關掉時整組落回 passthrough（逐位元回到 2026-09-03 之前）。
        if (
          e.key.length === 1 &&
          INPLACE_KEYS.indexOf(e.key) !== -1 &&
          this._autoResumeEnabled()
        )
          return { class: 'native-inplace', bytes: keyEventToBytes(e) };
        return { class: 'passthrough' };
    }
  },

  // 畫面上的功能鍵按鈕（`[←][q]回上層` / `[→][r]閱讀` / `[c]新文章`…）點下去。
  // 與 list_session.onFunctionKey 同形：byte 層只認明確的方向／翻頁序列，其餘
  // 一律 passthrough（切原生＋送出），方向安全。
  onFunctionKey: function(bytes) {
    if (this._renderMode === 'native') return false;
    if (this._busyHint()) return true;
    if (this.state !== 'active') return false;
    if (!bytes) return true;
    const cls = this._classifyBytes(bytes);
    if (cls.class === 'passthrough') {
      this._beginPassthroughBytes(bytes);
      return true;
    }
    this._runKeyClass(cls, null);
    return true;
  },

  onMouseExitClick: function() {
    return this.onFunctionKey(LEFT_ARROW);
  },

  _classifyBytes: function(bytes) {
    switch (bytes) {
      case '\x1b[A':
        return { class: 'nav', op: 'up' };
      case '\x1b[B':
        return { class: 'nav', op: 'down' };
      case '\x1b[5~':
        return { class: 'nav', op: 'pgup' };
      case '\x1b[6~':
        return { class: 'nav', op: 'pgdn' };
      case '\x1b[1~':
        return { class: 'nav', op: 'home' };
      case '\x1b[4~':
        return { class: 'nav', op: 'end' };
      case '\x1b[C':
      case '\r':
        return { class: 'open' };
      case LEFT_ARROW:
        return { class: 'leave' };
      default:
        return { class: 'passthrough' };
    }
  },

  // 交易在飛時吞掉輸入 —— 但**永不靜默**（不變量：吞掉使用者的輸入必須有提示）。
  // 回 true ＝已吞掉。
  _busyHint: function() {
    if (this.state !== 'opening' && !(this.state === 'functionMode' && this._renderMode === 'frozen'))
      return false;
    if (this._view.flashListHint)
      this._view.flashListHint('看板列表：指令處理中，請稍候…');
    return true;
  },

  // ---- passthrough（非白名單鍵＝一鍵切原生＋代送）------------------------------

  _beginNativePassthrough: function(e) {
    let bytes = e.ctrlKey ? null : keyEventToBytes(e);
    if (bytes && bytes.length === 1 && bytes.charCodeAt(0) > 127) bytes = u2b(bytes);
    if (bytes == null) {
      // Ctrl 組合：沒辦法序列化代送（我們不擁有這個鍵）。立刻切鏡像，事件不
      // preventDefault ⇒ 原生鍵盤路徑緊接著會把它送出去。
      const r = transitionBoardListSession(this.state, {
        type: 'key',
        keyClass: 'passthrough'
      });
      this.state = r.next;
      this._enterNative();
      if (this._view.flashListHint)
        this._view.flashListHint('已切至原生操作' + nativeResumeHint(), 4000);
      return;
    }
    e.preventDefault();
    this._beginPassthroughBytes(bytes);
  },

  // passthrough 的共用序列：真游標落後就先跳號同步（`v`/`m`/`t`/`D` 這些鍵都是
  // **對游標所在那一列**動作的），再切原生鏡像，最後才把鍵送出去。
  // 兩步一定要序列化：同一 tick 送 "N\r" + 鍵會踩 pttbbs 的 typeahead（協定 §2）。
  _beginPassthroughBytes: function(bytes, opts) {
    const kind = (opts && opts.kind) || 'native-key';
    const hint =
      opts && 'hint' in opts
        ? opts.hint
        : '已切至原生操作' + nativeResumeHint();
    const r = transitionBoardListSession(this.state, {
      type: 'key',
      keyClass: 'passthrough'
    });
    this.state = r.next;
    const self = this;
    const finish = function() {
      self._enterNative();
      self._queue.enqueue({
        keys: bytes,
        kind: BRD_CMD_PREFIX + kind,
        // 尾附 \f（同 list_session._enqueuePassthroughStep）：PTT 完全忽略某個鍵時
        // （無權限、非最愛清單按 `*`…）是**零 byte 零 settle**，命令只能等滿
        // NATIVE_PASSTHROUGH_MS(3s) 才 timeout ⇒ 使用者盯著原生畫面發呆，
        // 「操作完成後自動回平滑捲動」也無從觸發。協定 §6：igetch 全域攔截，
        // getdata/vgets/pmore/編輯器一律吃這條，零副作用。
        fullRepaint: true,
        expect: function() {
          return true; // 任何 settle 都是回應（畫面已經是原生鏡像，畫什麼都對）
        },
        timeoutMs: NATIVE_PASSTHROUGH_MS
      });
      if (hint && self._view.flashListHint) self._view.flashListHint(hint, 4000);
    };
    if (this._selectedNum != null && this._selectedNum !== this._serverNum) {
      this._freezeForTransaction();
      this._enqueueCursorSyncJump('native-sync-jump', finish, finish);
      return;
    }
    finish();
  },

  // ---- A 類鍵的凍結交易（L1：原地重繪的鍵全程不切原生）------------------------
  //
  // 形狀照抄 list_session._beginInplaceTransaction：凍住畫面 →（必要時）跳號同步
  // 真游標 → 送真鍵 → 等真回應 → 採用真落點。`t`/`v`/`V` 都是**對游標所在那一列**
  // 動作的（board.c:1802/1871），本地導覽零網路 ⇒ 真游標落後時必須先同步。
  _beginInplaceTransaction: function(bytes) {
    const r = transitionBoardListSession(this.state, {
      type: 'key',
      keyClass: 'native-inplace'
    });
    this.state = r.next; // functionMode（吸收 settle／吞鍵），render 仍是 frozen
    this._freezeForTransaction();
    const self = this;
    const send = function() {
      self._enqueueInplaceKey(bytes);
    };
    if (this._selectedNum != null && this._selectedNum !== this._serverNum) {
      this._enqueueCursorSyncJump('inplace-sync-jump', send, function() {
        self._degradeToNative('操作逾時，已切至原生模式');
      });
      return;
    }
    send();
  },

  _enqueueInplaceKey: function(bytes) {
    const self = this;
    let landed = null;
    this._queue.enqueue({
      keys: bytes,
      kind: BRD_CMD_PREFIX + 'native-inplace',
      // 保證必有一幀可判定（協定 §6：\f 全域被 igetch 攔截，零副作用）。
      fullRepaint: true,
      // 落地＝同一份清單（變體沒換）＋游標 park 在某一列。`v`/`V` 是
      // show_brdlist 全頁重畫，`t` 是 head=9999 全重畫＋游標下移一列，兩者都符合。
      expect: function(snap, facts) {
        if (
          facts.brd &&
          facts.brd.parked &&
          facts.brd.cursorNum != null &&
          facts.brd.variant === self._variant
        ) {
          landed = facts;
          return true;
        }
        return false;
      },
      timeoutMs: CMD_PROBE_AFTER_MS,
      probeTimeoutMs: CMD_PROBE_WINDOW_MS,
      hardTimeoutMs: CMD_HARD_MS,
      onDone: function() {
        self.state = 'active';
        const inBuf =
          !!landed && self._posOfNum(landed.brd.cursorNum) !== -1;
        // 落點不在緩衝（跳很遠）＝畫面本來就要換一份 ⇒ 整份重建。
        if (inBuf) self._resumeInPlace(landed);
        else self._rebuild(landed);
      },
      onFail: function() {
        self._degradeToNative('操作逾時，已切至原生模式');
      }
    });
  },

  // 凍結交易落地後回到 buffer。**不可以用 _adoptLanding**：那一支會把 _topNum
  // 重設成原生畫面頂端那一列（給「從原生鏡像回來」設計的）；A 類交易期間畫面是
  // 凍住的 buffer，套用會讓視野瞬間跳走。錨一律不動（不變量 N6），只 reveal。
  _resumeInPlace: function(facts) {
    this._holdReason = null;
    this._cancelResumeProbe();
    this._resumedAt = Date.now();
    this._renderMode = 'buffer';
    this._setLoading(false);
    this._view.hideCursor();
    const brd = facts && facts.brd;
    if (brd && brd.cursorNum != null) {
      this._serverNum = brd.cursorNum;
      this._selectedNum = brd.cursorNum;
    }
    // 同步重繪：把落地那一頁併回緩衝（tag／未讀標記的逐列變化靠這一趟生效）。
    this._forceRedraw();
    const pos = this._cursorPos();
    if (pos >= 0 && !this._isPosVisible(pos)) {
      this._pendingReveal = { pos: pos, block: 'nearest', behavior: 'auto' };
      this._forceRedraw();
    }
  },

  // 貼上（App.onPasteDone）與 IME 送字（term_view.onTextInput）。回 true ＝接手了。
  // 理由同 list_session：緩衝畫面下 PTT 開的 prompt 是**看不見的**，裸送 bytes
  // 會讓使用者以為畫面卡住；而且會與在飛的交易競態。
  onPaste: function(text) {
    return this._beginTextPassthrough(text, {
      normalize: true,
      kind: 'native-paste',
      hint: '已貼上並切至原生操作' + nativeResumeHint()
    });
  },

  noteTextInput: function(text) {
    return this._beginTextPassthrough(text, {
      normalize: false,
      kind: 'native-input',
      hint: '已切至原生操作' + nativeResumeHint()
    });
  },

  _beginTextPassthrough: function(text, opts) {
    if (this._busyHint()) return true;
    if (this.state !== 'active') return false;
    const src = opts.normalize ? normalizePasteText(text, this._view.lineWrap) : text;
    // CommandQueue 的 send 綁的是 RAW conn.send，convSend 會做的 Big5 轉換要在這裡做。
    const keys = ansiHalfColorConv(u2b(src));
    if (!keys) return false;
    this._beginPassthroughBytes(keys, opts);
    return true;
  },

  // ---- 滑鼠 -----------------------------------------------------------------

  // 左鍵單擊某一列＝把選取移到那一列並進入該看板（與原生滑鼠瀏覽同語意）。
  // **絕不放行到 App.onMouse_click**：那條依 server 的真實 24 列幾何直送方向鍵，
  // 我們畫的是自組的捲動視窗，兩套座標不對應（會進錯看板），而且繞過 CommandQueue。
  onMouseClick: function(renderRow, col) {
    if (this._renderMode === 'native') return;
    if (this.state !== 'active' || this._renderMode !== 'buffer') {
      if (this._view.flashListHint) this._view.flashListHint('看板列表：處理中，請稍候…');
      return;
    }
    const idx = renderRow - BRD_HEADER_ROWS;
    if (idx < 0) return; // header
    const guard = !!(
      this._termBuf &&
      this._termBuf.useMouseBrowsing &&
      this._view &&
      this._view.mouseMisclickGuard
    );
    // 防誤觸的欄位規則沿用列表那一套（`buf.pageState` 在看板列表仍是 2，
    // hover 底色與 pointer 也是照這個算的，見 term_view.onListMouseMove）。
    if (col < clickableColStart(2, guard)) return;
    const nums = this._termBuf.brdListLineNums || [];
    if (idx >= nums.length) return; // 短清單補到 bodyRows 的空白列
    this._selectedNum = nums[idx];
    this._forceRedraw(); // 先把游標畫到點擊的那一列，再凍住（否則凍的是點擊前）
    this._runKeyClass({ class: 'open' }, null);
  },

  // 右鍵選單「前已讀後未讀」在看板列表沒有對應功能（那是 read.c 的 b_mark_read_unread）。
  // 明確回 null，讓 ContextMenu 的判定維持單一真相源。
  markReadTargetAtRow: function() {
    return null;
  },

  // ---- 滾輪／捲動 ------------------------------------------------------------

  onWheel: function(op) {
    if (this.state !== 'active' || this._renderMode !== 'buffer') return;
    this._moveSelection(op, { repeat: true });
  },

  // 滾輪已經捲到邊（放行給瀏覽器之前問的）。捲不動就沒有 scroll 事件，而 demand
  // 正是由它驅動的 —— 緩衝只有一頁時往上滾會看起來卡住。
  onWheelAtEdge: function(dir) {
    if (this.state !== 'active' || this._renderMode !== 'buffer') return;
    const screen = this._screen();
    if (!screen || !screen.getListScrollTop) return;
    const px = screen.getListScrollTop();
    const atEdge = dir < 0 ? px <= 0 : px >= this._maxScrollTop() - 1;
    if (!atEdge) return;
    this._maybeDemand(dir);
  },

  onDomScroll: function() {
    if (this.state !== 'active' || this._renderMode !== 'buffer') return;
    if (this._scrollRaf != null) return;
    const self = this;
    const raf =
      typeof requestAnimationFrame === 'function'
        ? function(fn) {
            return requestAnimationFrame(fn);
          }
        : function(fn) {
            return setTimeout(fn, 16);
          };
    this._scrollRaf = raf(function() {
      self._scrollRaf = null;
      self._onScrollFrame();
    });
  },

  _onScrollFrame: function() {
    if (this.state !== 'active' || this._renderMode !== 'buffer') return;
    const screen = this._screen();
    if (!screen || !screen.getListScrollTop) return;
    const px = screen.getListScrollTop();
    const dir = px > this._lastScrollTop ? 1 : px < this._lastScrollTop ? -1 : 0;
    this._lastScrollTop = px;
    this._scrollAnimSettled(px);
    this.captureScrollAnchor();
    if (!dir) return;
    this._maybeDemand(dir);
  },

  // ---- actions ---------------------------------------------------------------

  _seed: function(facts) {
    this._holdReason = null;
    this._cancelResumeProbe();
    this._resumedAt = Date.now(); // 不變量 N4：殘餘幀不得打到 active 的 catch-all
    this._resetBuffer();
    this._variant = facts.brd.variant;
    this._renderMode = 'buffer';
    this._view.hideCursor();
    this._adoptLanding(facts);
    this._forceRedraw(); // 同步：這一趟 redraw 會把當前這頁累積進緩衝
    // 背景填充由 reducer 緊接著的 'start-fill' 動作啟動（_startFill → _maybeFill）。
  },

  _rebuild: function(facts) {
    this._resetBuffer();
    if (facts && facts.brd) this._variant = facts.brd.variant;
    this._adoptLanding(facts);
    this._forceRedraw();
    this._maybeFill();
  },

  // 採用原生畫面的游標與視口頂端當我們的錨 ⇒ 切換模式那一瞬間畫面不動。
  _adoptLanding: function(facts) {
    const brd = facts && facts.brd;
    this._serverNum = brd ? brd.cursorNum : null;
    this._selectedNum = brd ? brd.cursorNum : null;
    this._topNum = brd ? brd.topNum : null;
    this._scrollFrac = 0;
    // 這一幀的錨由 action 指定，不要讓緊接著的 captureScrollAnchor 拿「還沒掛回
    // DOM 的視口」（scrollTop 恆 0）覆寫掉它。
    this._anchorOverride = true;
  },

  _resetBuffer: function() {
    this._breakScroll();
    this._seqCache = null;
    this._prunePivotOverride = undefined;
    this._view.resetBoardListAccumulation();
    this._termBuf.brdListLines = [];
    this._termBuf.brdListLineNums = [];
    this._edgeUp = false;
    this._edgeDown = false;
    this._fillPages = 0;
  },

  _startFill: function() {
    this._fillTarget = readValuesWithDefault().easyReadingListPrefetchCount || 0;
    this._fillPages = 0;
    this._maybeFill();
  },

  // 背景填充：先往下、下面到邊了再往上。一次一條命令，由 onDone 串起來，絕不平行。
  //
  // **兩個方向都要**（2026-09-03 實測）：`choose_board` 的 `num` 是 static
  //（board.c:1646），PTT 記得上次離開的位置 ⇒ 進來常常直接落在**最後一頁**。
  // 只往下填的話那一腿一次就撞到板尾（`search_num` 夾值），背景填充就此結束，
  // 畫面只剩落點那幾列＋一整片空白列，上面整份清單要等使用者自己按 ↑ 才補得回來。
  //
  // 「視口還沒填滿」是**無條件**要補的（比 _fillTarget 更優先）：那不是預抓，
  // 是這一頁本身畫不滿。
  _maybeFill: function() {
    if (this.state !== 'active') return;
    if (!this._queue.idle) return;
    if (this._fillPages >= FILL_MAX_PAGES) return;
    const len = this._sequenceLength();
    if (!len) return;
    const shortWindow = len < this._viewportTopPos() + this._bodyRows();
    if (!shortWindow && len >= this._fillTarget) return;
    if (!this._edgeDown) this._enqueueFetch(1, 'fill');
    else if (!this._edgeUp) this._enqueueFetch(-1, 'fill');
  },

  // 往行進方向保留兩頁緩衝（一頁太晚：抓取到使用者撞到邊界才開始）。
  _maybeDemand: function(direction) {
    if (this.state !== 'active' || !this._queue.idle) return;
    const len = this._sequenceLength();
    if (!len) return;
    const top = this._viewportTopPos();
    const B = this._bodyRows();
    if (direction < 0 && top < 2 * B && !this._edgeUp) this._enqueueFetch(-1, 'key');
    else if (direction > 0 && len - (top + B) < 2 * B && !this._edgeDown)
      this._enqueueFetch(1, 'key');
  },

  // 抓一頁：跳到緊鄰緩衝邊界的編號，server 會把 `head` 對齊到含它的那一頁。
  // 一腿同時做到「抓頁」與「探邊」（見 board_list_parse.boardListFetchVerdict）。
  _enqueueFetch: function(dir, origin) {
    const nums = this._termBuf.brdListLineNums || [];
    const base = bufferEdgeNum(nums, dir);
    if (base == null) return;
    const target = boardListFetchTarget({ base: base, dir: dir });
    if (target == null) {
      // 已經在第 1 項：上緣確定，不必送任何 byte。
      this._edgeUp = true;
      return;
    }
    const self = this;
    let landed = null;
    this._queue.enqueue({
      keys: String(target) + '\r',
      kind: BRD_CMD_PREFIX + (dir < 0 ? 'fetch-up' : 'fetch-down'),
      expect: function(snap, facts) {
        const brd = facts.brd;
        if (!brd || !brd.parked || brd.cursorNum == null) return false;
        landed = brd.cursorNum;
        return true;
      },
      // 跳號腿一律 fullRepaint：目標與真游標同頁時 PTT 一個 byte 都不送，
      // 而 term_buf 只在有活動時起 settle 計時器 ⇒ 沒有 \f 就只能等到逾時
      //（協定 §6；同 list_session 的每一條跳號腿）。
      fullRepaint: true,
      timeoutMs: CMD_PROBE_AFTER_MS,
      probeTimeoutMs: CMD_PROBE_WINDOW_MS,
      hardTimeoutMs: PREFETCH_HARD_MS,
      onDone: function() {
        self._serverNum = landed;
        const v = boardListFetchVerdict({ base: base, landed: landed, dir: dir });
        if (v.edge) {
          if (dir < 0) self._edgeUp = true;
          else self._edgeDown = true;
          self._forceRedraw();
          // 這個方向到底了 ⇒ 讓 _maybeFill 決定要不要換另一個方向繼續。
          // 落在最後一頁（static `num` 的常態）時，這一步就是整份清單補不補得回來
          // 的分水嶺 —— 少了它畫面會停在「幾列內容 ＋ 一整片空白」。
          self._maybeFill();
          return;
        }
        self._fillPages++;
        if (origin === 'key') {
          self._maybeDemand(dir);
          self._maybeFill();
        } else self._maybeFill();
      },
      // 背景抓頁失敗是良性的：當作到邊、停止往那個方向抓（使用者照樣捲得動
      // 已有的內容），永遠不切模式。
      onFail: function() {
        self._serverNum = null;
        if (dir < 0) self._edgeUp = true;
        else self._edgeDown = true;
      }
    });
  },

  // ---- 交易 ------------------------------------------------------------------

  _freezeForTransaction: function() {
    this._breakScroll();
    this._queue.flushPendingKind(BRD_CMD_PREFIX);
    this._renderMode = 'frozen';
    this._setLoading(true);
    this._armFrozenWatchdog();
    this._view.hideCursor();
    this._forceRedraw();
  },

  _armFrozenWatchdog: function() {
    const self = this;
    if (this._frozenWatchdog) clearTimeout(this._frozenWatchdog);
    this._frozenWatchdog = setTimeout(function() {
      self._frozenWatchdog = null;
      if (self._renderMode === 'frozen' || self.state === 'opening')
        self._degradeToNative('指令逾時，已切至原生模式');
    }, FROZEN_WATCHDOG_MS);
  },

  // 把 server 的真游標對到本地選取。`choose_board` 的 `num` 是 **static**
  // （board.c:1646）⇒ 離開／進板的落點都由它決定，游標不同步就會進錯看板。
  _enqueueCursorSyncJump: function(kind, onSynced, onFail) {
    const num = this._selectedNum;
    const self = this;
    this._queue.enqueue({
      keys: String(num) + '\r',
      kind: BRD_CMD_PREFIX + kind,
      expect: function(snap, facts) {
        return !!(facts.brd && facts.brd.parked && facts.brd.cursorNum === num);
      },
      fullRepaint: true,
      timeoutMs: CMD_PROBE_AFTER_MS,
      probeTimeoutMs: CMD_PROBE_WINDOW_MS,
      hardTimeoutMs: CMD_HARD_MS,
      onDone: function() {
        self._serverNum = num;
        onSynced();
      },
      onFail: function() {
        self._serverNum = null;
        onFail();
      }
    });
  },

  // Enter／→：進入選取的看板。落點有三種（board.c:1928-2018）：
  //   一般看板  → Read() → 文章列表（交給 ListSession／原生）
  //   目錄・群組看板 → 遞迴 choose_board ⇒ **另一份看板列表**（新的編號空間）
  //   分隔線・禁入板 → server **一個 byte 都不回**（switch 直接 break）
  // 第三種在本地擋掉：送出去只會凍畫面等到逾時。
  _beginOpen: function() {
    const num = this._selectedNum;
    const text = this._rowTextOf(num);
    if (num == null) return this._abortOpen('這一列不能進入');
    if (isBoardListSeparatorRow(text)) return this._abortOpen('這是分隔線，不能進入');
    if (isBoardListBlockedRow(text)) return this._abortOpen('這個看板目前無法進入');
    this._freezeForTransaction();
    const self = this;
    const send = function() {
      self._enqueueLandingKey('\r', 'open-board', '進入看板逾時，已切至原生模式');
    };
    if (num === this._serverNum) send();
    else this._enqueueCursorSyncJump('open-sync-jump', send, function() {
      self._degradeToNative('進入看板逾時，已切至原生模式');
    });
  },

  _abortOpen: function(msg) {
    // reducer 已經把狀態挪到 opening（鍵盤那條路），沒送出任何 byte ⇒ 立刻回到 active。
    this.state = 'active';
    if (this._view.flashListHint) this._view.flashListHint(msg);
  },

  // ←／q：回上層。同樣要先同步真游標 —— `num` 是 static，離開時的游標位置就是
  // 下次進來的落點（board.c:1646、2010「num = tmp1」的還原邏輯同源）。
  _beginLeave: function() {
    this._freezeForTransaction();
    const self = this;
    const send = function() {
      self._enqueueLandingKey(LEFT_ARROW, 'leave', '回上層逾時，已切至原生模式');
    };
    if (this._selectedNum == null || this._selectedNum === this._serverNum) send();
    else
      this._enqueueCursorSyncJump('leave-sync-jump', send, function() {
        self._degradeToNative('回上層逾時，已切至原生模式');
      });
  },

  // 開看板／回上層／跳號**共用的落地腿**：送出鍵 → 任何一幀 settle 就收攤
  //（`_reset()` 把 renderMode 交還、state 回 idle），接著同一個 settle 的 reducer
  // 會依畫面內容自己決定要 engage 誰：
  //   文章列表 → ListSession（它的 handler 就在同一輪跑）
  //   新的看板列表 → 我們自己從 idle 重新 seed（新的編號空間，本來就該重建）
  //   主功能表／其他 → 原生
  // 「一律收攤再由內容決定」比在 expect 裡窮舉落點穩健得多：`←` 的上層可能是
  // 主功能表、分類看板根，也可能是另一份同變體的看板列表。
  _enqueueLandingKey: function(keys, kind, failMsg) {
    const self = this;
    this._queue.enqueue({
      keys: keys,
      kind: BRD_CMD_PREFIX + kind,
      expect: function() {
        return true;
      },
      timeoutMs: NATIVE_PASSTHROUGH_MS,
      onDone: function() {
        self._reset();
      },
      onFail: function() {
        self._degradeToNative(failMsg);
      }
    });
  },

  // 數字跳號：數字在本地的浮層收集（零 server round-trip），送出時一次交易。
  _beginJumpCollect: function(firstDigit) {
    const self = this;
    if (!this._view.promptListInput) return;
    this._view.promptListInput('跳至第幾項：', firstDigit, function(val) {
      const num = val ? parseInt(val, 10) : NaN;
      if (!num || num <= 0) return; // 取消／不是數字：零 server
      const r = transitionBoardListSession(self.state, {
        type: 'key',
        keyClass: 'transact'
      });
      self.state = r.next;
      self._beginJumpNumber(num);
    });
  },

  _beginJumpNumber: function(num) {
    this._freezeForTransaction();
    const self = this;
    let landed = null;
    this._queue.enqueue({
      keys: String(num) + '\r',
      kind: BRD_CMD_PREFIX + 'jump-number',
      expect: function(snap, facts) {
        if (!facts.brd || !facts.brd.parked || facts.brd.cursorNum == null) return false;
        landed = facts;
        return true;
      },
      fullRepaint: true,
      timeoutMs: CMD_PROBE_AFTER_MS,
      probeTimeoutMs: CMD_PROBE_WINDOW_MS,
      hardTimeoutMs: CMD_HARD_MS,
      onDone: function() {
        // 落點可能離緩衝很遠（search_num 會夾到 brdnum）⇒ 整份重建，別 resume 舊錨。
        self.state = 'active';
        self._renderMode = 'buffer';
        self._setLoading(false);
        self._view.hideCursor();
        self._rebuild(landed);
      },
      onFail: function() {
        self._degradeToNative('跳號逾時，已切至原生模式');
      }
    });
  },

  // ---- 模式切換 --------------------------------------------------------------

  // 切到原生 LIVE 鏡像。`facts` 有值＝是 reducer 的 catch-all 送我們來的
  //（畫面偏離看板列表格式）⇒ 顯性提示；沒值＝內部呼叫（passthrough 等），不提示。
  //
  // **緩衝整份丟掉**：非白名單鍵（`y` 切全部看板／`c` 新文章／`/` 關鍵字／`a`
  // 增看板／`t` 標記／`D` 刪除／`m` 移入移出／`S` 排序）每一個都會改寫清單內容
  // 或整個編號空間（handoff I5）。回來時一律重建才安全。
  // opts.hold: 'passthrough'（預設，靜置後自動回平滑捲動）| 'external'（永不解除）。
  _enterNative: function(facts, opts) {
    this._breakScroll();
    this._holdReason = (opts && opts.hold) || 'passthrough';
    this._setLoading(false);
    this._resetBuffer();
    this._variant = null;
    this._serverNum = null;
    this._selectedNum = null;
    this._topNum = null;
    this._renderMode = 'native';
    this._view.showCursor();
    this._forceRedraw();
    // 停泊當下就排一次：使用者按完鍵之後可能再也不動（畫面靜止不會有 settle）。
    this._scheduleResumeProbe();
    if (facts && this._view.flashListHint)
      this._view.flashListHint(
        '畫面偏離看板列表格式，已切至原生模式' + nativeResumeHint(),
        4000
      );
  },

  _degradeToNative: function(msg) {
    if (this._view.flashListHint) this._view.flashListHint(msg, 4000);
    this.state = 'functionMode';
    this._enterNative();
  },

  // 交易落地後的收攤：把畫面所有權交還，狀態回 idle，讓**同一個 settle** 的
  // reducer 依內容重新決定要不要 engage。與 _cleanup 的差別只有「不 flush 別人的
  // 命令」——這時 in-flight 已經是我們自己剛完成的那一條。
  _reset: function() {
    this._breakScroll();
    this._holdReason = null;
    this._cancelResumeProbe();
    if (this._frozenWatchdog) {
      clearTimeout(this._frozenWatchdog);
      this._frozenWatchdog = null;
    }
    this._resetBuffer();
    this._setLoading(false);
    this.state = 'idle';
    this._variant = null;
    this._selectedNum = null;
    this._serverNum = null;
    this._topNum = null;
    this._renderMode = 'native';
    this._view.showCursor();
    this._forceRedraw();
  },

  _cleanup: function() {
    // **只清自己的命令**：這條佇列是與 ListSession／AidNavigation／LongPush 共用的，
    // 整條 flush 會把別人剛排進去的命令靜默殺掉（進板那一幀 ListSession 正好在
    // 排 prefetch）。
    this._queue.flushKind(BRD_CMD_PREFIX);
    this._reset();
  },

  // ---- 序列／視窗 -------------------------------------------------------------

  // body 的列數（原生 24 列畫面的 rows 3..22 ＝ p_lines ＝ 20）。
  _bodyRows: function() {
    return this._termBuf.rows - 4;
  },

  // 序列＝整份緩衝（看板列表沒有黑名單過濾、沒有置底文門控）⇒ 位置就是索引。
  _sequenceLength: function() {
    return (this._termBuf.brdListLineNums || []).length;
  },

  _posOfNum: function(num) {
    if (num == null) return -1;
    return (this._termBuf.brdListLineNums || []).indexOf(num);
  },

  _cursorPos: function() {
    const len = this._sequenceLength();
    if (!len) return -1;
    const p = this._posOfNum(this._selectedNum);
    return p !== -1 ? p : 0;
  },

  _anchorPos: function() {
    if (!this._sequenceLength()) return -1;
    return this._posOfNum(this._topNum);
  },

  _viewportTopPos: function() {
    const p = this._anchorPos();
    if (p !== -1) return p;
    return Math.max(0, this._cursorPos());
  },

  // 翻頁的基準：動畫還在飛時用**動畫終點**，否則連按 PgUp 的第二次只會從半路
  // 再翻一頁（使用者感受：翻不動）。
  _navTopPos: function() {
    const a = this._scrollAnim;
    const rowH = this._rowHeight();
    if (a && rowH > 0) {
      const p = Math.round(a.px / rowH);
      if (p >= 0 && p < this._sequenceLength()) return p;
    }
    return this._viewportTopPos();
  },

  _setAnchorPos: function(pos, frac) {
    const nums = this._termBuf.brdListLineNums || [];
    if (!nums.length) return;
    const p = Math.max(0, Math.min(pos, nums.length - 1));
    this._topNum = nums[p];
    this._scrollFrac = Math.max(0, frac || 0);
  },

  _setCursorPos: function(pos) {
    const nums = this._termBuf.brdListLineNums || [];
    if (!nums.length) return;
    const p = Math.max(0, Math.min(pos, nums.length - 1));
    this._selectedNum = nums[p];
  },

  // render 合約（term_view.buildBoardListWindowLines／onListMouseMove／
  // clientToPos）：body ＝**整段序列**，捲動交給瀏覽器。看板列表沒有黑名單過濾也
  // 沒有置底門控 ⇒ 序列就是 0..len-1 的恆等映射；形狀刻意與 ListSession.getListView
  // 一致（`seq`/`cursorAbs`/`cursorPos`），消費端才不必分兩種。
  // 陣列以長度記憶化：這條路每幀都走，300 列每幀重造一個陣列是白工。
  getListView: function() {
    const len = this._sequenceLength();
    if (!len) return null;
    if (!this._seqCache || this._seqCache.length !== len) {
      const seq = new Array(len);
      for (let i = 0; i < len; ++i) seq[i] = i;
      this._seqCache = seq;
    }
    const cursor = this._cursorPos();
    this._setCursorPos(cursor);
    return { seq: this._seqCache, cursorAbs: cursor, cursorPos: cursor };
  },

  // ---- 累積端（term_view.accumulateBoardListLines）的回呼 ---------------------

  // evict／prune 的樞紐＝**視口頂那一列**（使用者眼前的位置），退路才是選取：
  // 游標與捲動位置解耦後，使用者可以把畫面捲到離游標很遠的地方。
  evictPivot: function() {
    return this._topNum != null ? this._topNum : this._selectedNum;
  },

  prunePivot: function() {
    return this._prunePivotOverride !== undefined
      ? this._prunePivotOverride
      : this._selectedNum;
  },

  // 累積端把超過上限／不連續的那一端丟掉了 ⇒ 清掉對應的邊界旗標，demand 才能
  // 重新抓回被丟掉的區段。
  noteEvicted: function(direction) {
    if (direction < 0) this._edgeUp = false;
    else this._edgeDown = false;
  },

  // ---- 導覽 ------------------------------------------------------------------

  // 本地導覽（緩衝內零 server），到邊界才送命令。
  //
  // **游標到頂／到底一律夾住，不照抄 PTT 的 wrap**（使用者拍板；board.c 的
  // KEY_UP 在第一項會 wrap 到最後一項、PgUp 在第一項 fall-through 到 KEY_END、
  // PgDn 在最後一項回到第 1 項 —— 那在網頁式捲動下極不直覺）。
  // 兩類操作基準不同是刻意的：↑↓ 以游標為基準，PgUp/PgDn/Home/End 以視口頂為基準。
  _moveSelection: function(op, opts) {
    const len = this._sequenceLength();
    if (!len) return;
    const B = this._bodyRows();
    const cursor = this._cursorPos();
    const top = this._navTopPos();
    let next;
    switch (op) {
      case 'up':
        next = Math.max(0, cursor - 1);
        break;
      case 'down':
        next = Math.min(cursor + 1, len - 1);
        break;
      case 'pgup':
        next = Math.max(0, top - B);
        break;
      case 'pgdn':
        next = Math.min(top + B, len - 1);
        break;
      // Home/End 一律走 server（與 list_session 同一個決定，理由見該檔）。
      case 'home':
        return this._requestHome();
      case 'end':
        return this._requestEnd();
      default:
        return;
    }
    const wasVisible = this._isPosVisible(cursor);
    const now = Date.now();
    const repeat = !!(opts && opts.repeat) || now - this._lastNavAt < NAV_BURST_MS;
    this._lastNavAt = now;
    this._setCursorPos(next);
    this._pendingReveal = Object.assign(
      { pos: next },
      revealPlan(op, {
        wasVisible: wasVisible,
        reducedMotion: prefersReducedMotion(),
        repeat: repeat
      })
    );
    this._forceRedraw();
    this._maybeDemand(op === 'up' || op === 'pgup' || op === 'home' ? -1 : 1);
  },

  // 前景導覽鍵的共用前置：把背景抓頁讓開。還沒送出的直接丟（落點馬上不算數），
  // 在飛的那筆縮成一個 round-trip —— 不能 flush 它，還在線上的回應會變成無主
  // settle 去滿足下一筆的 expect（同 list_session 的不變量 7）。
  _expediteBackground: function() {
    const kind = this._queue.inFlightKind || '';
    if (kind.indexOf(BRD_CMD_PREFIX + 'fetch') === 0 && this._queue.expedite)
      this._queue.expedite(250);
  },

  // End = 原生 End 直通（`\x1b[4~`）。board.c:1768 CONFIRMED：`KEY_END`/`$` →
  // `num = brdnum - 1`（psb.c:62-64 的 psb_default_input_processor 同義）。
  // 舊做法是 `99999999\r`（search_num 夾到最後一項，stuff.c:189-208）；改直通
  // 原生鍵是使用者 2026-09-05 的決定，`fullRepaint` 保證有回應。
  //
  // 佇列忙碌時**不再靜默丟棄**（回報「Home/End 有時失效」）：舊碼
  // `if (!this._queue.idle) return;` 讓整個按鍵零 byte、零重繪、零提示消失。
  _requestEnd: function() {
    if (this._queue.hasKind(BRD_CMD_PREFIX + 'jump-')) return;
    const self = this;
    this._queue.flushPendingKind(BRD_CMD_PREFIX + 'fetch');
    this._expediteBackground();
    this._setLoading(true); // 吞鍵不得無聲
    this._queue.enqueue({
      keys: '\x1b[4~',
      kind: BRD_CMD_PREFIX + 'jump-end',
      onSend: function() {
        // 落點是最後一頁：與現有緩衝之間可能整段不連續，樞紐固定成「編號最大的
        // 那一段」（null ＝ pruneListToSegment 的預設樞紐），否則剛抓到的板尾會被
        // 當成孤島丟掉。**必須等到送出才設**：排在背景抓頁後面時提早設，會讓那筆
        // 抓頁的 prune 用到錯的樞紐。
        self._prunePivotOverride = null;
      },
      expect: function(snap, facts) {
        return !!(facts.brd && facts.brd.parked && facts.brd.cursorNum != null);
      },
      fullRepaint: true,
      timeoutMs: CMD_PROBE_AFTER_MS,
      probeTimeoutMs: CMD_PROBE_WINDOW_MS,
      hardTimeoutMs: CMD_HARD_MS,
      onDone: function() {
        self._prunePivotOverride = undefined;
        self._setLoading(false); // 這筆交易自己點亮的膠囊，自己負責關掉
        self._edgeDown = true;
        const len = self._sequenceLength();
        if (!len) return;
        self._setCursorPos(len - 1);
        self._anchorOverride = true;
        self._pendingReveal = {
          pos: len - 1,
          block: 'end',
          behavior: prefersReducedMotion() ? 'auto' : 'smooth'
        };
        self._forceRedraw();
      },
      onFail: function() {
        self._prunePivotOverride = undefined;
        self._setLoading(false);
      }
    });
  },

  // Home = 原生 Home 直通（`\x1b[1~`）。board.c:1830 CONFIRMED：`KEY_HOME`/`'0'`
  // → `num = 0` ⇒ 落在第 1 項（編號＝絕對位置，恆存在）。其餘同 _requestEnd。
  _requestHome: function() {
    if (this._queue.hasKind(BRD_CMD_PREFIX + 'jump-')) return;
    const self = this;
    this._queue.flushPendingKind(BRD_CMD_PREFIX + 'fetch');
    this._expediteBackground();
    this._setLoading(true);
    this._queue.enqueue({
      keys: '\x1b[1~',
      kind: BRD_CMD_PREFIX + 'jump-home',
      onSend: function() {
        self._prunePivotOverride = 1; // 保留第 1 項（落點）所在的那一段
      },
      expect: function(snap, facts) {
        return !!(facts.brd && facts.brd.parked && facts.brd.cursorNum === 1);
      },
      fullRepaint: true,
      timeoutMs: CMD_PROBE_AFTER_MS,
      probeTimeoutMs: CMD_PROBE_WINDOW_MS,
      hardTimeoutMs: CMD_HARD_MS,
      onDone: function() {
        self._prunePivotOverride = undefined;
        self._setLoading(false);
        self._serverNum = 1;
        self._edgeUp = true;
        if (!self._sequenceLength()) return;
        self._setCursorPos(0);
        self._anchorOverride = true;
        self._pendingReveal = {
          pos: 0,
          block: 'start',
          behavior: prefersReducedMotion() ? 'auto' : 'smooth'
        };
        self._forceRedraw();
      },
      onFail: function() {
        self._prunePivotOverride = undefined;
        self._setLoading(false);
      }
    });
  },

  // ---- 原生捲動的錨定（render 前擷取 / render 後還原）-------------------------
  // 與 list_session 同一套（js/list_scroll.js 的純函式），差別只有「序列位置＝
  // 緩衝索引、錨＝看板編號」。

  captureScrollAnchor: function() {
    if (this._anchorOverride) {
      this._anchorOverride = false;
      return;
    }
    const screen = this._screen();
    if (!screen || !screen.getListScrollTop) return;
    // 視口不在 DOM 上時 scrollTop 恆為 0 —— 那是「沒有資訊」不是「捲到最上面」。
    if (screen.hasListViewport && !screen.hasListViewport()) return;
    const rowH = this._rowHeight();
    if (!(rowH > 0)) return;
    if (!this._sequenceLength()) return;
    const t = topPosFromScrollTop({ scrollTop: screen.getListScrollTop(), rowH: rowH });
    this._setAnchorPos(t.pos, t.frac);
  },

  applyScrollAfterRender: function() {
    const screen = this._screen();
    if (!screen || !screen.setListScrollTop) return;
    const rowH = this._rowHeight();
    if (!(rowH > 0)) return;
    const len = this._sequenceLength();
    if (!len) return;
    const B = this._bodyRows();
    const viewportPx = screen.getListViewportPx() || B * rowH;
    const maxScrollTop = maxScrollTopFor({
      len: len,
      bodyRows: B,
      rowH: rowH,
      viewportPx: viewportPx
    });
    let pos = this._anchorPos();
    if (pos === -1) {
      pos = Math.max(0, this._cursorPos());
      this._setAnchorPos(pos, 0);
    }
    const top = anchorScrollTop({
      pos: pos,
      frac: this._scrollFrac,
      rowH: rowH,
      maxScrollTop: maxScrollTop
    });
    // **序列沒位移時一格都不准寫**：同步寫 scrollTop 會取消瀏覽器進行中的平滑
    // 捲動（_breakScroll 正是靠這個副作用停住畫面的）。
    const cur = screen.getListScrollTop ? screen.getListScrollTop() : top;
    const compensated = Math.abs(top - cur) >= 0.5;
    if (compensated) {
      screen.setListScrollTop(top);
      this._lastScrollTop = top;
    }

    const rv = this._pendingReveal;
    if (rv) {
      this._pendingReveal = null;
      const target = revealScrollTop({
        pos: rv.pos,
        scrollTop: top,
        rowH: rowH,
        viewportPx: viewportPx,
        maxScrollTop: maxScrollTop,
        block: rv.block
      });
      if (target !== top && rv.behavior === 'smooth') {
        screen.scrollListTo(target, 'smooth');
        this._armScrollAnim(rv.pos, rv.block, target);
      } else {
        // instant：**一定要**寫一次，把上一發還在飛的平滑動畫殺掉。
        const hadAnim = !!this._scrollAnim;
        this._scrollAnim = null;
        if (target !== top || hadAnim) screen.scrollListTo(target, rv.behavior);
        this._lastScrollTop = target;
        const at = topPosFromScrollTop({ scrollTop: target, rowH: rowH });
        this._setAnchorPos(at.pos, at.frac);
      }
      return;
    }

    if (this._scrollAnim) {
      const tpos = this._posOfNum(this._scrollAnim.num);
      if (tpos === -1) {
        this._scrollAnim = null;
        return;
      }
      const target = revealScrollTop({
        pos: tpos,
        scrollTop: top,
        rowH: rowH,
        viewportPx: viewportPx,
        maxScrollTop: maxScrollTop,
        block: this._scrollAnim.block
      });
      if (compensated || Math.abs(target - this._scrollAnim.px) >= 1) {
        screen.scrollListTo(target, 'smooth');
        this._scrollAnim.px = target;
        this._scrollAnim.at = Date.now();
      }
      return;
    }

    const t = topPosFromScrollTop({ scrollTop: top, rowH: rowH });
    this._setAnchorPos(t.pos, t.frac);
  },

  _armScrollAnim: function(pos, block, px) {
    const nums = this._termBuf.brdListLineNums || [];
    this._scrollAnim = {
      num: nums[Math.max(0, Math.min(pos, nums.length - 1))],
      block: block,
      px: px,
      at: Date.now()
    };
  },

  _scrollAnimSettled: function(px) {
    const a = this._scrollAnim;
    if (!a) return true;
    if (Math.abs(px - a.px) < 1 || Date.now() - a.at > SCROLL_ANIM_MAX_MS) {
      this._scrollAnim = null;
      return true;
    }
    return false;
  },

  // 停住捲動：作廢排隊中的 reveal 與 rAF，並取消瀏覽器還在跑的平滑動畫
  //（`overflow:hidden` 只擋使用者輸入，不會取消已排定的 scrollTo）。
  _breakScroll: function() {
    this._pendingReveal = null;
    this._anchorOverride = false;
    this._lastScrollTop = 0;
    this._scrollAnim = null;
    this._lastNavAt = 0;
    const screen = this._screen();
    if (screen && screen.getListScrollTop && screen.setListScrollTop)
      screen.setListScrollTop(screen.getListScrollTop());
    if (this._scrollRaf != null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._scrollRaf);
      else clearTimeout(this._scrollRaf);
      this._scrollRaf = null;
    }
  },

  _isPosVisible: function(pos) {
    const screen = this._screen();
    const rowH = this._rowHeight();
    if (!screen || !screen.getListScrollTop || !(rowH > 0)) return true;
    return isRowVisible({
      pos: pos,
      scrollTop: screen.getListScrollTop(),
      rowH: rowH,
      viewportPx:
        (screen.getListViewportPx && screen.getListViewportPx()) ||
        this._bodyRows() * rowH
    });
  },

  _maxScrollTop: function() {
    const screen = this._screen();
    const rowH = this._rowHeight();
    if (!screen || !(rowH > 0)) return 0;
    const B = this._bodyRows();
    return maxScrollTopFor({
      len: this._sequenceLength(),
      bodyRows: B,
      rowH: rowH,
      viewportPx: (screen.getListViewportPx && screen.getListViewportPx()) || B * rowH
    });
  },

  _rowHeight: function() {
    return (this._view && this._view.chh) || 0;
  },

  _screen: function() {
    return (this._view && this._view.componentScreen) || null;
  },

  _rowTextOf: function(num) {
    const idx = this._posOfNum(num);
    if (idx === -1) return '';
    const row = (this._termBuf.brdListLines || [])[idx];
    return row ? rowToText(row) : '';
  },

  // 讀取中指示（v5 合約 #4：交易凍住畫面時要說話）。view-optional（unit stub）。
  _setLoading: function(on) {
    if (this._view.setListLoading) this._view.setListLoading(on);
  },

  _forceRedraw: function() {
    this._termBuf.lineChangeds.fill(true);
    this._termBuf.changed = true;
    this._termBuf.notify();
  }
};
