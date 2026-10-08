// 跳過進板畫面（pref skipBoardEntryScreen，預設開）：使用者從看板列表／選擇看板
// prompt 進板時，PTT 先畫的那張進板畫面（看板公告，可能是動畫）由程式代按一鍵收掉，
// 直接落在文章列表。
//
// ---- pttbbs 事實（3rd_script/pttbbs，Big5；PTT 邏輯不准猜）----
// 1. 進板畫面只有 Read() 會畫（bbs.c#Read:4466-4476）：
//      if (currbid != bnote_lastbid && board_note_time && *board_note_time) {
//          mr = more(notes, NA);              // NA == PMORE_AUTO_EXIT
//          if (mr == -1) ...; else if (mr != READ_NEXT) pressanykey();
//      }
//    `bnote_lastbid` 是行程內的 static cache ⇒ 同一連線第二次進同一板**不會**再畫
//    （docs/pttbbs-screen-protocol.md「進版畫面的完整序列」）。⇒ 不可以預先送鍵：
//    畫面沒出現時那一鍵會直接落進文章列表。一律「看到了才送」。
// 2. 呼叫 Read() 的入口：看板列表 board_cmd_select（board.c:2343 起的鍵表：
//    KEY_RIGHT／KEY_ENTER／'r'／'l'）、看板列表 `s` 的 board_cmd_search_global
//    （board.c:2122，「搜尋全站看板」prompt ⏎）、主功能表 `s` 的 ReadSelect
//    （menu.c:670 → bbs.c:4489，「選擇看板」prompt ⏎）。文章列表的 `s` 只跑
//    do_select、**不**進 Read()（bbs.c:4393）——arm 了也只會等到文章列表就解除。
//    文章列表的 `(b)進板畫面` 是使用者**要看**，不在入口集合內（不是看板列表畫面）。
// 3. 動畫：PMORE_AUTO_EXIT 下有 ASCII movie 就自動播放（pmore.c:3094-3110），
//    footer 是 pmore.c:163-169 的「動畫播放中… 可按 q, Ctrl-C 或其它任意鍵停止」／
//    「互動式動畫播放中」／「暫停播放動畫」。播放中的按鍵由 mf_movieWaitKey
//    （pmore.c:3670）用 vkey() **讀掉**，mf_movieSyncFrame 回 0 ⇒ STOP_MOVIE 且
//    `flExit = 1, retval = READ_NEXT`（pmore.c:3196-3202）⇒ Read() **不**再
//    pressanykey，直接 i_read。互動式動畫會遮罩按鍵（mf_movieMaskedInput），但
//    `q`／Ctrl-C 永遠不可遮罩（pmore.c:3871-3887）⇒ 動畫一律送 `q`。
//    播完才按（自然結束 retval 0）就是 pressanykey，同樣吃掉一鍵 ⇒ 兩種競態都無害。
// 4. 非動畫的公告：一頁以內 pmore 畫完就自動離開 → pressanykey（vtuikit.c:445，
//    任何真按鍵；Ctrl-L 不算，所以用空白）。多頁的 PMORE_AUTO_EXIT 不畫 footer
//    prompt（末列空白、游標停末列，classifyListScreen 判 'prompt'）；有 footer 的
//    形狀判 'article'。兩者送 ←（離開 pmore，接著 pressanykey 再收一鍵）——
//    與 aid_navigation._enqueueEnterBoardDismiss 同一組事實（live 驗過）。
//
// ---- 為什麼要 arm（不能光看畫面）----
// pressanykey／pmore／動畫在 PTT 到處都有（站內信、說明、文章本身的動畫）。只有
// 「剛在看板列表按了進板鍵」之後出現的才是進板畫面。所以：送出入口
// （telnet._sendEscaped → noteSent）看到進板鍵＋當下是看板列表畫面 ⇒ arm；
// 之後每一個 settle 依畫面決定 skip／landed（解除）／wait；ARM_MS 內沒等到就解除。
// arm 期間有**別人**送 byte（使用者自己按了鍵）⇒ 立刻解除，絕不跟使用者搶鍵。
//
// 送鍵走共用 CommandQueue（一次一個鍵、fullRepaint、expect 以畫面內容判定）；
// in-flight 期間 `busy` 經 serialized_op_gate 擋使用者輸入（否則使用者自己那一鍵
// 先收掉畫面，我們的鍵就落進文章列表：← 會直接離板）。
// `active`（arm 或 busy）期間好讀不准把進板公告當文章開（easy_reading._navActive）。
//
// 守護 tests/unit/board_note_skip.test.js；說明見 docs/board-note-skip.md。

