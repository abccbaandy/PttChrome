// 畫面「重新整理」：看板列表（看新文章旗標／人氣）、文章列表（看新文章）、文章（看新推文）。
// 設計與 pttbbs 讀碼依據見 docs/screen-refresh.md。
//
// **PTT 沒有原生的重新整理鍵**（讀碼 CONFIRMED）：
//   - Ctrl-L 只是 mbbsd/io.c#system_key_hook 的 redrawwin()——把 server 端的虛擬畫面
//     原封重送，不重讀任何資料。
//   - 文章列表（read.c／psb.c）只在 reload 旗標或「換頁（base 改變）」時跑 loader；
//     停在同一頁按什麼都看不到新文章。
//   - pmore 把文章整份讀進來就不再看檔案 ⇒ 新推文只能重開文章。
// 所以每種畫面挑一條**沒有副作用、游標原地不動**的原生路徑：
//   文章列表：s<本板>⏎ ⇒ bbs.c#do_select → NEWDIRECT ⇒ 索引重讀；read_exec_noitem
//             先存 crs_ln、getkeep 還原 ⇒ 游標原地；不經 Read() ⇒ 不出進板畫面。
//   看板列表：/⏎（空白／原關鍵字）⇒ board.c#board_cmd_search_keyword：brdnum=-1 ＋ reload
//             ⇒ 未讀旗標（check_newpost 只在載入時算）與人氣一起重算，ctx->curr 保留。
//             熱門看板不收 /（vmsg「熱門看板模式下不支援…」）⇒ 第二步的 ⏎ 正好關掉訊息，明講不支援。
//   文章：    aid_navigation.refresh()（取 AID → s<板>⏎ → #AID⏎ → ⏎，還原閱讀位置）。
//   首頁儀表板（主功能表上的面板畫著時）：重抓我的最愛（home_dashboard.fetchFavorites：
//             Ctrl+Z f → 讀頁 → q）。面板收起後的原生主功能表不接。
// 認不出畫面 ⇒ 不接管（F5 交還瀏覽器、工具列不顯示按鈕）。
//
// 頻率：pttbbs 開源碼查無「同文章讀取頻率」限制（讀碼見 docs），仍給一道可調的冷卻
// （pref refreshMinIntervalSec，預設 5 秒），連按只會得到提示，不會連發。

import { atPagerStatusRow } from './long_push_gate';
import { parsePagerFooterContext } from './string_util';
import { boardListContextKind, classifyBoardListScreen } from './board_list_parse';
import { OWNER_ARTICLE_LIST } from './list_render_owner';
import { parseBoardKey, boardNameFromKey } from './screen_titles';
import { footerCaption } from './screen_captions';
import {
  isSearchPromptFrame,
  searchGateFacts,
  submitSerializedSteps
} from './article_search';
import { landedOnBoard, SLOW_STEP_BUDGET } from './aid_navigation';
import { serializedOpHint } from './serialized_op_gate';
import { readValuesWithDefault } from './pref_storage';
import { HINT_ERROR } from './status_hint';
import { recordFor } from './reading_record';

export const DEFAULT_REFRESH_MIN_INTERVAL_SEC = 5;

// 文章列表裡 s 會「離開」的子模式：搜尋結果（MODE_SELECT）與文摘（MODE_DIGEST）。
// 新版 caption 分得出來（read.c#i_read_caption）；舊版一律「文章選讀」分不出來，
// 那種畫面重整會回到完整列表（docs 記為已知限制）。
const LEAVES_ON_S = ['系列文章', '文摘列表'];

export const BOARD_KEYWORD_PROMPT = '請輸入看板中文關鍵字';
const HOT_BOARD_REJECT = '熱門看板模式下不支援';

// 這一幀能重整成什麼。純函式（facts 同 article_search.searchGateFacts）。
//   opts.articleBoard：目前文章的看板（term_view._articleBoard）
//   opts.listOpened：列表好讀自己開的這篇（超長文 footer 被擠掉時的 READING 證據）
//   opts.home：首頁儀表板畫著（home_dashboard 的 state.visible；它自己認主功能表，
//             抓最愛途中畫面在我的最愛上也算——那時送出會被忙碌提示擋下）
// 回 { kind:'article'|'article-list'|'board-list'|'home', board? } 或 null。
export function refreshTargetFromFacts(facts, pageState, opts) {
  if (!facts) return null;
  const o = opts || {};
  if (o.home) return { kind: 'home' };
  const rowTexts = facts.rowTexts || [];
  const rows = facts.rows || rowTexts.length;
  const last = rowTexts[rows - 1] || '';
  if (pageState === 3 && atPagerStatusRow(last)) {
    let ctx = parsePagerFooterContext(last);
    if (ctx === 'unknown' && o.listOpened) ctx = 'reading';
    if (ctx !== 'reading' || !o.articleBoard) return null;
    return { kind: 'article', board: o.articleBoard };
  }
  if (facts.inputField) return null;
  if (
    facts.listOwner === OWNER_ARTICLE_LIST ||
    boardListContextKind(facts) === 'article-list'
  ) {
    if (LEAVES_ON_S.indexOf(footerCaption(last)) >= 0) return null;
    const board = boardNameFromKey(parseBoardKey(rowTexts[0] || ''));
    if (!board || !/^[\x21-\x7e]+$/.test(board)) return null;
    return { kind: 'article-list', board: board };
  }
  if (classifyBoardListScreen(facts)) return { kind: 'board-list' };
  return null;
}

