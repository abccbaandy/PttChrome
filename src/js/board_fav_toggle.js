// 看板列表：「<板名> 加入／移出我的最愛」（桌機右鍵選單；手機長按選單）。P112。
//
// pttbbs `mbbsd/board.c#fav_cmd_toggle_or_del`（看板列表的 `m`，board_fav_cmds／myfav_cmds）：
// **對游標所在那一個看板**動作，回來 `ctx->reload`（整份清單重載、整頁重畫）。
//   - 不在我的最愛清單（IS_LISTING_FAV 為假：分類看板、全部看板、熱門）：在最愛裡就移出，
//     不在就加入，沒有 prompt。最愛滿了是 `vmsg("你的最愛太多了啦 真花心")`（按任意鍵）。
//   - 我的最愛清單：`vans("你確定刪除嗎? [N/y]")` ⇒ 那個提問**留給使用者回答**，我們不代打。
// 我們分不出那個板現在在不在最愛（列上沒有標記），所以字樣跟 PTT 底列一樣寫「加入／移出」。
//
// 作用對象＝游標那一列 ⇒ 守門與「設為已讀」（board_mark_read.js）同一套：
//   - 平滑捲動接管中：交給 BoardListSession.markBoardFav（選取移過去 → 跳號同步 → `m`）。
//   - 原生：`<編號>⏎` → 落地確認游標停在**同一個板名** → 才送 `m`。認不出就停手。
// 清單是哪一種認不出來（variant 'unknown'）⇒ 不給選單項：送了 `m` 會不會冒出刪除確認都說不準。
// 做完讓首頁儀表板的我的最愛快取過期（下次回首頁重抓）。

import { classifyBoardListScreen } from './board_list_parse';
import { boardMarkReadTargetFromFacts, boardJumpLanded, bufFacts } from './board_mark_read';
import { submitSerializedSteps, submitBlockedHint } from './article_search';
import { serializedOpHint } from './serialized_op_gate';
import { HINT_ERROR } from './status_hint';
import { readEffectivePrefs } from './pref_storage';

export const BOARD_FAV_FLAG = 'boardFavInFlight';
export const BOARD_FAV_HINT = '切換我的最愛中，請稍候…';
// board.c 的兩個字串（Big5 原文轉成 Unicode 後的子字串）。
export const FAV_DELETE_PROMPT = '你確定刪除嗎';
export const FAV_FULL_MSG = '你的最愛太多了啦';

const KNOWN_VARIANTS = ['fav', 'class', 'all'];

// 原生畫面上某一列的目標 { num, name, fav }；fav ＝這份清單是我的最愛（m 會問刪除確認）。
export function boardFavTargetFromFacts(facts, row) {
  const brd = classifyBoardListScreen(facts);
  if (!brd || KNOWN_VARIANTS.indexOf(brd.variant) === -1) return null;
  const t = boardMarkReadTargetFromFacts(facts, row);
  if (!t) return null;
  return { num: t.num, name: t.name, fav: brd.variant === 'fav' };
}

// 送出 `m` 之後的回應幀是哪一種：'list'（重畫回清單）／'confirm'（我的最愛的刪除確認）／
// 'full'（最愛滿了）／null（還沒回來或認不出）。
export function boardFavResponse(facts) {
  const rowTexts = (facts && facts.rowTexts) || [];
  const rows = (facts && facts.rows) || rowTexts.length;
  const foot = rowTexts[rows - 1] || '';
  if (foot.indexOf(FAV_DELETE_PROMPT) >= 0) return 'confirm';
  if (foot.indexOf(FAV_FULL_MSG) >= 0) return 'full';
  const brd = classifyBoardListScreen(facts);
  if (brd && brd.parked) return 'list';
  return null;
}

export function boardFavToggleEnabled() {
  return readEffectivePrefs().boardListFavToggle !== false;
}

export function BoardFavToggle(core) {
  this._core = core;
}

BoardFavToggle.prototype = {
  _hint: function(msg, ms, level) {
    const view = this._core.view;
    if (view && view.flashListHint) view.flashListHint(msg, ms || 3000, level);
  },

  _favChanged: function() {
    const dash = this._core.homeDashboard;
    if (dash && typeof dash.markFavoritesStale === 'function') dash.markFavoritesStale();
  },

  // 右鍵／長按那一列（render row）的目標；null ＝選單項不出現。零副作用。
  targetAtRow: function(row) {
    const core = this._core;
    if (!boardFavToggleEnabled()) return null;
    if (!core.conn || !core.conn.isConnected) return null;
    const owner = typeof core.activeListSession === 'function' ? core.activeListSession() : null;
    if (owner) {
      if (owner !== core.boardListSession || !owner.markBoardFavTargetAtRow) return null;
      const t = owner.markBoardFavTargetAtRow(row);
      return t ? { num: t.num, name: t.name, fav: owner._variant === 'fav' } : null;
    }
    if (!core.buf) return null;
    return boardFavTargetFromFacts(bufFacts(core), row);
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
    const doneMsg = '已把 ' + target.name + ' 加入或移出我的最愛';
    const owner = typeof core.activeListSession === 'function' ? core.activeListSession() : null;
    if (owner) {
      if (owner !== core.boardListSession || !owner.markBoardFav) return false;
      return owner.markBoardFav(target.num, {
        name: target.name,
        onDone: function() {
          self._favChanged();
          if (!target.fav) self._hint(doneMsg);
        }
      });
    }
    const steps = [
      {
        keys: String(target.num) + '\r',
        kind: 'board-fav-jump',
        fullRepaint: true,
        expect: function(snap, facts) {
          return boardJumpLanded(facts, target);
        },
        onFail: function() {
          self._hint('游標沒有停在 ' + target.name + ' 那一列，沒有加入／移出我的最愛', 0, HINT_ERROR);
        }
      },
      {
        keys: 'm',
        kind: 'board-fav-toggle',
        // 不尾附 \f：我的最愛那條會停在 vans 提問，\f 只會重畫，但沒必要多送。
        fullRepaint: false,
        expect: function(snap, facts) {
          return boardFavResponse(facts) !== null;
        },
        onDone: function() {
          const r = boardFavResponse(bufFacts(core));
          self._favChanged();
          if (r === 'full') self._hint('我的最愛滿了，沒有加入 ' + target.name, 0, HINT_ERROR);
          else if (r === 'confirm') self._hint('要把 ' + target.name + ' 移出我的最愛嗎？請在下方回答');
          else self._hint(doneMsg);
        },
        onFail: function() {
          self._hint('加入／移出我的最愛：PTT 沒有回應', 0, HINT_ERROR);
        }
      }
    ];
    if (!submitSerializedSteps(core, steps, { kind: 'board-fav-toggle', flag: BOARD_FAV_FLAG, hint: BOARD_FAV_HINT })) {
      this._hint(submitBlockedHint(core, '指令處理中，請稍候再試'));
      return false;
    }
    return true;
  }
};

export default BoardFavToggle;
