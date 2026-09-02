// 長推文一鍵發送的送出狀態機。
//
// 使用者在右鍵選單開的輸入框打一大段話 → long_push.js 依 Big5 byte 上限切成 N 則
// → 這裡把每一則都跑完一次完整的 PTT 推文互動（X → 型別 → 內容 → 確定[y/N]），
// 撞到冷卻就等，等完繼續。整段期間 term_view / pttchrome 的輸入入口靠 `active`
// 擋掉使用者按鍵（比照 aid_navigation.active），畫面上蓋一層進度遮罩。
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

// vgetstring 的 Ctrl-C：清空 buf 並 abort（vtuikit.c:1345-1351）⇒ getdata 回 0
// ⇒ recommend() 直接 return FULLUPDATE，不寫入任何東西。取消時用它退出輸入列／
// 確認列。
const KEY_ABORT = '\x03';
// vmsg 的 `do { i = vkey(); } while (i == 0);` 要一個真的按鍵才消得掉；Ctrl-L 會被
// io.c#system_key_hook 吃掉（aid_navigation.js:89-103 的同一個坑），所以用空白。
const KEY_DISMISS = ' ';

// 每一步的等待預算。推文的回應是 server 立刻重畫底列，正常在一個 round-trip 內。
const STEP_TIMEOUT_MS = 5000;
const STEP_HARD_TIMEOUT_MS = 12000;
// 冷卻倒數多等一秒：server 的秒數是整數截斷的（(int)time4_diff），剛好踩點會再被擋一次。
const COOLDOWN_SLACK_MS = 1000;
// 取消時最多送幾次收尾鍵。收不回來就放手，畫面留給使用者自己處理。
const MAX_ABORT_STEPS = 3;
// 每一則最多重新定位一次。定位完還對不上就是我們迷路了 —— 這種時候再送 X 等於
// 亂推，寧可停手把剩下的內容還給使用者。
const MAX_RELOCATIONS = 1;