// 瀏覽器的「重新整理」快捷鍵裡我們接手的那幾顆：F5、⌘R（mac）。
//   - Shift／Ctrl＋F5、⌘⇧R 是**強制重新載入**，刻意留給瀏覽器當逃生門。
//   - Ctrl+R 不在這裡：它一直是 PTT 的 ^R（回水球，term_keyboard 的 CtrlShiftMap），
//     本來就不會重新載入網頁。
// 只讀 e.key／修飾鍵（同 long_push_gate 的慣例）。
export function isRefreshKeyEvent(e) {
  if (!e) return false;
  if (e.key === 'F5') return !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
  return (
    !!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey &&
    (e.key === 'r' || e.key === 'R')
  );
}

// 還要等幾毫秒才可以再重整（0 ＝現在就可以）。minSec 非正數 ＝不限制。
export function refreshCooldownLeftMs(lastAt, now, minSec) {
  const sec = Number(minSec);
  if (!lastAt || !(sec > 0)) return 0;
  const left = lastAt + sec * 1000 - now;
  return left > 0 ? left : 0;
}

// 文章列表：s → 等 CompleteBoard prompt → 板名⏎ → 等落回同板的乾淨列表。
// 分兩步的理由同 article_search.buildSearchSteps：s 沒被接受時，板名的每個字母都會
// 落回列表變成指令。第二步是進板（enter_board 讀 .DIR），預算同 AID 跳文的進板那一步。
export function buildArticleListRefreshSteps(board, cb) {
  const c = cb || {};
  const boardLower = String(board).toLowerCase();
  return [
    {
      keys: 's',
      kind: 'refresh-open',
      expect: function(snapshot, facts) {
        return isSearchPromptFrame('board', facts || {});
      },
      onFail: c.onFail
    },
    {
      keys: board + '\r',
      kind: 'refresh-submit',
      ...SLOW_STEP_BUDGET,
      expect: function(snapshot, facts) {
        return landedOnBoard(facts, boardLower);
      },
      onDone: c.onDone,
      onFail: c.onFail
    }
  ];
}

export function isBoardKeywordPromptFrame(facts) {
  const rowTexts = (facts && facts.rowTexts) || [];
  const rows = (facts && facts.rows) || rowTexts.length;
  return (
    facts.curY === rows - 2 &&
    (rowTexts[rows - 2] || '').indexOf(BOARD_KEYWORD_PROMPT) === 0
  );
}

// 看板列表：/ → 等關鍵字 prompt（或熱門看板的拒絕訊息）→ ⏎。
// ⏎ 對兩種畫面都對：prompt 上是「用原關鍵字送出」＝ reload；拒絕訊息上是
// pressanykey 的那一鍵。cb.onDone(hot) 的 hot ＝熱門看板（沒有重整到）。
export function buildBoardListRefreshSteps(cb) {
  const c = cb || {};
  let hot = false;
  return [
    {
      keys: '/',
      kind: 'refresh-open',
      expect: function(snapshot, facts) {
        const f = facts || {};
        if (isBoardKeywordPromptFrame(f)) return true;
        const rowTexts = f.rowTexts || [];
        for (let r = 0; r < rowTexts.length; ++r) {
          if ((rowTexts[r] || '').indexOf(HOT_BOARD_REJECT) >= 0) {
            hot = true;
            return true;
          }
        }
        return false;
      },
      onFail: c.onFail
    },
    {
      keys: '\r',
      kind: 'refresh-submit',
      expect: function(snapshot, facts) {
        return !!classifyBoardListScreen(facts || {});
      },
      onDone: function() {
        if (c.onDone) c.onDone(hot);
      },
      onFail: c.onFail
    }
  ];
}

export function refreshTargetOf(core) {
  if (!core || !core.buf) return null;
  const view = core.view || {};
  const ls = core.listSession;
  return refreshTargetFromFacts(searchGateFacts(core), core.buf.pageState, {
    articleBoard: view._articleBoard,
    listOpened: !!(ls && ls.currentAnchor && ls.currentAnchor()),
    home: homeDashboardShown(core)
  });
}

