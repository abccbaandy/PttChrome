// 長推文一鍵發送的狀態機（探路 ＋ 送出）。
//
// 使用者在右鍵選單開的輸入框打一大段話 → long_push.js 依 Big5 byte 上限切成 N 則
// → 這裡把每一則都跑完一次完整的 PTT 推文互動（X → 型別 → 內容 → 確定[y/N]），
// 撞到冷卻就等，等完繼續。整段期間 term_view / pttchrome 的輸入入口靠 `active`
// 擋掉使用者按鍵（比照 aid_navigation.active），畫面上蓋一層進度遮罩。
//
// ---- 三階段 ----
//   preflight  使用者一按 X 就先送一個 X 問 PTT「這篇推得了嗎」，讀完答案再退出
//              推文流程、按 ⏎ 回原文章。推不了就把 PTT 的**原話**交給錯誤框，
//              使用者一個字都不必打（startPreflight / _afterProbeX）。
//   armed      探完路、輸入框開著、使用者在打字。**線路真的空著 ⇒ active=false**，
//              但 busy=true（畫面還是我們的，見 easy_reading._wireBusy）。
//   sending    逐則送出。沿用 armed 採好的錨點／閱讀位置／AID，絕不重採。
//
// ---- 為什麼每一步都得先讀畫面才能決定送什麼 ----
// bbs.c#recommend 的型別選單（1a）與「作者本人／時間太近」（1b/1c）是互斥分支，
// 而 1b/1c 沒有型別選單。**第 2 則起 90 秒內一定走 1c**（bbs.c:2968，寫死 90 秒的
// lastrecommend 比較），這時若照第 1 則的劇本送一個 "1"，那個 1 會直接變成推文
// 內容。所以每一步都是「送鍵 → 等 settle → classifyPushScreen → 才決定下一步」，
// 完成判定一律看內容不看時間（CommandQueue 的核心契約）。
//
// ---- 三個刻意的保守選擇 ----
// 1. **推文流程裡不用 fullRepaint／probe（兩者都會送 Ctrl-L）**：型別選單那一格是 vkey() 取
//    單一 byte（bbs.c:2996），非數字一律當 RECTYPE_DEFAULT＝推。萬一 Ctrl-L 沒有被
//    io.c#system_key_hook 完全吃掉，就是在使用者沒選的情況下推出去。這個功能會把
//    內容寫進公開看板，「送錯」比「失敗」嚴重得多 ⇒ 逾時直接失敗，停在原生畫面。
// 2. **未知畫面一律停手**（classifyPushScreen 回 'other'/'fatal'）：繼續盲送鍵在
//    PTT 上等於亂按快捷鍵。
// 2.5 **每次在列表按 X 之前，先確認游標指的還是原篇**。第 2 則起的 X 是在列表按
//    的（bbs.c:2471-2473：read_post 對 RET_DORECOMMEND 一律
//    `recommend(...); return FULLUPDATE;` ⇒ 推完必定離開 pager），而列表游標
//    crs_ln 只是 .DIR 行號、不綁文章身分 ⇒ 板上一有增刪就同編號≠同一篇，第 2 則
//    會推到別篇（使用者實測，熱門版）。判準與重新定位見 long_push_anchor.js。
// 3. **每則的內容長度用當下畫面校正**（見 _enqueueContent）：估短了只是多切一則，
//    估長了會踩到 vgetstring 的 DBCS 保護 → vkey_purge() 連 Enter 一起清掉 → 卡死。
//
// 位移模型：`_text` 是使用者打的原文（已過 stripNonBig5），`_offset` 是「已經送出
// 到哪個字」。每次要送就拿 `_text.slice(_offset)` 現切一段（splitPushSpans），所以
// 長度上限中途變準時，剩下的內容會**重新**依新上限分段；中止時交給剪貼簿的也是
// 原文的一段 slice，不是切開又接回去的版本。
//
// 詳見 docs/long-push.md。

import { u2b, ansiHalfColorConv } from './string_util';
import { PUSH_TYPE_KEY, pushMaxBytes, splitPushSpans } from './long_push';
import { classifyPushScreen, detectIpLogged } from './push_screen';
import {
  articleAnchor,
  captureCursorAnchor,
  checkCursorAnchor,
  findAnchorRowNum
} from './long_push_anchor';
import { aidSearchLanded } from './aid_navigation';
// 收尾鍵（Ctrl-C 取消輸入列／確認列，空白鍵收掉 vmsg 橫幅）與完整的 pttbbs 出處
// 註解都在 screen_dismiss.js，與「滑鼠點空白處關框」**共用同一份**。
// 不要在這裡再定義第二份。
import { KEY_ABORT, KEY_DISMISS } from './screen_dismiss';

// 每一步的等待預算。推文的回應是 server 立刻重畫底列，正常在一個 round-trip 內。
const STEP_TIMEOUT_MS = 5000;
const STEP_HARD_TIMEOUT_MS = 12000;
// 冷卻倒數多等一秒：server 的秒數是整數截斷的（(int)time4_diff），剛好踩點會再被擋一次。
const COOLDOWN_SLACK_MS = 1000;
// 取消時最多送幾次收尾鍵。收不回來就放手，畫面留給使用者自己處理。
// 4 步是最壞情況的預算：小天使板（BRD_ANGELANONYMOUS）上 Ctrl-C 會被 vans 當成
// 「非 n」＝匿名 YES ⇒ 匿名詢問 → 輸入列 → 取消，比一般情況多一步。
const MAX_ABORT_STEPS = 4;
// 每一則最多重新定位一次。定位完還對不上就是我們迷路了 —— 這種時候再送 X 等於
// 亂推，寧可停手把剩下的內容還給使用者。
const MAX_RELOCATIONS = 1;

