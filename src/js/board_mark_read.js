// 看板列表：「<板名> 設為已讀」（桌機右鍵選單；手機長按選單）。
//
// pttbbs `mbbsd/board.c#board_cmd_mark_read`（看板列表的 `v`）：**對游標所在那一個看板**
// `brc_toggle_all_read(bid, 1)`，沒有 prompt，回來是整頁重畫（ctx->redraw）。
// 與文章列表的 `v`（getdata prompt、作用在目前看板）是兩個不同的指令，見
// docs/pttbbs-screen-protocol.md §11.5。`bid < 0`（我的最愛的目錄／分隔線）或沒權限時
// 什麼都不做 ⇒ 那些列本地就不給。
//
// 因為作用對象＝游標那一列，送 `v` 之前**一定**要先把真游標搬到右鍵那一列：
//   - 平滑捲動接管中（BoardListSession）：交給 session（選取移過去 → 跳號同步 → `v`，
//     與鍵盤按 `v` 同一條凍結交易，board_list_session.markBoardRead）。
//   - 原生：`<編號>⏎`（board.c 的跳號，search_num）→ 落地確認游標停在**同一個板名**
//     那一列 → 才送 `v`。認不出（編號錯位、清單換了）就停手，絕不對錯的看板送 `v`。

import {
  classifyBoardListScreen,
  parseBoardListName,
  boardMarkReadTargetOfText,
  BRD_HEADER_ROWS
} from './board_list_parse';
import { submitSerializedSteps, submitBlockedHint } from './article_search';
import { serializedOpHint } from './serialized_op_gate';
import { HINT_ERROR } from './status_hint';
import { MARK_ALL_READ_FLAG } from './mark_all_read';

// 原生畫面上某一列（buf row）的目標。newflag（編號欄印的是文章總數）時跳號會失真 ⇒ 不給。
export function boardMarkReadTargetFromFacts(facts, row) {
  const brd = classifyBoardListScreen(facts);
  if (!brd || brd.newflag) return null;
  const rows = facts.rows || (facts.rowTexts || []).length;
  if (row == null || row < BRD_HEADER_ROWS || row > rows - 2) return null;
  return boardMarkReadTargetOfText((facts.rowTexts || [])[row] || '');
}

// 跳號落地：看板列表、游標停在 num 那一列，而且那一列的板名沒變。
export function boardJumpLanded(facts, target) {
  const brd = classifyBoardListScreen(facts);
  if (!brd || !brd.parked || brd.cursorNum !== target.num) return false;
  return parseBoardListName((facts.rowTexts || [])[facts.curY] || '') === target.name;
}

function bufFacts(core) {
  const buf = core.buf;
  const rowTexts = [];
  for (let r = 0; r < buf.rows; ++r) rowTexts.push(buf.getRowText(r, 0, buf.cols));
  return { rowTexts: rowTexts, rows: buf.rows, curX: buf.cur_x, curY: buf.cur_y };
}

export function BoardMarkRead(core) {
  this._core = core;
}

BoardMarkRead.prototype = {
  _hint: function(msg, ms, level) {
    const view = this._core.view;
    if (view && view.flashListHint) view.flashListHint(msg, ms || 3000, level);
  },

  // 右鍵／長按那一列（render row）的目標 { num, name }；null ＝選單項不出現。零副作用。
  targetAtRow: function(row) {
    const core = this._core;
    if (!core.conn || !core.conn.isConnected) return null;
    const owner = typeof core.activeListSession === 'function' ? core.activeListSession() : null;
    if (owner) {
      if (owner !== core.boardListSession || !owner.markBoardReadTargetAtRow) return null;
      return owner.markBoardReadTargetAtRow(row);
    }
    if (!core.buf) return null;
    return boardMarkReadTargetFromFacts(bufFacts(core), row);
  },

  start: function(target) {
    const core = this._core;
    if (!target || target.num == null) return false;
    const busy = serializedOpHint(core);
    if (busy) {
      this._hint(busy);
      return false;
    }
    const self = this;
    const doneMsg = '已將 ' + target.name + ' 板設為已讀';
    const owner = typeof core.activeListSession === 'function' ? core.activeListSession() : null;
    if (owner) {
      if (owner !== core.boardListSession || !owner.markBoardRead) return false;
      return owner.markBoardRead(target.num, {
        onDone: function() {
          self._hint(doneMsg);
        }
      });
    }
    const steps = [
      {
        keys: String(target.num) + '\r',
        kind: 'board-mark-read-jump',
        fullRepaint: true,
        expect: function(snap, facts) {
          return boardJumpLanded(facts, target);
        },
        onFail: function() {
          self._hint('游標沒有停在 ' + target.name + ' 那一列，沒有設定已讀', 0, HINT_ERROR);
        }
      },
      {
        keys: 'v',
        kind: 'board-mark-read',
        fullRepaint: true,
        // 整頁重畫後游標仍停在看板列表某一列＝落地。
        expect: function(snap, facts) {
          const brd = classifyBoardListScreen(facts);
          return !!brd && brd.parked;
        },
        onDone: function() {
          self._hint(doneMsg);
        },
        onFail: function() {
          self._hint('設為已讀：PTT 沒有回應', 0, HINT_ERROR);
        }
      }
    ];
    if (!submitSerializedSteps(core, steps, { kind: 'board-mark-read', flag: MARK_ALL_READ_FLAG })) {
      this._hint(submitBlockedHint(core, '指令處理中，請稍候再試'));
      return false;
    }
    return true;
  }
};

export default BoardMarkRead;