import { classifyListScreen } from './list_session';
import { classifyBoardListScreen } from './board_list_parse';
import {
  ARCHIVE_LIST,
  BOARD_LIST,
  CLASS_LIST,
  FAVOURITE,
  MAIN_MENU,
  rowHasAnyTitle
} from './screen_titles';
import { readValuesWithDefault } from './pref_storage';

export const KEY_LEFT = '\x1b[D';
export const KEY_ANY = ' ';
export const KEY_MOVIE_BREAK = 'q';

// arm 之後等第一張畫面的上限（server 要開 .DIR、畫公告；慢線路也夠）。
export const ARM_MS = 8000;
// 一次進板最多代按幾鍵：多頁 pager ← ＋ pressanykey 空白＝2，留餘裕。
export const MAX_ROUNDS = 4;

const STEP_PROBE_AFTER_MS = 700;
const STEP_PROBE_WINDOW_MS = 700;
const STEP_HARD_MS = 3000;

// pmore.c:163-169 的三種動畫 footer。「暫停播放動畫，請按任意鍵繼續或 q 中斷」也含
// 「請按任意鍵繼續」——但那裡按任意鍵是**繼續播**，所以動畫判定必須排在 pressanykey 前。
const MOVIE_FOOTER_RE = /動畫播放中|暫停播放動畫/;
// pressanykey（vtuikit.h:61 VMSG_PAUSE）。vmsg 帶訊息的「[按任意鍵繼續]」沒有「請」
// ⇒ 不命中：進板失敗的 vmsg（「您沒有進入此看板的權限！」）要留給使用者看。
const PRESS_ANY_KEY_RE = /請按任意鍵繼續|請按 空白鍵 繼續/;
// CompleteBoard 的兩個 prompt 標題（include/common.h MSG_SELECT_BOARD、
// board.c#board_cmd_search_global）。
const BOARD_PROMPT_RE = /選擇看板|搜尋全站看板/;

// 「已經離開進板流程」的 row 0 標題（主選單／看板列表／精華區…）。
const LANDED_TITLES = [MAIN_MENU, CLASS_LIST, ARCHIVE_LIST, BOARD_LIST, FAVOURITE];

