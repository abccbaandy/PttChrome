// 設為全部已讀（桌機右鍵選單；手機工具列「更多」）。
//
// pttbbs `mbbsd/bbs.c#b_mark_read_unread`（列表的 `v`，docs/pttbbs-screen-protocol.md §11.5）：
//   `v` → getdata「設定所有文章 (U)未讀 (V)已讀 (W)前已讀後未讀 (Q)取消？[Q] 」→ `v⏎`
//   ⇒ `brc_toggle_all_read(currbid, 1)`，回 FULLUPDATE 重畫列表。
// `v` 是 needitem（要有游標所在那一篇）但 `v` 分支不看那一篇 ⇒ 游標停在哪都一樣。
//
// 承重點同「前已讀後未讀」：`v` 沒進 prompt 時，第二步的 `v⏎` 會落回列表按鍵（再開一次
// prompt 後 ⏎＝取消，算無害，但畫面不在列表時就不知道會落在哪）⇒ 兩步序列化，第一步的
// expect 必須在畫面上看到 prompt 才准送第二步。prompt 畫在 b_lines-1（row 22，不是底列）
// ⇒ 掃整個畫面。
//
// 送出路徑與「跳到第一篇未讀」相同（article_search.submitSerializedSteps）：列表好讀時走
// list_session 的 passthrough（完成後停在原生鏡像，靜置探針自動回好讀並 rebuild——已讀標記
// 全變，累積 buffer 本來就過時），原生時走 CommandQueue。

import { refreshTargetOf } from './screen_refresh';
import { submitSerializedSteps } from './article_search';
import { serializedOpHint } from './serialized_op_gate';
import { HINT_ERROR } from './status_hint';

export const MARK_ALL_READ_FLAG = 'markAllReadInFlight';
// getdata prompt 的兩段特徵字（同一列）：只認得到這列才算進了 prompt。
const PROMPT_HEAD = '設定所有文章';
const PROMPT_ALL_READ = '(V)已讀';

// 畫面上有沒有 `v` 的 getdata prompt（掃整個畫面：prompt 在 row 22）。
export function markReadPromptShown(rowTexts) {
  return (rowTexts || []).some(function(t) {
    return !!t && t.indexOf(PROMPT_HEAD) !== -1 && t.indexOf(PROMPT_ALL_READ) !== -1;
  });
}

export function MarkAllRead(core) {
  this._core = core;
}

MarkAllRead.prototype = {
  _hint: function(msg, ms, level) {
    const view = this._core.view;
    if (view && view.flashListHint) view.flashListHint(msg, ms || 3000, level);
  },

  // 這一幀能不能用：文章列表（與重新整理、跳到第一篇未讀同一個判準；搜尋結果／文摘
  // 不算——那是別的列表，`v` 的語意對不上使用者看到的那份）。
  available: function() {
    const core = this._core;
    if (!core.conn || !core.conn.isConnected) return false;
    const t = refreshTargetOf(core);
    return !!t && t.kind === 'article-list';
  },

  // 回 true ＝已送出（或已提示為何不送）。
  start: function() {
    const core = this._core;
    if (!this.available()) {
      this._hint('只有在文章列表才能設為全部已讀');
      return false;
    }
    const busy = serializedOpHint(core);
    if (busy) {
      this._hint(busy);
      return false;
    }
    const self = this;
    const fail = function() {
      self._hint('設為全部已讀失敗：沒有出現 PTT 的設定提示（已停在原生畫面）', 0, HINT_ERROR);
    };
    const steps = [
      {
        keys: 'v',
        kind: 'mark-all-read-prompt',
        fullRepaint: true,
        expect: function(snap, facts) {
          return markReadPromptShown(facts && facts.rowTexts);
        },
        onFail: fail
      },
      {
        // getdata 是整行輸入（vgets）⇒ 必須補 Enter，單送 `v` 不會動。
        keys: 'v\r',
        kind: 'mark-all-read-apply',
        fullRepaint: true,
        // 打字回顯的那一幀 prompt 還在 ⇒ 等到 prompt 消失（FULLUPDATE 的列表）才算落地。
        expect: function(snap, facts) {
          return !markReadPromptShown(facts && facts.rowTexts);
        },
        onDone: function() {
          self._hint('已將本板所有文章設為已讀', 3000);
        },
        onFail: function() {
          self._hint('設為全部已讀：PTT 沒有回應（已停在原生畫面）', 0, HINT_ERROR);
        }
      }
    ];
    if (!submitSerializedSteps(core, steps, { kind: 'mark-all-read', flag: MARK_ALL_READ_FLAG })) {
      this._hint('指令處理中，請稍候再試');
      return false;
    }
    return true;
  }
};

export default MarkAllRead;