// 本程式自己判斷出來的失敗原因（source: 'client'）。**PTT 回報的訊息一律原文透傳**
// （classifyPushScreen 的 message，已經剝掉 ◆ 與 [按任意鍵繼續]），絕不在這裡改寫或
// 對照翻譯 —— 那會在 PTT 改字串的那天靜默壞掉，而這正是本功能的重點之一。
// 集中在這裡是為了日後要 i18n 時只有一個地方要動（session 是純 JS，刻意不 import
// i18n：那會把整包語系表拉進 unit test 的冷載入成本裡）。
const MSG = {
  cancelled: '長推文已取消',
  screenChanged: '畫面已變更',
  articleMoved: '文章位置已變動',
  cursorUnreadable: '讀不出游標所在的文章',
  aidUnreadable: '讀不到文章代碼',
  unknownScreen: '看不出現在的畫面',
  noResponse: 'PTT 沒有回應'
};

export function LongPushSession(core, view, termBuf, queue) {
  this._core = core;
  this._view = view;
  this._termBuf = termBuf;
  this._queue = queue;
  // 送出序列進行中：term_view.onKeyDown / App.onFunctionKey / 各 mouse 入口都
  // 檢查它並吞掉使用者輸入（同 aidNavigation.active）。
  //
  // **語意是「線路上正在跑序列化操作」，不是「這個功能正在用」**：armed
  // （探完路、使用者在輸入框打字）期間線路真的空著，active 必須是 false，
  // 否則 serializedOpHint 會把他打的字吞掉。要問「這個功能是不是還握著畫面」
  // 用 busy（見下面的 getter）。
  this.active = false;
  // 三階段：'idle' → 'preflight'（送一個 X 問 PTT 能不能推）→ 'armed'（使用者
  // 在輸入框打字）→ 'sending'（逐則送出）。preflight 失敗或送完就回 'idle'。
  this._phase = 'idle';
  // preflight 的成果，**跨越使用者打字那段時間**的唯一狀態（_reset 不清它）。
  this._armed = null;
  // 進度回呼（ContextMenu 掛上來畫遮罩）。null = 沒人看。
  this.onChange = null;
  // 探路結果 → ContextMenu 決定開輸入框還是錯誤框。
  this.onPreflight = null;
  // 送出階段的終局（失敗／取消）→ 錯誤框。成功仍走 _hint 的 toast。
  this.onResult = null;
  this._timer = null;
  this._reset();
}

