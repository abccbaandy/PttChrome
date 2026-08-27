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
// 1. **不用 fullRepaint／probe（兩者都會送 Ctrl-L）**：型別選單那一格是 vkey() 取
//    單一 byte（bbs.c:2996），非數字一律當 RECTYPE_DEFAULT＝推。萬一 Ctrl-L 沒有被
//    io.c#system_key_hook 完全吃掉，就是在使用者沒選的情況下推出去。這個功能會把
//    內容寫進公開看板，「送錯」比「失敗」嚴重得多 ⇒ 逾時直接失敗，停在原生畫面。
// 2. **未知畫面一律停手**（classifyPushScreen 回 'other'/'fatal'）：繼續盲送鍵在
//    PTT 上等於亂按快捷鍵。
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

    // 把**真的**原生畫面放到台面上再開始驅動它：文章好讀的 functionMode 是既有的
    // 即時鏡像機制（先例 deep_link_controller / aid_navigation），列表好讀則停到
    // 它自己的 functionMode，讓共用 queue 淨空、reducer 不來搶我們的 settle。
    const er = this._core.easyReading;
    if (er && er._enterFunctionMode) er._enterFunctionMode();
    if (this._core.listSession && this._core.listSession.beginExternalNavigation)
      this._core.listSession.beginExternalNavigation();

    this._enqueueOpen();
    return true;
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
      // Ctrl-L 一律不送（見檔頭「三個刻意的保守選擇」第 1 點）。
      fullRepaint: false,
      probe: false,
      timeoutMs: STEP_TIMEOUT_MS,
      hardTimeoutMs: STEP_HARD_TIMEOUT_MS,
      expect: function(snapshot, facts) {
        const c = classifyPushScreen(facts.rowTexts, facts.rows);
        if (!cmd.accept(c, facts)) return false;
        return { screen: c, listKind: facts.kind, rowTexts: facts.rowTexts };
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

    if (this._pendingSpans().length) return this._enqueueOpen();

    const total = this._sent;
    if (result && result.listKind === 'clean-list' && this._startedInArticle) {
      // recommend() 一律 return FULLUPDATE（bbs.c:2467），上游會把人丟回文章列表。
      // 使用者是從文章裡按的，就把他送回去——游標仍停在原篇（recommend 不動游標）。
      this._enqueueReopen(total);
      return;
    }
    this._finish('長推文完成，共送出 ' + total + ' 則', false);
  },

  _enqueueReopen: function(total) {
    const self = this;
    const done = function() {
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