export function LongPushSession(core, view, termBuf, queue) {
  this._core = core;
  this._view = view;
  this._termBuf = termBuf;
  this._queue = queue;
  // 送出序列進行中：term_view.onKeyDown / App.onFunctionKey / 各 mouse 入口都
  // 檢查它並吞掉使用者輸入（同 aidNavigation.active）。
  this.active = false;
  // 進度回呼（ContextMenu 掛上來畫遮罩）。null = 沒人看。
  this.onChange = null;
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
    this._clearTimer();
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

  _finish: function(msg, copyRest) {
    const rest = copyRest ? this._rest() : '';
    const sent = this._sent;
    this.active = false;
    this._clearTimer();
    this._emit(null);
    if (rest && this._core.doCopy) this._core.doCopy(rest);
    this._reset();
    if (msg) this._hint(msg + (sent ? '（已送出 ' + sent + ' 則）' : ''));
  },

  // 失敗：停在原生畫面，剩下的內容進剪貼簿（使用者定案）。
  _fail: function(msg) {
    if (!this.active) return;
    this._finish('長推文中止：' + msg + '，剩餘內容已複製', true);
  },

  // -------------------------------------------------------------------------
  // 入口
  // -------------------------------------------------------------------------

  // text 必須是已過 stripNonBig5 的內容；type ∈ 'push' | 'boo' | 'arrow'。
  // maxBytes 是呼叫端算的**預估**上限（拿不到帳號時 pushMaxBytes 會給保守值），
  // 第一則進到輸入列後就會被畫面校正。回 true 表示序列已開始。
  start: function(opts) {
    const o = opts || {};
    if (this.active) return false;
    const text = String(o.text || '');
    this._reset();
    this._text = text;
    this._maxBytes = o.maxBytes || pushMaxBytes({});
    this._recount();
    if (!this._total) return false;

    this._typeKey = PUSH_TYPE_KEY[o.type] || PUSH_TYPE_KEY.push;
    this._startedInArticle = this._termBuf.pageState === 3;
    this.active = true;

    // ORDER INVARIANT：閱讀位置與文章標頭都必須在 _enterFunctionMode() **之前**
    // 讀。那個函式結尾的 termBuf.notify() 是同步的，term_view.redraw 的
    // functionMode 分支第一件事就是 mainDisplay.scrollTop = 0（同一條不變量在
    // deep_link_controller.copyCurrentPostLink 與 aid_navigation.start 都有註解）。
    this._readLineIndex = this._currentLineIndex();
    // 錨點基準一定要在**還在文章裡**的時候取：第 1 則落回列表那一幀已經是
    // i_read 重讀 headers 之後的畫面，游標列可能早就換人，拿它當基準等於把污染
    // 當成正確值（long_push_anchor.js 檔頭有完整推導）。
    this._anchor = articleAnchor(this._articleHeadRows());

    // 把**真的**原生畫面放到台面上再開始驅動它：文章好讀的 functionMode 是既有的
    // 即時鏡像機制（先例 deep_link_controller / aid_navigation），列表好讀則停到
    // 它自己的 functionMode，讓共用 queue 淨空、reducer 不來搶我們的 settle。
    const er = this._core.easyReading;
    if (er && er._enterFunctionMode) er._enterFunctionMode();
    if (this._core.listSession && this._core.listSession.beginExternalNavigation)
      this._core.listSession.beginExternalNavigation();
    if (this._core.boardListSession && this._core.boardListSession.beginExternalNavigation)
      this._core.boardListSession.beginExternalNavigation();

    this._enqueueResolveAid();
    return true;
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
  _enqueueResolveAid: function() {
    const nav = this._core.aidNavigation;
    if (!nav || !nav.resolvePostAid || !this._startedInArticle)
      return this._enqueueOpen();
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
        self._enqueueOpen();
      },
      onFail: function(reason) {
        self._fail('讀不到文章代碼（' + reason + '）');
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
        if (c.kind === 'fatal') return self._fail(c.message);
        self._gate(result.facts, function() {
          self._enqueueOpen();
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
    this._enqueueAbort();
  },

  // queue 被別人 flush 掉（斷線／切原生鏡像／list_session 清理）。持有輸入阻擋
  // 旗標的人一定要實作這個 hook，否則 active 永遠卡在 true，整頁再也收不到鍵盤
  // （command_queue.js:114-119 的硬性要求）。
  _onFlushed: function() {
    if (this._cancelling) return; // 取消路徑自己會收尾
    this._fail('畫面已變更');
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
    if (c.kind === 'fatal') return this._fail(c.message);
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
        if (c.kind === 'fatal') return self._fail(c.message);
        if (c.kind === 'angel') return self._enqueueAngel();
        self._enqueueContent(c, result);
      }
    });
  },

  // 步驟 2.5：小天使匿名詢問（bbs.c:3055，vans → 要 Enter）。**空 Enter 等於答
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
        if (c.kind === 'fatal') return self._fail(c.message);
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
    if (!spans.length) return this._finish('長推文完成', false);
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
        if (c.kind === 'fatal') return self._fail(c.message);
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
        if (c.kind === 'fatal') return self._fail(c.message);
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
        self._enqueueReopen(total);
      });
    }
    this._finish('長推文完成，共送出 ' + total + ' 則', false);
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
      if (!cap) return this._fail('讀不出游標所在的文章');
      this._anchor = Object.assign({}, this._anchor, cap);
      return proceed();
    }

    this._enqueueRelocate(facts, proceed);
  },

  _enqueueRelocate: function(facts, proceed) {
    if (this._relocations >= MAX_RELOCATIONS)
      return this._fail('文章位置已變動');
    this._relocations++;

    // #<aid>⏎ 是 PTT 原生、權威的定位（read.c#select_by_aid 直接把 crs_ln 設到
    // 那一筆），優先用。
    if (this._anchor.aid) return this._enqueueAidRelocate(proceed);

    // 沒有 AID 就只能在**這一頁**上找回原篇再用編號跳。找不到＝原篇不在眼前，
    // 盲目翻頁去找等於在列表上亂按 —— 停手。
    const num = findAnchorRowNum(facts, this._anchor);
    if (num == null) return this._fail('文章位置已變動');
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
        return this._fail('文章位置已變動');
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

  _enqueueReopen: function(total) {
    const self = this;
    const done = function() {
      const er = self._core.easyReading;
      // 按 Q 取 AID 會把使用者踢出文章（view_postinfo 也 return FULLUPDATE），
      // 不還原閱讀位置等於把他的進度吃掉。
      if (self._readLineIndex && er && er.requestScrollRestore)
        er.requestScrollRestore(self._readLineIndex);
      self._finish('長推文完成，共送出 ' + total + ' 則', false);
    };
    this._step({
      kind: 'longpush-reopen',
      keys: '\r',
      accept: function(c, facts) {
        return facts.kind === 'article' || c.kind !== 'other';
      },
      done: done,
      // 回不去只是停在列表，推文本身已經送完了，不該報成失敗。
      fail: done
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
  _enqueueAbort: function() {
    const self = this;
    const rows = this._termBuf.rows;
    const last = this._termBuf.getRowText(rows - 1, 0, this._termBuf.cols);
    const c = classifyPushScreen([last], 1);
    if (c.kind === 'other' || this._abortSteps >= MAX_ABORT_STEPS) {
      this._finish('長推文已取消，剩餘內容已複製', true);
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
        return s.kind !== c.kind ? { screen: s } : false;
      },
      onDone: function() {
        self._enqueueAbort();
      },
      // 收不回來就放手：畫面留在原生鏡像，使用者自己按 ← 就好。
      onFail: function() {
        self._finish('長推文已取消，剩餘內容已複製', true);
      },
      onFlushed: function() {
        self._finish('長推文已取消，剩餘內容已複製', true);
      }
    });
  }
};

export default LongPushSession;