export function homeDashboardShown(core) {
  const hd = core && core.homeDashboard;
  return !!(hd && hd.state && hd.state.visible);
}

export function ScreenRefresh(core) {
  this._core = core;
  this._lastAt = 0;
  // 冷卻開始時通知（手機工具列的反灰＋倒數；F5／下拉觸發的冷卻也要讓按鈕知道）。
  this._listeners = new Set();
  // 測試注入點。
  this._now = function() {
    return Date.now();
  };
}

ScreenRefresh.prototype = {
  _hint: function(msg, ms, level) {
    const view = this._core.view;
    if (view && view.flashListHint) view.flashListHint(msg, ms || 3000, level);
  },

  // 現在這個畫面能不能重整（F5 攔不攔、工具列顯不顯示按鈕）。
  target: function() {
    const core = this._core;
    if (!core.conn || !core.conn.isConnected) return null;
    return refreshTargetOf(core);
  },

  // 還要等幾毫秒才能再重整（0 ＝現在就可以）。與 refresh() 的冷卻判斷同一個式子。
  cooldownLeftMs: function() {
    return refreshCooldownLeftMs(
      this._lastAt,
      this._now(),
      readValuesWithDefault().refreshMinIntervalSec
    );
  },

  // fn(leftMs)：每次冷卻開始時呼叫一次（不是每秒；倒數由呼叫端自己用 cooldownLeftMs 走）。
  // 回傳解除訂閱函式。
  onCooldown: function(fn) {
    this._listeners.add(fn);
    const self = this;
    return function() {
      self._listeners.delete(fn);
    };
  },

  // 回 true ＝這次請求歸我們（呼叫端吞掉 F5）；false ＝這個畫面不支援，交還原生。
  // 冷卻中／線路忙碌也回 true：使用者是要重整這個畫面，不該變成整頁重新載入。
  refresh: function(source) {
    const core = this._core;
    const target = this.target();
    if (!target) {
      if (source !== 'key') this._hint('這個畫面不支援重新整理');
      return false;
    }
    const busy = serializedOpHint(core);
    if (busy) {
      this._hint(busy);
      return true;
    }
    const left = this.cooldownLeftMs();
    if (left > 0) {
      this._hint('請稍候 ' + Math.ceil(left / 1000) + ' 秒再重新整理');
      return true;
    }
    if (this._dispatch(target)) {
      this._lastAt = this._now();
      const next = this.cooldownLeftMs();
      this._listeners.forEach(function(fn) {
        fn(next);
      });
    }
    return true;
  },

  _dispatch: function(target) {
    const core = this._core;
    const self = this;
    if (target.kind === 'article') {
      if (core.aidNavigation && core.aidNavigation.refresh()) return true;
      this._hint('這篇文章無法重新整理');
      return false;
    }
    // 首頁儀表板：面板自己顯示「更新中」與結果（閱讀紀錄 'home-favorites' 在它裡面）。
    if (target.kind === 'home') {
      if (core.homeDashboard && core.homeDashboard.fetchFavorites()) return true;
      this._hint('指令處理中，請稍候再重新整理');
      return false;
    }
    // 閱讀紀錄（決策表 'list-refresh'／'board-list-refresh'）：游標本來就原地
    // （getkeep／ctx->curr），視野也要回到原處，而不是 PTT 的 20 列分頁。
    const rr = recordFor(core);
    const bm = rr.begin(target.kind === 'article-list' ? 'list-refresh' : 'board-list-refresh');
    const fail = function() {
      rr.end(bm, 'fail');
      self._hint('重新整理失敗（已停在原生畫面）', 0, HINT_ERROR);
    };
    const steps =
      target.kind === 'article-list'
        ? buildArticleListRefreshSteps(target.board, {
            onDone: function() {
              rr.end(bm, 'done');
              self._hint('已重新整理', 1200);
            },
            onFail: fail
          })
        : buildBoardListRefreshSteps({
            onDone: function(hot) {
              rr.end(bm, 'done');
              if (hot) self._hint('熱門看板不支援重新整理（PTT 限制）');
              else self._hint('已重新整理', 1200);
            },
            onFail: fail
          });
    // 列表好讀／看板列表接管中走凍結交易、落地即回（resumeOnLanding）：兩條的最後一步
    // 都從 prompt 送出（CompleteBoard／關鍵字 prompt），落點是重畫完的列表。少了它就是
    // 「切原生 → prompt 畫給使用者看 → 空等靜置探針 → 切回」，畫面翻面兩次。
    if (
      submitSerializedSteps(core, steps, {
        kind: 'refresh',
        flag: 'refreshInFlight',
        resumeOnLanding: true
      })
    )
      return true;
    this._hint('指令處理中，請稍候再重新整理');
    return false;
  }
};

export default ScreenRefresh;