// 看板列表上會進入 Read() 的單鍵（board.c 鍵表的 board_cmd_select）。
const ENTRY_KEYS = ['\r', '\n', '\r\n', '\x1b[C', '\x1bOC', 'r', 'l'];
// 滑鼠點列 ＝ 一串 ↑/↓ 再 ⏎（pttchrome.jsx 的 ACT_ENTER）。
const MOVE_PREFIX_RE = /^(?:\x1b\[[AB]|\x1bO[AB])+/;

function stripTrailingRedraw(bytes) {
  return String(bytes == null ? '' : bytes).replace(/\f+$/, '');
}

// 這串 bytes 在看板列表上是不是「進入游標下的看板」。
export function isBoardEntryKey(bytes) {
  const s = stripTrailingRedraw(bytes).replace(MOVE_PREFIX_RE, '');
  return ENTRY_KEYS.indexOf(s) !== -1;
}

// 送出這串 bytes 的當下畫面（rowTexts）＋bytes ⇒ 要不要 arm。
export function boardEntryArms(rowTexts, bytes) {
  const rows = rowTexts || [];
  const row0 = rows[0] || '';
  if (rowHasAnyTitle(row0, [BOARD_LIST, FAVOURITE, CLASS_LIST]))
    return isBoardEntryKey(bytes);
  // prompt 標題畫在 row 0（do_select 的 move(0,0)），輸入欄在 row 1。
  if (BOARD_PROMPT_RE.test(row0) || BOARD_PROMPT_RE.test(rows[1] || '')) {
    const s = stripTrailingRedraw(bytes);
    return /[\r\n]$/.test(s);
  }
  return false;
}

// arm 期間的一張靜止畫面該怎麼處理。facts ＝ { rowTexts, rows, curX, curY, kind,
// boardName }（kind／boardName 是 classifyListScreen 的輸出，list_session 的
// facts 本來就帶；缺的話這裡補算）。回：
//   { action: 'landed' }                已到文章列表／看板列表／選單 ⇒ 解除
//   { action: 'skip', key, shape }      進板畫面 ⇒ 送 key
//   { action: 'wait' }                  認不出（半繪、vmsg 錯誤訊息…）⇒ 不動
export function boardNoteDecision(facts) {
  const f = facts || {};
  const rowTexts = f.rowTexts || [];
  const rows = f.rows || rowTexts.length;
  const last = rowTexts[rows - 1] || '';
  let kind = f.kind;
  let boardName = f.boardName;
  if (kind === undefined) {
    const cls = classifyListScreen({
      rowTexts: rowTexts,
      rows: rows,
      curX: f.curX,
      curY: f.curY,
      row0Reversed: !!f.row0Reversed,
      row2Reversed: !!f.row2Reversed
    });
    kind = cls.kind;
    boardName = cls.boardName;
  }
  if (MOVIE_FOOTER_RE.test(last))
    return { action: 'skip', key: KEY_MOVIE_BREAK, shape: 'movie' };
  // 落地只認 row 0 的標題，**不認 kind 'menu'**：那個分類也吃「底列是主選單 footer」
  // （parseListRow），而 do_select 只清 row 0/1 ⇒ 板名回顯那一幀（prompt 疊在主選單上）
  // 會被當成已落地、在進板畫面送達前就解除（live 2026-10-08 實錄）。
  if (
    kind === 'clean-list' ||
    rowHasAnyTitle(rowTexts[0] || '', LANDED_TITLES) ||
    classifyBoardListScreen(f)
  )
    return { action: 'landed' };
  if (PRESS_ANY_KEY_RE.test(last))
    return { action: 'skip', key: KEY_ANY, shape: 'pause' };
  if (kind === 'article')
    return { action: 'skip', key: KEY_LEFT, shape: 'pager' };
  // PMORE_AUTO_EXIT 多頁公告：末列空白、游標停末列。row 0 有《板名》＝文章列表半繪，
  // 不是公告 —— 那裡送 ← 會離板。
  if (kind === 'prompt' && !last.trim() && boardName == null)
    return { action: 'skip', key: KEY_LEFT, shape: 'pager' };
  return { action: 'wait' };
}

export function BoardNoteSkip(core, view, termBuf, queue) {
  this._core = core;
  this._view = view;
  this._termBuf = termBuf;
  this._queue = queue;
  // arm 了、還在等進板畫面（或文章列表）出現。
  this.armed = false;
  // 我們的鍵在線上（serialized_op_gate 據此擋使用者輸入）。
  this.busy = false;
  this._armedAt = 0;
  this._rounds = 0;
  // queue 的 onSend 立起、noteSent 消費：分辨「這串 bytes 是我們送的」。
  this._ownSend = false;
  if (termBuf && termBuf.addEventListener)
    termBuf.addEventListener('screenSettled', this._onScreenSettled.bind(this));
}

BoardNoteSkip.prototype = {
  // 好讀的 navActive 閘門讀它：arm 或 in-flight 期間的 pmore 是進板公告，不是文章。
  get active() {
    return this.busy || (this.armed && !this._armExpired());
  },

  _enabled: function() {
    return !!readValuesWithDefault().skipBoardEntryScreen;
  },

  _log: function(name, info) {
    this._core && this._core.debugRecorder && this._core.debugRecorder.log('boardNoteSkip.' + name, info);
  },

  // 別的序列化操作在驅動畫面時，進板畫面是它的（aid_navigation 自己收）。
  _othersBusy: function() {
    const c = this._core || {};
    return !!(
      (c.aidNavigation && c.aidNavigation.active) ||
      (c.longPush && c.longPush.busy) ||
      (c.logout && c.logout.active)
    );
  },

  _armExpired: function() {
    return Date.now() - this._armedAt > ARM_MS;
  },

  _rowTexts: function() {
    const buf = this._termBuf;
    const rows = [];
    for (let r = 0; r < buf.rows; ++r) rows.push(buf.getRowText(r, 0, buf.cols));
    return rows;
  },

  // telnet 送出出口（TelnetConnection.onDataSent）：每一串資料 bytes 都會經過這裡。
  noteSent: function(bytes) {
    if (this._ownSend) {
      this._ownSend = false;
      return;
    }
    // queue 的探針（裸 \f）與 Ctrl-L 重繪不是按鍵。
    if (!stripTrailingRedraw(bytes)) return;
    if (this.busy) return;
    if (this.armed) {
      // 別人（使用者）在 arm 期間按了鍵：畫面歸他，不搶。
      this._disarm('foreign-key');
    }
    if (this._othersBusy() || !this._enabled()) return;
    if (!boardEntryArms(this._rowTexts(), bytes)) return;
    this.armed = true;
    // arm 之後還沒收到任何 server 資料：這段期間的 settle 都是舊畫面。
    this._sawResponse = false;
    this._armedAt = Date.now();
    this._rounds = 0;
    this._log('arm', {});
  },

  // server 資料到達（App.onData）。
  noteRecv: function() {
    if (this.armed) this._sawResponse = true;
  },

  _disarm: function(reason) {
    if (!this.armed && !this.busy) return;
    this.armed = false;
    this.busy = false;
    // 送不出去（斷線）時 onSend 立的旗標不會被 noteSent 消費，不可以留給使用者的下一鍵。
    this._ownSend = false;
    this._log('disarm', { reason: reason });
  },

  _onScreenSettled: function() {
    if (!this.armed || this.busy) return;
    // 進板鍵常常是在**某個 settle 的處理途中**送出的（看板列表平滑捲動：sync-jump 的
    // queue.done → 同一輪排出開板命令 → 送 `\r` → arm），而我們的 listener 排在同一個
    // settle 的最後 ⇒ 會看到送鍵前的舊看板列表，判成「已落地」立刻解除
    // （ptt-debug-20261008-215452：arm 與 disarm 同一毫秒）。回應到了才判。
    if (!this._sawResponse) return;
    if (this._armExpired()) {
      this._disarm('expired');
      return;
    }
    const snap = this._termBuf.settleSnapshot;
    // 純本地重繪（沒有 server 寫入、游標也沒動）不是回應。
    if (snap && snap.changedRows && snap.changedRows.size === 0 && !snap.cursorMoved) return;
    if (this._othersBusy()) {
      this._disarm('others-busy');
      return;
    }
    const buf = this._termBuf;
    const d = boardNoteDecision({
      rowTexts: this._rowTexts(),
      rows: buf.rows,
      curX: snap ? snap.curX : buf.cur_x,
      curY: snap ? snap.curY : buf.cur_y,
      row0Reversed: buf.isUnicolor ? buf.isUnicolor(0, 0, 29) : false,
      row2Reversed: buf.isUnicolor ? buf.isUnicolor(2, 0, buf.cols - 10) : false
    });
    if (d.action === 'landed') this._disarm('landed');
    else if (d.action === 'skip') this._enqueueSkip(d);
  },

  _enqueueSkip: function(d) {
    const self = this;
    if (this._rounds >= MAX_ROUNDS) {
      this._disarm('max-rounds');
      return;
    }
    this._rounds += 1;
    this.busy = true;
    this._log('skip', { shape: d.shape, round: this._rounds });
    this._queue.enqueue({
      keys: d.key,
      kind: 'board-note-skip',
      fullRepaint: true,
      timeoutMs: STEP_PROBE_AFTER_MS,
      probeTimeoutMs: STEP_PROBE_WINDOW_MS,
      hardTimeoutMs: STEP_HARD_MS,
      onSend: function() {
        self._ownSend = true;
      },
      onFlushed: function() {
        self._disarm('flushed');
      },
      expect: function(snapshot, facts) {
        const next = boardNoteDecision(facts);
        if (next.action === 'landed') return { landed: true };
        // 送鍵之前排進來的舊動畫幀還會 settle：不算回應，等 fullRepaint 的整幀。
        if (next.action === 'skip' && next.shape !== 'movie') return { again: next };
        return false;
      },
      onDone: function(result) {
        if (!self.busy) return;
        if (result.again) {
          self.busy = false;
          self._enqueueSkip(result.again);
          return;
        }
        self._disarm('landed');
      },
      onFail: function(reason) {
        // 停在原生畫面，使用者自己按一鍵即可；不重試（盲送可能落進文章列表）。
        self._log('fail', { reason: reason });
        self._disarm('fail');
      }
    });
  },

  reset: function() {
    this.armed = false;
    this.busy = false;
    this._ownSend = false;
    this._rounds = 0;
  }
};