LongPushSession.prototype = {
  _reset: function() {
    this._text = '';
    this._offset = 0;
    this._sent = 0;
    this._total = 0;
    this._span = null;
    this._typeKey = PUSH_TYPE_KEY.push;
    this._userId = '';
    this._ipLogged = null;
    this._maxBytes = pushMaxBytes({});
    this._cancelling = false;
    this._abortSteps = 0;
    this._startedInArticle = false;
    // 這一趟長推文綁定的文章身分：{ aid, board, author, subject, num }。
    // aid 由 aidNavigation.resolvePostAid 提供（重新定位用的權威鍵）；
    // author/subject 是列表上比對得到的欄位（bbs.c#readdoent 只印這些）。
    this._anchor = null;
    this._relocations = 0;
    // 按 Q 會把使用者踢出文章（view_postinfo 也 return FULLUPDATE），收工回文章
    // 時要把閱讀位置還回去。
    this._readLineIndex = null;
    // 最後一次 settle 的 facts。收尾鍵（_enqueueAbort）走的是自己的 enqueue，
    // 沒經過 _step，但收完之後要用**新鮮的** facts 過 _gate ⇒ 兩邊都記一次。
    this._lastFacts = null;
    // preflight 從畫面上讀到、要帶去給輸入框的事實。
    this._preflightScreen = null;
    this._clearTimer();
  },

  // 「這個功能還握著畫面嗎」——包含 armed（使用者在打字，線路空著但畫面是我們
  // 的）與冷卻倒數（queue 空著最長可以到 240 秒）。easy_reading 的自動翻頁要看它，
  // 不能只看 active／inFlightKind，否則會在這兩個空窗插進線路。
  get busy() {
    return this.active || !!this._armed;
  },

  // 序列化操作的提示字串（serialized_op_gate 用）。armed 期間 active 是 false，
  // 自然不會走到這裡。
  get opHint() {
    return this._phase === 'preflight'
      ? '正在確認能不能推文，請稍候…'
      : '長推文送出中，請稍候…';
  },

  // 丟掉探路成果。錨點綁在**這條連線**的列表游標上，斷線就失效（同
  // aidNavigation.reset 的理由）。
  disarm: function() {
    this._armed = null;
    if (this._phase === 'armed') this._phase = 'idle';
  },

  _clearTimer: function() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  },

  // 尚未送出的內容（原文 slice）。中止／取消時交給剪貼簿，使用者才不會白打。
  _rest: function() {
    return this._text.slice(this._offset).replace(/^\s+/, '');
  },

  _pendingSpans: function() {
    return splitPushSpans(this._text.slice(this._offset), this._maxBytes);
  },

  _recount: function() {
    this._total = this._sent + this._pendingSpans().length;
  },

  // 進度快照 → 遮罩。null ＝ 收工（遮罩關掉）。
  _emit: function(patch) {
    if (!this.onChange) return;
    if (patch === null) {
      this.onChange(null);
      return;
    }
    this.onChange({
      index: Math.min(this._sent + 1, this._total),
      total: this._total,
      phase: 'sending',
      waitSec: 0,
      message: '',
      ...patch
    });
  },

  _hint: function(msg) {
    if (this._view && this._view.flashListHint)
      this._view.flashListHint(msg, 6000);
  },

  // 收工。outcome.kind ∈ 'done' | 'fail' | 'cancel'。
  //
  // **剩餘內容不再自動寫進剪貼簿**（2026-09 使用者定案）：那會無聲蓋掉使用者手上
  // 的剪貼簿內容，而且他根本不知道發生了什麼事。改成交給 LongPushErrorModal 顯示
  // 在唯讀 Textarea 裡，要不要複製由他按。
  _finish: function(outcome) {
    const o = outcome || {};
    // _rest() 讀的是 _text/_offset，**一定要在 _reset() 之前**。
    const rest = o.keepRest ? this._rest() : '';
    const sent = this._sent;
    this.active = false;
    this._clearTimer();
    this._emit(null);
    this.disarm();
    this._phase = 'idle';
    this._reset();
    if (o.kind === 'done') {
      if (o.message) this._hint(o.message);
      return;
    }
    if (this.onResult)
      this.onResult({
        blocked: true,
        phase: o.kind === 'cancel' ? 'cancelled' : 'sending',
        source: o.source || 'client',
        message: o.message || '',
        reason: o.reason || null,
        sent: sent,
        rest: rest
      });
  },

  // 失敗：停在原生畫面，剩下的內容交給錯誤框（使用者可以自己讀回、複製）。
  // source='ptt' ＝ message 是 PTT 原文（classifyPushScreen 的 message），'client'
  // ＝ 本程式的判斷（逾時、畫面變更…）。兩者在錯誤框上會明確標示，因為使用者
  // 對這兩種訊息該做的事完全不同。
  _fail: function(msg, source) {
    if (!this.active) return;
    if (this._phase === 'preflight')
      return this._preflightFail({ source: source || 'client', message: msg });
    this._finish({
      kind: 'fail',
      source: source || 'client',
      message: msg,
      keepRest: true
    });
  },

  // -------------------------------------------------------------------------
  // 探路（preflight）的兩個終點
  // -------------------------------------------------------------------------

  // 能推。把 preflight 讀到的事實封進 _armed 交給輸入框，線路還給使用者。
  _preflightDone: function(facts) {
    this._armed = {
      anchor: this._anchor,
      readLineIndex: this._readLineIndex,
      startedInArticle: this._startedInArticle,
      // reopen 沒回到文章時，start() 要先送 \f 重新確認畫面（_enqueueOrient）。
      landedInArticle: !!(facts && facts.kind === 'article'),
      screen: this._preflightScreen || {},
      maxBytes: this._maxBytes
    };
    this._phase = 'armed';
    this.active = false;
    this._clearTimer();
    // 遮罩收掉與輸入框打開必須落在 React 的**同一次 update**，否則 modalShown 會
    // true→false→true，終端機會把焦點搶回隱藏 input #t（見 ContextMenu 的掛接）。
    this._emit(null);
    if (this.onPreflight)
      this.onPreflight(
        Object.assign({ blocked: false, maxBytes: this._maxBytes }, this._armed.screen)
      );
  },

  // 不能推（或探路本身失敗）。
  _preflightFail: function(payload) {
    const p = payload || {};
    this.active = false;
    this._clearTimer();
    this._emit(null);
    this.disarm();
    this._phase = 'idle';
    this._reset();
    if (this.onPreflight)
      this.onPreflight({
        blocked: true,
        phase: 'preflight',
        source: p.source || 'client',
        message: p.message || '',
        reason: p.reason || null,
        sent: 0,
        rest: ''
      });
  },

  // -------------------------------------------------------------------------
  // 入口
  // -------------------------------------------------------------------------

  // 探路：在**使用者還沒打字之前**送一個 X 問 PTT「這篇我推得了嗎」。
  //
  // 為什麼問得到：bbs.c#recommend 的每一種擋人判斷（BRD_NORECOMMEND／
  // CheckPostPerm2／guest／已刪除文／看板發文限制／快速連推／check_cooldown）都在
  // getdata 讀內容**之前**做完，一律 vmsg 印 ◆ 橫幅後 return FULLUPDATE。
  // 為什麼可以白按一次：lastrecommend 只在**成功寫檔後**才更新（bbs.c:3144），
  // check_cooldown 是唯讀的（bbs.c:4344）⇒ 探路不會害真正送出時被降級或擋下。
  // 唯一的足跡是 recommend_in_minute++（bbs.c:2909，上限 60/分鐘）。
  // 詳見 docs/long-push.md「探路（preflight）」。
  //
  // 回 true ＝ 我接手了這次按鍵（呼叫端才可以 preventDefault）。
  startPreflight: function(opts) {
    const o = opts || {};
    if (this.busy) return false;
    // 只在文章裡探。列表上按 X 推的是游標所指的文章，而錨點要從文章標頭取
    // （long_push_gate 的攔截判準也是同一條線）。
    if (!this._termBuf || this._termBuf.pageState !== 3) return false;
    this._reset();
    this._phase = 'preflight';
    this._maxBytes = o.maxBytes || pushMaxBytes({});
    this._startedInArticle = true;
    this.active = true;
    this._prologue();
    this._emit({ phase: 'preflight' });
    this._enqueueResolveAid();
    return true;
  },

  // text 必須是已過 stripNonBig5 的內容；type ∈ 'push' | 'boo' | 'arrow'。
  // maxBytes 是呼叫端算的**預估**上限（拿不到帳號時 pushMaxBytes 會給保守值），
  // 第一則進到輸入列後就會被畫面校正。回 true 表示序列已開始。
  //
  // 正常路徑上 _armed 已經由 startPreflight 準備好（錨點／閱讀位置／AID／上限
  // 都是**還在文章裡**那一刻採的），這裡一律沿用、**絕不重採**：此刻畫面早就
  // 進過 functionMode（scrollTop 已歸零），重採等於把污染當成基準。沒有 _armed
  // 的降級路徑（斷線 disarm、或呼叫端沒探路）才自己跑一次序幕。
  start: function(opts) {
    const o = opts || {};
    if (this.active) return false;
    const armed = this._armed;
    const text = String(o.text || '');
    this._reset(); // 刻意不動 _armed
    this._text = text;
    this._maxBytes = (armed && armed.maxBytes) || o.maxBytes || pushMaxBytes({});
    this._recount();
    if (!this._total) return false;

    this._typeKey = PUSH_TYPE_KEY[o.type] || PUSH_TYPE_KEY.push;
    this._phase = 'sending';
    this.active = true;

    if (armed) {
      this._anchor = armed.anchor;
      this._readLineIndex = armed.readLineIndex;
      this._startedInArticle = armed.startedInArticle;
      this._userId = (armed.screen && armed.screen.userId) || '';
      this._ipLogged =
        armed.screen && armed.screen.ipLogged != null
          ? armed.screen.ipLogged
          : null;
      const landed = armed.landedInArticle;
      this.disarm();
      this._prologue();
      // 探完路人已經回到文章 ⇒ X 推的就是這篇，沒有歧義。回不去（reopen 失敗）
      // 就先看清楚現在在哪，再過守門。
      if (landed) this._enqueueOpen();
      else this._enqueueOrient();
      return true;
    }

    this._startedInArticle = this._termBuf.pageState === 3;
    // ORDER INVARIANT：閱讀位置與文章標頭都必須在 _enterFunctionMode() **之前**
    // 讀（理由見 _prologue）。
    this._readLineIndex = this._currentLineIndex();
    this._anchor = articleAnchor(this._articleHeadRows());
    this._prologue();
    this._enqueueResolveAid();
    return true;
  },

  // 序幕：採樣 → 切到原生鏡像。**採樣一定要在 _enterFunctionMode() 之前**——
  // 那個函式結尾的 termBuf.notify() 是同步的，term_view.redraw 的 functionMode
  // 分支第一件事就是 mainDisplay.scrollTop = 0（同一條不變量在
  // deep_link_controller.copyCurrentPostLink 與 aid_navigation.start 都有註解）。
  // 錨點基準也一定要在**還在文章裡**的時候取：落回列表那一幀已經是 i_read 重讀
  // headers 之後的畫面，游標列可能早就換人（long_push_anchor.js 檔頭有推導）。
  _prologue: function() {
    if (this._phase === 'preflight') {
      this._readLineIndex = this._currentLineIndex();
      this._anchor = articleAnchor(this._articleHeadRows());
    }
    // 把**真的**原生畫面放到台面上再開始驅動它：文章好讀的 functionMode 是既有的
    // 即時鏡像機制（先例 deep_link_controller / aid_navigation），列表好讀則停到
    // 它自己的 functionMode，讓共用 queue 淨空、reducer 不來搶我們的 settle。
    const er = this._core.easyReading;
    if (er && er._enterFunctionMode) er._enterFunctionMode();
    if (this._core.listSession && this._core.listSession.beginExternalNavigation)
      this._core.listSession.beginExternalNavigation();
    if (this._core.boardListSession && this._core.boardListSession.beginExternalNavigation)
      this._core.boardListSession.beginExternalNavigation();
  },

  // 與 deep_link_controller._currentLineIndex / aid_navigation._currentLineIndex
  // 同一套算法（見上面的 ORDER INVARIANT）。
  _currentLineIndex: function() {
    const view = this._view;
    const disp = view && view.mainDisplay;
    const chh = view && view.chh;
    if (!disp || !chh) return null;
    return Math.round(disp.scrollTop / chh);
  },

  // 文章畫面最前面幾列（好讀模式下是累積頁的前幾列，原生模式就是眼前這幾列）。
  // 作者／標題兩行一定落在這個範圍內。
  _articleHeadRows: function() {
    const buf = this._termBuf;
    if (!buf || !buf.getRowText) return null;
    const acc = buf.pageLines;
    const useAcc = !!(acc && acc.length);
    const n = Math.min(6, useAcc ? acc.length : buf.rows);
    const out = [];
    for (let r = 0; r < n; ++r)
      out.push(
        useAcc
          ? buf.getRowText(r, 0, buf.cols, acc)
          : buf.getRowText(r, 0, buf.cols)
      );
    return out;
  },

  // 取得本篇 AID —— 重新定位的權威鍵（read.c#select_by_aid）。免費路徑（讀畫面
  // 上的「※ 文章網址」）拿不到時 resolvePostAid 會按 Q，那個 Q 的 FULLUPDATE
  // 會把人丟到列表、留一個資訊框（meta.boxOpen）。
  //
  // onDone(info=null) 是**明確答案**「本篇沒有 AID」（bbs.c:3707 印的是空框行），
  // 不是失敗：照樣繼續，只是之後只能靠作者＋主題比對。真正的 onFail 代表畫面狀態
  // 未知 —— 這時連「我們現在在文章還是列表」都不確定，送 X 等於亂推，停手。
  // 序幕跑完（AID 拿到了）之後要做的事：探路階段是送 X 問一句就走，送出階段是
  // 真的開始推第一則。
  _afterPrologue: function() {
    if (this._phase === 'preflight') return this._enqueueProbeX();
    this._enqueueOpen();
  },

  _enqueueResolveAid: function() {
    const nav = this._core.aidNavigation;
    if (!nav || !nav.resolvePostAid || !this._startedInArticle)
      return this._afterPrologue();
    const self = this;
    nav.resolvePostAid({
      kind: 'longpush-aid',
      onFlushed: function() {
        self._onFlushed();
      },
      onDone: function(info, meta) {
        if (info && info.aid) {
          self._anchor = self._anchor || {};
          self._anchor.aid = info.aid;
          self._anchor.board = info.board;
        }
        if (meta && meta.boxOpen) return self._enqueueDismissPostInfo();
        self._afterPrologue();
      },
      onFail: function(reason) {
        self._fail(MSG.aidUnreadable + '（' + reason + '）');
      }
    });
  },

  // 關掉 Q 的資訊框。只能用 KEY_DISMISS（ 會被 pressanykey 吃掉，
  // aid_navigation.js:501-510 的同一個坑），關完人就在列表上 ⇒ 走守門。
  _enqueueDismissPostInfo: function() {
    const self = this;
    this._step({
      kind: 'longpush-aid-dismiss',
      keys: KEY_DISMISS,
      failMsg: '文章代碼視窗沒有關掉',
      accept: function(c, facts) {
        return (
          facts.kind === 'clean-list' ||
          facts.kind === 'article' ||
          c.kind !== 'other'
        );
      },
      done: function(c, result) {
        if (c.kind === 'fatal') return self._fail(c.message, 'ptt');
        self._gate(result.facts, function() {
          self._afterPrologue();
        });
      }
    });
  },

  // 取消：只停掉「還沒送出的」，已經送出去的推文收不回來（PTT 沒有這種 API）。
  cancel: function() {
    if (!this.active || this._cancelling) return;
    this._cancelling = true;
    this._clearTimer();
    this._emit({ phase: 'cancelling' });
    // flush 會連 in-flight 一起丟（並觸發它的 onFlushed，_onFlushed 因為
    // _cancelling 已立起而讓路），之後 queue 是空的，收尾鍵才排得進去。
    this._queue.flush();
    const self = this;
    if (this._phase === 'preflight') {
      this._abortSteps = 0;
      return this._enqueueAbort(function() {
        self._preflightFail({ source: 'client', message: MSG.cancelled });
      });
    }
    this._enqueueAbort();
  },

  // queue 被別人 flush 掉（斷線／切原生鏡像／list_session 清理）。持有輸入阻擋
  // 旗標的人一定要實作這個 hook，否則 active 永遠卡在 true，整頁再也收不到鍵盤
  // （command_queue.js:114-119 的硬性要求）。
  _onFlushed: function() {
    if (this._cancelling) return; // 取消路徑自己會收尾
    this._fail(MSG.screenChanged);
  },

  // -------------------------------------------------------------------------
  // 每一則的四個步驟
  // -------------------------------------------------------------------------

  _step: function(cmd) {
    const self = this;
    this._queue.enqueue({
      kind: cmd.kind,
      keys: cmd.keys,
      // Ctrl-L 預設不送（見檔頭「三個刻意的保守選擇」第 1 點）。唯一的例外是
      // **列表上的重新定位**（#aid / 編號跳）：那時人不在推文流程裡，沒有型別
      // 選單可以被誤觸，而落地又需要一個保證的完整幀才判得準（同
      // aid_navigation._enqueueAidSearch）。probe 則一律關掉——逾時就是失敗，
      // 絕不盲送探針。
      fullRepaint: !!cmd.fullRepaint,
      probe: false,
      timeoutMs: STEP_TIMEOUT_MS,
      hardTimeoutMs: STEP_HARD_TIMEOUT_MS,
      expect: function(snapshot, facts) {
        const c = classifyPushScreen(facts.rowTexts, facts.rows);
        if (!cmd.accept(c, facts)) return false;
        // facts 是 list_session._collectFacts 的產物（純資料，沒有 TermChar
        // 參考），可以整份帶給守門用。
        self._lastFacts = facts;
        return {
          screen: c,
          listKind: facts.kind,
          rowTexts: facts.rowTexts,
          facts: facts
        };
      },
      onDone: function(result) {
        if (!self.active) return;
        cmd.done(result.screen, result);
      },
      onFail: function(reason) {
        if (cmd.fail) cmd.fail(reason);
        else self._fail(cmd.failMsg + '（' + reason + '）');
      },
      onFlushed: function() {
        self._onFlushed();
      }
    });
  },

  // -------------------------------------------------------------------------
  // 探路（preflight）：送一個 X，讀 PTT 的回答，再從推文流程退出來
  // -------------------------------------------------------------------------

  _enqueueProbeX: function() {
    const self = this;
    this._step({
      kind: 'longpush-probe',
      keys: 'X',
      failMsg: '按 X 進推文沒有回應',
      accept: function(c) {
        return c.kind !== 'other';
      },
      done: function(c, result) {
        self._afterProbeX(c, result);
      }
    });
  },

  // PTT 對那一個 X 的回答 → 能不能推 ＋ 順便讀到的事實。
  //
  //   fatal       擋人橫幅（含認不得的）⇒ 不能推，原文帶回去給使用者看
  //   cooldown    「請再等 N 秒」⇒ **不算不能推**：打完字通常早就超過那幾秒，
  //               送出時的既有冷卻等待會處理，這裡只把秒數帶回去提示
  //   typeMenu    推得了，順便知道這塊板讓不讓噓（BRD_NOBOO）
  //   inputPrompt 推得了，但 PTT 已經決定用 → 加註（作者本人／90 秒內連推），
  //               而且 prompt 上有自己的帳號 ⇒ 單則上限可以算準
  //   angel       推得了（小天使匿名板），同樣沒有型別選單
  //
  // 三條路都走同一個 _enqueueAbort 迴圈退出（fatal／cooldown 是橫幅 ⇒ 送空白鍵，
  // 其餘是推文流程 ⇒ 送 Ctrl-C），再過守門、按 ⏎ 回到原文章。
  _afterProbeX: function(c, result) {
    const self = this;
    const screen = {};
    if (c.kind === 'fatal') {
      this._preflightScreen = null;
    } else if (c.kind === 'cooldown') {
      screen.cooldownSec = c.waitSec;
      screen.cooldownMessage = c.message;
    } else if (c.kind === 'typeMenu') {
      screen.booAllowed = !!c.booAllowed;
    } else {
      // inputPrompt / angel：型別選單被跳過 ⇒ 這次一定是 →（bbs.c:2957-2974）。
      screen.degraded = true;
      if (c.kind === 'angel') screen.angel = true;
      if (c.userId) screen.userId = c.userId;
    }
    if (c.kind !== 'fatal') {
      // 畫面上還是文章，既有的推文列看得出這塊板記不記 IP ⇒ 單則上限的另一半。
      const ip = detectIpLogged(result ? result.rowTexts : null);
      if (ip !== null) screen.ipLogged = ip;
      if (screen.userId) this._userId = screen.userId;
      if (ip !== null) this._ipLogged = ip;
      this._maxBytes = pushMaxBytes({
        userId: this._userId,
        ipLogged: this._ipLogged
      });
      this._preflightScreen = screen;
    }

    const blocked = c.kind === 'fatal';
    const message = c.message;
    this._abortSteps = 0;
    this._enqueueAbort(
      function() {
        self._preflightLeave(blocked ? message : null);
      },
      function(reason) {
        // 收尾鍵沒有回應／被 flush：畫面狀態未知，不可以再送 ⏎ 回文章。
        self._preflightFail({
          source: 'client',
          message: MSG.noResponse,
          reason: reason || null
        });
      }
    );
  },

  // 退出推文流程之後：過守門、按 ⏎ 回原文章、還原閱讀位置，最後才回報結果。
  // 被擋下來的人也要回得去——他只是按了 X，不該因此丟掉閱讀進度。
  _preflightLeave: function(blockedMessage) {
    const self = this;
    const done = function(facts) {
      if (blockedMessage != null)
        return self._preflightFail({ source: 'ptt', message: blockedMessage });
      self._preflightDone(facts);
    };
    this._gate(this._lastFacts, function() {
      self._enqueueReopen(done);
    });
  },

  // start() 時人不在文章（preflight 的 reopen 沒回去）：先送 \f 看清楚現在在哪，
  // 再過守門。accept 是**白名單**——armed 期間可能已經斷線重連到登入畫面，
  // 在那裡往下送 X 等於亂按。
  //
  // 這裡送 \f 不違反「推文流程裡不用 fullRepaint」那條不變量：此刻人在列表／文章，
  // 沒有 vkey() 在等單一 byte（_enqueueAidRelocate 早就在同樣的位置這樣做）。
  _enqueueOrient: function() {
    const self = this;
    this._step({
      kind: 'longpush-orient',
      keys: '',
      fullRepaint: true,
      failMsg: MSG.unknownScreen,
      accept: function(c, facts) {
        return facts.kind === 'clean-list' || facts.kind === 'article';
      },
      done: function(c, result) {
        self._gate(result.facts, function() {
          self._enqueueOpen();
        });
      }
    });
  },

  // 步驟 1：按 X 進推文。回應有五種可能（型別選單／直接輸入列／小天使／冷卻／擋人）。
  _enqueueOpen: function() {
    const self = this;
    this._emit({});
    this._step({
      kind: 'longpush-open',
      keys: 'X',
      failMsg: '按 X 進推文沒有回應',
      accept: function(c) {
        return c.kind !== 'other';
      },
      done: function(c, result) {
        self._afterOpen(c, result);
      }
    });
  },

  _afterOpen: function(c, result) {
    if (c.kind === 'fatal') return this._fail(c.message, 'ptt');
    if (c.kind === 'cooldown') return this._enqueueDismissAndWait(c);
    if (c.kind === 'typeMenu') return this._enqueueType();
    if (c.kind === 'angel') return this._enqueueAngel();
    // inputPrompt：作者本人／90 秒內連推的降級分支，沒有型別選單可選。
    this._enqueueContent(c, result);
  },

  // 步驟 2：型別鍵。bbs.c:2996 是 vkey() ⇒ **單一 byte，不帶 Enter**
  // （Enter 會被下一個 getdata 吃掉 → 空內容 → 整則靜默取消）。
  _enqueueType: function() {
    const self = this;
    this._step({
      kind: 'longpush-type',
      keys: this._typeKey,
      failMsg: '選推文類型沒有回應',
      accept: function(c) {
        return (
          c.kind === 'inputPrompt' || c.kind === 'angel' || c.kind === 'fatal'
        );
      },
      done: function(c, result) {
        if (c.kind === 'fatal') return self._fail(c.message, 'ptt');
        if (c.kind === 'angel') return self._enqueueAngel();
        self._enqueueContent(c, result);
      }
    });
  },

  // 步驟 2.5：小天使匿名詢問（bbs.c:3060，vans → 要 Enter）。**空 Enter 等於答
  // YES**，所以一定要明確送 n。
  _enqueueAngel: function() {
    const self = this;
    this._step({
      kind: 'longpush-angel',
      keys: 'n\r',
      failMsg: '小天使匿名詢問沒有回應',
      accept: function(c) {
        return c.kind === 'inputPrompt' || c.kind === 'fatal';
      },
      done: function(c, result) {
        if (c.kind === 'fatal') return self._fail(c.message, 'ptt');
        self._enqueueContent(c, result);
      }
    });
  },

  // 步驟 3：內容 + Enter。queue 的 send 綁的是 raw conn.send（pttchrome.jsx），
  // 所以 convSend 會做的 Big5 轉碼要自己來（同 list_session 的貼上路徑）。
  _enqueueContent: function(screen, result) {
    // 這一幀的 prompt 帶著自己的帳號，是最準的 maxlength 來源；IP 記錄板則從畫面
    // 上已完成的推文列反推（判不出來時 pushMaxBytes 取較短的那個＝安全方向）。
    if (screen.userId) this._userId = screen.userId;
    const ip = detectIpLogged(result ? result.rowTexts : null);
    if (ip !== null) this._ipLogged = ip;
    this._maxBytes = pushMaxBytes({
      userId: this._userId,
      ipLogged: this._ipLogged
    });
    this._recount();

    const spans = this._pendingSpans();
    if (!spans.length) return this._finish({ kind: 'done', message: '長推文完成' });
    this._span = spans[0];
    this._emit({});

    const self = this;
    this._step({
      kind: 'longpush-content',
      keys: ansiHalfColorConv(u2b(this._span.text)) + '\r',
      failMsg: '推文內容沒有送出',
      accept: function(c) {
        return c.kind === 'confirm' || c.kind === 'fatal';
      },
      done: function(c) {
        if (c.kind === 'fatal') return self._fail(c.message, 'ptt');
        self._enqueueConfirm();
      }
    });
  },

  // 步驟 4：確定[y/N]。sizeof(ans)==2 ⇒ 只吃一個字元（bbs.c:3090-3106）。
  _enqueueConfirm: function() {
    const self = this;
    this._step({
      kind: 'longpush-confirm',
      keys: 'y\r',
      failMsg: '推文沒有存檔',
      // 寫檔後 return FULLUPDATE，整頁重畫 ⇒ 只要離開確認列就是回應了。
      accept: function(c) {
        return c.kind !== 'confirm';
      },
      done: function(c, result) {
        if (c.kind === 'fatal') return self._fail(c.message, 'ptt');
        self._onSegmentSent(result);
      }
    });
  },

  _onSegmentSent: function(result) {
    this._offset += this._span ? this._span.end : 0;
    this._span = null;
    this._sent++;
    // 第 1 則落地後畫面上就有自己剛推的那一列，用它把 IP 記錄板判準確
    // （第 1 則是用保守值算的，之後可以放寬）。
    const ip = detectIpLogged(result ? result.rowTexts : null);
    if (ip !== null) this._ipLogged = ip;
    if (this._userId)
      this._maxBytes = pushMaxBytes({
        userId: this._userId,
        ipLogged: this._ipLogged
      });
    this._recount();

    // 每一則重新給一次定位額度。
    this._relocations = 0;

    const self = this;
    if (this._pendingSpans().length)
      return this._gate(result && result.facts, function() {
        self._enqueueOpen();
      });

    const total = this._sent;
    if (result && result.listKind === 'clean-list' && this._startedInArticle) {
      // recommend() 一律 return FULLUPDATE（bbs.c:2467-2473），上游會把人丟回文章
      // 列表。使用者是從文章裡按的，就把他送回去——但**先確認游標還在原篇**：
      // 開錯文章比推錯更糟（使用者會在錯的地方繼續讀、繼續推）。
      return this._gate(result.facts, function() {
        self._enqueueReopen(function() {
          self._finishDone(total);
        });
      });
    }
    this._finishDone(total);
  },

  _finishDone: function(total) {
    this._finish({
      kind: 'done',
      message: '長推文完成，共送出 ' + total + ' 則'
    });
  },

  // -------------------------------------------------------------------------
  // 游標守門與重新定位
  // -------------------------------------------------------------------------

  // 在列表上做任何「對游標所指文章動手」的事之前都要先過這裡。
  // 決策表見 docs/long-push.md「游標錨定」。
  _gate: function(facts, proceed) {
    // 不在列表上（還在文章／其他畫面）⇒ X 推的就是當前這篇，沒有歧義。
    if (!facts || facts.kind !== 'clean-list') return proceed();

    const state = checkCursorAnchor(facts, this._anchor);
    if (state === 'ok') return proceed();

    // 連基準都沒有（文章標頭讀不到、也沒問到 AID）：退而求其次用**第一次**落地
    // 那一幀採一個。比文章標頭弱（可能已經飄過一次），但總比完全不比對好。
    // 有 AID 就**不**走這條——那是權威的，寧可多送一次 #<aid> 也不要把可能已經
    // 飄掉的畫面認成基準。
    if (!this._anchor || (!this._anchor.author && !this._anchor.aid)) {
      const cap = captureCursorAnchor(facts);
      if (!cap) return this._fail(MSG.cursorUnreadable);
      this._anchor = Object.assign({}, this._anchor, cap);
      return proceed();
    }

    this._enqueueRelocate(facts, proceed);
  },

  _enqueueRelocate: function(facts, proceed) {
    if (this._relocations >= MAX_RELOCATIONS)
      return this._fail(MSG.articleMoved);
    this._relocations++;

    // #<aid>⏎ 是 PTT 原生、權威的定位（read.c#select_by_aid 直接把 crs_ln 設到
    // 那一筆），優先用。
    if (this._anchor.aid) return this._enqueueAidRelocate(proceed);

    // 沒有 AID 就只能在**這一頁**上找回原篇再用編號跳。找不到＝原篇不在眼前，
    // 盲目翻頁去找等於在列表上亂按 —— 停手。
    const num = findAnchorRowNum(facts, this._anchor);
    if (num == null) return this._fail(MSG.articleMoved);
    this._enqueueNumberRelocate(num, proceed);
  },

  // 判準與 aid_navigation._enqueueAidSearch **共用同一個純函式**（aidSearchLanded）：
  // 兩邊送的是同一個 `#<aid>⏎` 交易，抄一份就會像 2026-09 的置底文 bug 一樣只修好
  // 一邊。置底（★）列沒有序號但**是**合法落點，理由與判準細節見該函式。
  _enqueueAidRelocate: function(proceed) {
    const self = this;
    this._step({
      kind: 'longpush-relocate-aid',
      keys: '#' + this._anchor.aid + '\r',
      fullRepaint: true,
      failMsg: '找不到原本那篇文章',
      accept: function(c, facts) {
        return aidSearchLanded(facts);
      },
      done: function(c, result) {
        // #AID 是權威的：select_by_aid 要嘛把 crs_ln 設到那一筆，要嘛回「找不到」
        // （accept 已經擋掉），所以落地那一列就是原篇本人。
        self._afterRelocate(result.facts, proceed, true);
      }
    });
  },

  _enqueueNumberRelocate: function(num, proceed) {
    const self = this;
    this._step({
      kind: 'longpush-relocate-num',
      keys: String(num) + '\r',
      fullRepaint: true,
      failMsg: '游標移不回原本那篇文章',
      accept: function(c, facts) {
        return (
          facts.cursorRowNum === num &&
          facts.curY >= 3 &&
          facts.curY <= facts.rows - 2
        );
      },
      done: function(c, result) {
        // 編號只是行號，**沒有**身分保證（這整個 bug 的根因就是它）：跳完一定要
        // 用身分再驗一次。
        self._afterRelocate(result.facts, proceed, false);
      }
    });
  },

  // 定位落地之後。
  //
  // authoritative（#AID 那條路）＝這一幀的游標列就是原篇本人，於是**重新採一次
  // 錨點**。這一步同時修掉轉錄文的誤判：轉錄文的內文標頭是**原文**作者，列表上
  // 印的卻是轉錄者 ⇒ 第一次比對必定 moved，重採之後就對得上了，不會每則都來回
  // 定位一次。
  //
  // 非 authoritative（編號跳）＝我們只是把游標移到「自己剛剛比對出來的那一列」，
  // 中間 server 還可能再變一次 ⇒ 必須用身分再驗，不符就停手。
  _afterRelocate: function(facts, proceed, authoritative) {
    if (!authoritative) {
      if (checkCursorAnchor(facts, this._anchor) !== 'ok')
        return this._fail(MSG.articleMoved);
      return proceed();
    }
    const cap = captureCursorAnchor(facts);
    if (cap) {
      this._anchor.author = cap.author;
      this._anchor.subject = cap.subject;
      this._anchor.num = cap.num;
    }
    proceed();
  },

  // 按 ⏎ 回到原文章並還原閱讀位置。兩個消費者：送完全部推文的收工，以及探路
  // 之後的歸位（被擋下來的人也要回得去）。land(facts) 的 facts 在回不去時是 null。
  _enqueueReopen: function(onLanded) {
    const self = this;
    const land = function(facts) {
      const er = self._core.easyReading;
      // 按 Q 取 AID 會把使用者踢出文章（view_postinfo 也 return FULLUPDATE），
      // 不還原閱讀位置等於把他的進度吃掉。
      if (self._readLineIndex && er && er.requestScrollRestore)
        er.requestScrollRestore(self._readLineIndex);
      onLanded(facts);
    };
    this._step({
      kind: 'longpush-reopen',
      keys: '\r',
      accept: function(c, facts) {
        return facts.kind === 'article' || c.kind !== 'other';
      },
      done: function(c, result) {
        land((result && result.facts) || null);
      },
      // 回不去只是停在列表，推文本身已經送完了，不該報成失敗。
      fail: function() {
        land(null);
      }
    });
  },

  // -------------------------------------------------------------------------
  // 冷卻與取消
  // -------------------------------------------------------------------------

  // 冷卻橫幅要一個按鍵才消得掉，消掉後才輪得到倒數（讓畫面回到文章／列表，
  // 使用者看得到自己在哪）。
  _enqueueDismissAndWait: function(c) {
    const self = this;
    this._emit({ phase: 'cooldown', waitSec: c.waitSec, message: c.message });
    this._step({
      kind: 'longpush-cooldown',
      keys: KEY_DISMISS,
      failMsg: '冷卻提示沒有消掉',
      accept: function(s) {
        return s.kind !== 'cooldown' && s.kind !== 'fatal';
      },
      done: function() {
        self._waitCooldown(c);
      }
    });
  },

  _waitCooldown: function(c) {
    const self = this;
    let left = c.waitSec;
    this._emit({ phase: 'cooldown', waitSec: left, message: c.message });
    const tick = function() {
      if (!self.active || self._cancelling) return;
      left--;
      if (left > 0) {
        self._emit({ phase: 'cooldown', waitSec: left, message: c.message });
        self._timer = setTimeout(tick, 1000);
        return;
      }
      self._timer = null;
      self._enqueueOpen();
    };
    this._timer = setTimeout(tick, 1000 + COOLDOWN_SLACK_MS);
  },

  // 取消收尾：把畫面從半途的推文流程帶回文章／列表。輸入列與確認列都吃 Ctrl-C
  // （清空 + abort ⇒ 什麼都不寫），橫幅吃任意鍵，型別選單沒有「取消」——送任何
  // 非數字都會被當成預設值進到輸入列，所以那一步先進去再 Ctrl-C 出來。
  // onSettled 是收尾完成後要做的事（預設：取消整趟長推文；探路階段傳的是「回原
  // 文章 → 回報結果」）。onLost 是收尾鍵逾時／被 flush 時的出口——那時畫面狀態
  // 未知，**不可以**再往下送 ⏎ 這類鍵（不變量 2），所以探路那條路會直接回報失敗。
  _enqueueAbort: function(onSettled, onLost) {
    const self = this;
    const settled =
      onSettled ||
      function() {
        self._finish({
          kind: 'cancel',
          source: 'client',
          message: MSG.cancelled,
          keepRest: true
        });
      };
    const lost = onLost || settled;
    const rows = this._termBuf.rows;
    const last = this._termBuf.getRowText(rows - 1, 0, this._termBuf.cols);
    const c = classifyPushScreen([last], 1);
    if (c.kind === 'other' || this._abortSteps >= MAX_ABORT_STEPS) {
      settled();
      return;
    }
    this._abortSteps++;
    const keys =
      c.kind === 'cooldown' || c.kind === 'fatal' ? KEY_DISMISS : KEY_ABORT;
    this._queue.enqueue({
      kind: 'longpush-abort',
      keys: keys,
      fullRepaint: false,
      probe: false,
      timeoutMs: STEP_TIMEOUT_MS,
      hardTimeoutMs: STEP_HARD_TIMEOUT_MS,
      expect: function(snapshot, facts) {
        const s = classifyPushScreen(facts.rowTexts, facts.rows);
        if (s.kind === c.kind) return false;
        // 收尾完要用**新鮮的** facts 過守門（探路那條路接著要按 ⏎ 回文章）。
        self._lastFacts = facts;
        return { screen: s };
      },
      onDone: function() {
        self._enqueueAbort(onSettled, onLost);
      },
      // 收不回來就放手：畫面留在原生鏡像，使用者自己按 ← 就好。
      onFail: function(reason) {
        lost(reason);
      },
      onFlushed: function() {
        lost('flush');
      }
    });
  }
};

export default LongPushSession;
