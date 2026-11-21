// 文章列表（list_session.js）與看板列表（board_list_session.js）兩個捲動引擎**逐字相同**的方法
// （架構改善 A9 第一步：列表引擎合一）。兩邊的 prototype 都以 `...LIST_ENGINE_SHARED` 展開，
// 自己不再各寫一份；用到的類別專屬方法（_tryResumeProbe、_maybeFill、_degradeToNative、
// headerRows、onFunctionKey、_dispatch）仍由各自的 prototype 提供。
//
// **只放「行為也相同」的**：文字一樣但呼叫了各檔私有、內容不同的 helper 的不能搬
// （例：onPaste／noteTextInput 的提示字來自各自的 nativeResumeHint，看板列表講「平滑捲動」）。
// 守護 tests/unit/list_engine_shared.test.js。

import { readEffectivePrefs } from './pref_storage';
import { LEFT_ARROW } from './function_key_plan';
import { listRowSpan, listFillRows } from './mobile_layout';

// 靜置探針的安靜時間（PTT 約 90ms 回應 + settle 50ms ⇒ 250ms 靜默已屬異常）。
// 兩個 session 自己的 CMD_PROBE_AFTER_MS（＝它們的 RESUME_QUIET_MS）要跟這裡一樣，測試守。
export const RESUME_QUIET_MS = 250;
// 凍結後盾在「線路靜默寬限」之後多等多久再看一次。
const STALL_WATCHDOG_SLACK_MS = 200;
// 平滑捲動動畫到站的逾時（使用者中途自己捲動會取消瀏覽器動畫，永遠到不了目標）。
const SCROLL_ANIM_MAX_MS = 1000;

export const LIST_ENGINE_SHARED = {
  // pref 開著＝本功能（L1 凍結交易 ＋ L2 自動回復）生效；關掉＝**逐位元回到
  // 2026-09-03 之前**：A 類鍵一律走 passthrough、探針一次都不排。
  // 這是使用者拍板的逃生門（三階梯見 docs/easy-reading-list.md）：判定類功能的
  // 最後一道防線就是設定開關，全關就回到原生體驗。
  _autoResumeEnabled: function() {
    return !!readEffectivePrefs().enableListNativeAutoResume;
  },

  // 使用者往 PTT 送了 byte（原生鏡像期間鍵盤／貼上／IME／點功能鍵都走不到
  // activeListSession()，所以這條是**無條件**從 term_view / pttchrome 呼進來的）。
  // **只記時間戳，不得有任何其他副作用**（不變量 N2）。
  noteNativeInput: function() {
    this._lastUserByteAt = Date.now();
    this._scheduleResumeProbe();
  },

  // (重新)排定探針。排定點：進入 hold 當下、每一次 settle、每一次使用者送 byte。
  // 取消點：離開 functionMode／cleanup／pref-off／hold 變 external／斷線 ——
  // 全部收斂到「holdReason !== 'passthrough' 就清掉」這一條。
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

  // Pref flipped OFF / disconnect: single exit (mirrors exitEasyReading rigor).
  disable: function() {
    this._dispatch({ type: 'pref-off' }, null);
  },

  // 滑鼠的左側退出帶（cols 0-6）→ 與按 ← 完全同一條路。
  // **絕不直送 byte**：_beginLeave 會先 getkeep 把 server 的真游標同步回來再送鍵。
  onMouseExitClick: function() {
    return this.onFunctionKey(LEFT_ARROW);
  },

  _startFill: function() {
    this._fillTarget = readEffectivePrefs().easyReadingListPrefetchCount || 0;
    this._fillPages = 0;
    this._maybeFill();
  },

  // 凍結後盾：時間到還在凍結（或開文中）就降級回原生。
  _setFrozenWatchdog: function(ms) {
    const self = this;
    if (this._frozenWatchdog) clearTimeout(this._frozenWatchdog);
    this._frozenWatchdog = setTimeout(function() {
      self._frozenWatchdog = null;
      if (self._renderMode !== 'frozen' && self.state !== 'opening') return;
      // 線路完全沒聲音、在飛命令還在靜默寬限內（command_queue.js 檔頭
      // stallCapMs）：讓命令自己的有界截止點先收尾（它的 onFail 會降級），後盾
      // 只往後挪到那之後再看一次。寬限是送出起算的絕對值 ⇒ 不會無限延長。
      const stallMs = self._queue.stallWaitMs ? self._queue.stallWaitMs() : 0;
      if (stallMs > 0) {
        self._setFrozenWatchdog(stallMs + STALL_WATCHDOG_SLACK_MS);
        return;
      }
      self._degradeToNative('指令逾時，已切至原生模式');
    }, ms);
  },

  // The window's body row count: the native list body (rows 3..rows-2 on a
  // 24-row screen = 20 entries, pttbbs p_lines).
  _bodyRows: function() {
    return this._termBuf.rows - 4;
  },

  prunePivot: function() {
    return this._prunePivotOverride !== undefined
      ? this._prunePivotOverride
      : this._selectedNum;
  },

  // 動畫到站了嗎（順便清掉）。逾時逃生門：使用者中途自己捲動會取消瀏覽器的
  // 動畫，那時永遠到不了目標。
  _scrollAnimSettled: function(px) {
    const a = this._scrollAnim;
    if (!a) return true;
    if (Math.abs(px - a.px) < 1 || Date.now() - a.at > SCROLL_ANIM_MAX_MS) {
      this._scrollAnim = null;
      return true;
    }
    return false;
  },

  // 一筆在捲動視口裡的高度（未縮放）。一般＝chh；手機卡片（view.listCards，
  // docs/mobile.md「Phase 4」）＝ LIST_CARD_ROWS × chh。list_scroll.js 的數學只要
  // 「每筆等高」，所以整個捲動／錨定／reveal 只靠這一支就換成卡片座標。
  _rowHeight: function() {
    const v = this._view;
    return ((v && v.chh) || 0) * listRowSpan(!!(v && v.listCards));
  },

  // PgUp／PgDn 一次翻幾筆＝視口放得下幾筆。卡片模式一筆佔 LIST_CARD_ROWS 列，
  // 翻 bodyRows 筆會跳過半屏沒看過的東西；視口高也不同（header／footer 收起，
  // mobile_layout.listViewportGeometry，與 term_view／clientToPos 同源）。
  // **只給視口操作用**：_bodyRows 仍是 server 的 p_lines（抓頁／補頁的單位），不可以一起換。
  _pageRows: function() {
    const v = this._view;
    const cards = !!(v && v.listCards);
    return listFillRows({ rows: this._termBuf.rows, headerRows: this.headerRows(), cards: cards });
  },

  _screen: function() {
    return (this._view && this._view.componentScreen) || null;
  }
};
