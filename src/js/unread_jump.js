// 跳到第一篇未讀（桌機快捷鍵 pref unreadJumpKey，預設 F7；手機工具列「更多」）。
// 設計與 pttbbs 讀碼依據見 docs/unread-jump.md。
//
// 流程（全程原生鍵，畫面照實反應）：End → 從最新往回讀這一頁的已讀標記 → 還沒到已讀區
// 就 PgUp 再讀一頁 …… 最多 MAX_PGUP 次；找到就送 `<編號>⏎` 把游標停在那一篇。
//
// 「第一篇未讀」要**從新往舊**判斷：最新的文章是未讀、往上連續出現 READ_RUN 篇非未讀
// （已讀 ' '、~ 有新推文…）＝已經走進已讀區，那段已讀區之下、最上面的那篇未讀就是答案。
// 只看單一篇已讀會被「中間挑著讀過幾篇」騙到。
//
// 已讀標記（pttbbs mbbsd/bbs.c#readdoent，cell 8）：`isunread ? '+' : ' '`，modified 是 '~'；
// M 標記的未讀是 'M'。這裡的「未讀」＝ '+' 與 'M'（兩者都是 brc_unread == 1）。
// 'D'（tag）、'!'（solved）蓋掉了未讀資訊 ⇒ 中性：不算未讀、也不算進已讀連續數。

import { isHiddenListText, listFilterOf } from './list_row_filter';
import { charCells } from './string_util';
import { refreshTargetOf } from './screen_refresh';
import { submitSerializedSteps, beginInFlight, endInFlight } from './article_search';
import { endLanded, numJumpLanded } from './aid_navigation';
import { serializedOpHint } from './serialized_op_gate';
import { HINT_ERROR } from './status_hint';
import { recordFor } from './reading_record';

export const UNREAD_JUMP_FLAG = 'unreadJumpInFlight';
// 往上連續幾篇非未讀＝走進已讀區。
export const READ_RUN = 5;
// 最多往上翻幾頁，找不到就放棄、停在原地。
export const MAX_PGUP = 20;

const KEY_END = '\x1b[4~';
const KEY_PGUP = '\x1b[5~';
const STEP_TIMEOUT_MS = 3000;

const UNREAD_MARKS = '+M';
const NEUTRAL_MARKS = 'D!';
const MARK_CELL = 8;

// 一列的已讀標記（cell 8）。全形字（舊游標 ●、★）佔兩格，按格數算。
export function listRowMark(text) {
  let cell = 0;
  for (const ch of text || '') {
    if (cell === MARK_CELL) return ch;
    cell += charCells(ch);
    if (cell > MARK_CELL) return null;
  }
  return null;
}

// 一頁畫面 → 有編號的文章 [{ num, mark }]，由新到舊。置底（★，無編號）不算；
// 列表好讀會藏起來的列（刪除文、鎖文、黑名單：list_row_filter#isHiddenListText）標記是
// 中性——不會跳到使用者在列表上看不到的那篇。nums ＝ list_session facts.nums（游標列的
// 編號已補回）；filter ＝ listFilterOf(view)。
export function pageUnreadEntries(rowTexts, nums, rows, filter) {
  const out = [];
  const last = (rows || rowTexts.length) - 2;
  const f = filter || {};
  for (let r = 3; r <= last; ++r) {
    const num = nums ? nums[r] : null;
    if (num == null) continue;
    const text = rowTexts[r] || '';
    const mark = isHiddenListText(text, f.blacklist, f.titleKeywords) ? null : listRowMark(text);
    out.push({ num: num, mark: mark });
  }
  out.sort(function(a, b) {
    return b.num - a.num;
  });
  return out;
}

export function initialScanState() {
  return { lastUnread: null, run: 0, lowest: Infinity, done: false };
}

// 吃一頁（由新到舊），回新的 state。done ＝已經走進已讀區；那時 lastUnread 就是答案
// （null ＝最新的幾篇都讀過了，沒有未讀）。progressed ＝這頁有沒有比上一頁更舊的文章
// （PgUp 到頂時 read_move_cursor 夾在第 1 篇，畫面不再往上 ⇒ false）。
export function scanUnreadPage(state, entries) {
  const s = Object.assign({}, state, { progressed: false });
  for (let i = 0; i < entries.length && !s.done; ++i) {
    const e = entries[i];
    if (e.num >= s.lowest) continue;
    s.lowest = e.num;
    s.progressed = true;
    if (e.mark == null || NEUTRAL_MARKS.indexOf(e.mark) >= 0) continue;
    if (UNREAD_MARKS.indexOf(e.mark) >= 0) {
      s.lastUnread = e.num;
      s.run = 0;
    } else if (++s.run >= READ_RUN) {
      s.done = true;
    }
  }
  return s;
}

