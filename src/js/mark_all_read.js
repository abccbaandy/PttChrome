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
// list_session 的凍結交易（resumeOnLanding：全程不切原生，v⏎ 落回列表那一幀直接 rebuild
// 回好讀——已讀標記全變，累積 buffer 本來就過時），原生時走 CommandQueue。

import { refreshTargetOf } from './screen_refresh';
import { submitSerializedSteps, submitBlockedHint } from './article_search';
import { serializedOpHint } from './serialized_op_gate';
import { HINT_ERROR } from './status_hint';
import { recordFor } from './reading_record';
import { markReadPromptShown } from './mark_read_prompt';

// prompt 指紋與列表好讀「前已讀後未讀」共用（mark_read_prompt.js）。
export { markReadPromptShown };

export const MARK_ALL_READ_FLAG = 'markAllReadInFlight';

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
    // 閱讀紀錄（決策表 'mark-all-read'）：只有已讀標記變了 ⇒ 不論成敗，回好讀時
    // 視野回到原處（列表好讀 rebuild 時驗證同板＋游標仍在原處）。
    const rr = recordFor(core);
    const bm = rr.begin('mark-all-read');
    const fail = function() {
      rr.end(bm, 'fail');
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
          rr.end(bm, 'done');
          self._hint('已將本板所有文章設為已讀', 3000);
        },
        onFail: function() {
          rr.end(bm, 'fail');
          self._hint('設為全部已讀：PTT 沒有回應（已停在原生畫面）', 0, HINT_ERROR);
        }
      }
    ];
    if (
      !submitSerializedSteps(core, steps, {
        kind: 'mark-all-read',
        flag: MARK_ALL_READ_FLAG,
        resumeOnLanding: true
      })
    ) {
      this._hint(submitBlockedHint(core, '指令處理中，請稍候再試'));
      return false;
    }
    return true;
  }
};

export default MarkAllRead;
