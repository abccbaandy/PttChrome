// `termBuf.listRenderMode`（'native' | 'buffer' | 'frozen'）的**所有權層**。
//
// 為什麼需要它：兩種列表好讀（文章列表 ListSession／看板列表 BoardListSession）
// 共用同一個旗標——那是刻意的，因為它已是全專案十幾個消費端的分岔點（滑鼠座標
// 換算、左鍵路徑、滾輪、游標高亮、term_buf.onMouse_move…），開第二個旗標＝每個
// 消費端寫兩次判斷，漏一個就是靜默畫錯（見 docs/handoff 的架構評估 §6.2）。
//
// 但兩個 session 都掛在 `screenSettled` 上，**同一個 settle 內兩邊都會跑**：
// 進板那一幀 ListSession 要 engage（buffer），BoardListSession 要收攤（native），
// 誰先跑就決定畫面 —— 那是靜默的競態。所以旗標多帶一個 `listRenderOwner`：
//   - 寫 buffer/frozen ＝宣告所有權（無條件搶下）
//   - 寫 native ＝**只釋放自己持有的**；別人已接手時是 no-op
//   - 讀 ＝別人持有時一律回 'native'（「我沒有在畫」）
// 於是兩邊的執行順序不再影響結果。
//
// `App.activeListSession()` 也讀這個欄位，是「現在誰在畫列表」的唯一真相源。
// 守護：tests/unit/list_render_owner.test.js。

export const OWNER_ARTICLE_LIST = 'article-list';
export const OWNER_BOARD_LIST = 'board-list';

// 把 session 的 `_renderMode` 定義成 termBuf.listRenderMode 的**具所有權**視窗。
// 形狀比照 easy_reading.js / list_session.js 既有的 bindProperty（讓
// term_view/redraw 讀得到 buf.listRenderMode 而不必 import session 實例）。
export function defineOwnedRenderMode(session, termBuf, owner) {
  Object.defineProperty(session, '_renderMode', {
    get: function() {
      return termBuf.listRenderOwner === owner ? termBuf.listRenderMode : 'native';
    },
    set: function(val) {
      if (val !== 'buffer' && val !== 'frozen') {
        // 釋放：別人已經接手時什麼都不做（否則就是把對方剛畫上的畫面關掉）。
        if (termBuf.listRenderOwner === owner) {
          termBuf.listRenderOwner = null;
          termBuf.listRenderMode = 'native';
        }
        return;
      }
      termBuf.listRenderOwner = owner;
      termBuf.listRenderMode = val;
    }
  });
}

// 這一幀的列表畫面是誰在畫（null ＝原生）。term_view.redraw 的分支與
// App.activeListSession 共用。
export function listRenderOwnerOf(termBuf) {
  if (!termBuf) return null;
  const mode = termBuf.listRenderMode;
  if (mode !== 'buffer' && mode !== 'frozen') return null;
  return termBuf.listRenderOwner || null;
}

// ---- CommandQueue 的所有權 --------------------------------------------------
// 同一條 CommandQueue 被四個擁有者共用（ListSession / BoardListSession /
// AidNavigation / LongPush），而 `queue.onSettle` 是由 session 的 settle handler
// 驅動的 —— 兩個列表 session 都掛在 screenSettled 上，若各自無條件 onSettle，就會
// 用**自己的 facts** 去判對方的 expect（看板列表的 facts 沒有 cursorRowNum/kind，
// 文章列表的 facts 沒有 brd）⇒ 靜默判錯。判準用命令的 kind 前綴，明確且零狀態。
export const BRD_CMD_PREFIX = 'brd-';

export function isBoardListCommandKind(kind) {
  return (kind || '').indexOf(BRD_CMD_PREFIX) === 0;
}