// 這一頁讀完之後下一步做什麼：
//   { action: 'jump', num }  找到了（或翻到第 1 篇，最上面那篇未讀就是答案）
//   { action: 'none' }       最新的幾篇都讀過了
//   { action: 'pgup' }       還沒走進已讀區，再往上一頁
//   { action: 'give-up' }    翻了 MAX_PGUP 頁還找不到，停在原地
export function nextUnreadAction(state, pgups) {
  if (state.done || !state.progressed || state.lowest <= 1) {
    return state.lastUnread != null
      ? { action: 'jump', num: state.lastUnread }
      : { action: 'none' };
  }
  if (pgups >= MAX_PGUP) return { action: 'give-up' };
  return { action: 'pgup' };
}

// PgUp 落地：同板的列表、游標在條目區、這頁讀得到編號。
export function pageLanded(facts) {
  if (!facts || facts.boardName == null) return false;
  if (facts.curY < 3 || facts.curY > facts.rows - 2) return false;
  return (facts.nums || []).some(function(n) {
    return n != null;
  });
}

export function UnreadJump(core) {
  this._core = core;
}

UnreadJump.prototype = {
  _hint: function(msg, ms, level) {
    const view = this._core.view;
    if (view && view.flashListHint) view.flashListHint(msg, ms || 3000, level);
  },

  // 這一幀能不能用（文章列表，與重新整理同一個判準）。
  available: function() {
    const core = this._core;
    if (!core.conn || !core.conn.isConnected) return false;
    const t = refreshTargetOf(core);
    return !!t && t.kind === 'article-list';
  },

  // 一律回 true（呼叫端吞掉快捷鍵）：F 鍵本來就送不到 PTT，不能用時給提示而不是
  // 交給瀏覽器（F7 在 Chrome 是「鍵盤瀏覽模式」對話框）。
  start: function() {
    const core = this._core;
    if (!this.available()) {
      this._hint('只有在文章列表才能跳到第一篇未讀');
      return true;
    }
    const busy = serializedOpHint(core);
    if (busy) {
      this._hint(busy);
      return true;
    }
    const self = this;
    let state = initialScanState();
    let pgups = 0;
    // expect 拿得到 (snapshot, facts)、onDone 拿不到 ⇒ 由 expect 記下落地那一幀。
    let landed = null;
    // 序列是**邊走邊長**的：每讀完一頁才決定下一步（PgUp／跳號／收手）。兩條送出路徑
    // （列表好讀 passthrough、原生 CommandQueue）都在第 i 步 onDone 之後才讀
    // steps[i + 1]，所以在 onDone 裡 push 進去就會接著送。
    const steps = [];
    const end = function() {
      endInFlight(core, UNREAD_JUMP_FLAG);
    };
    // 閱讀紀錄（決策表 'unread-jump'）：目的就是移動，找不到也停在翻到的那頁。
    let bm = recordFor(core).begin('unread-jump');
    const finish = function(outcome) {
      end();
      if (bm) recordFor(core).end(bm, outcome);
      bm = null;
    };
    const push = function(step) {
      // 每一步都補 \f：PgUp 已經在第一頁、跳號目標就是游標所在列時 PTT 送零 byte，
      // 沒有 settle 就只能等逾時（list_session._enqueueCursorSyncJump 同一個理由）。
      step.fullRepaint = true;
      step.timeoutMs = STEP_TIMEOUT_MS;
      step.onFail = function() {
        finish('fail');
        self._hint('跳到第一篇未讀失敗（已停在原生畫面）', 0, HINT_ERROR);
      };
      step.onFlushed = end;
      steps.push(step);
    };
    const pageStep = function(keys, kind, landedFn) {
      push({
        keys: keys,
        kind: kind,
        expect: function(snap, facts) {
          if (!landedFn(facts)) return false;
          landed = facts;
          return true;
        },
        onDone: onPage
      });
    };
    const onPage = function() {
      const f = landed || {};
      state = scanUnreadPage(state, pageUnreadEntries(f.rowTexts || [], f.nums, f.rows, listFilterOf(core.view)));
      const next = nextUnreadAction(state, pgups);
      if (next.action === 'pgup') {
        pgups++;
        // 第一步的 onDone 被 submitSerializedSteps 包過、會先解除旗標 ⇒ 接續時重新掛上
        //（同步執行，中間沒有使用者按鍵插得進來）。
        beginInFlight(core, UNREAD_JUMP_FLAG);
        pageStep(KEY_PGUP, 'unread-pgup', pageLanded);
        return;
      }
      if (next.action === 'jump') {
        beginInFlight(core, UNREAD_JUMP_FLAG);
        push({
          keys: String(next.num) + '\r',
          kind: 'unread-jump',
          expect: function(snap, facts) {
            return numJumpLanded(facts, next.num);
          },
          onDone: function() {
            finish('done');
            self._hint('已跳到第一篇未讀', 1500);
          }
        });
        return;
      }
      finish('done');
      if (next.action === 'none') self._hint('最新的文章都讀過了，沒有未讀');
      else self._hint('往上翻了 ' + MAX_PGUP + ' 頁仍找不到第一篇未讀，停在這裡');
    };
    pageStep(KEY_END, 'unread-end', endLanded);
    if (!submitSerializedSteps(core, steps, { kind: 'unread-jump', flag: UNREAD_JUMP_FLAG }))
      this._hint('指令處理中，請稍候再試');
    return true;
  }
};

export default UnreadJump;
