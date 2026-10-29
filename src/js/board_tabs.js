// 看板分頁（設計見 docs/board-tabs.md）。
//
// 文章列表的上方一排最近去過的看板分頁（桌機疊在終端機第 1 列「[←]離開 [→]閱讀…」的
// 按鍵提示上；手機在 App Bar 右邊）。點一下切板，長按（桌機右鍵）關掉。常在 2～4 個板
// 之間來回的人，不用每次 s 板名⏎。
//   1. **切板＝原生 `s<板>⏎`**：與搜尋彈窗的「前往看板」、首頁儀表板的看板卡片同一條
//      （article_search.submitSearch，閱讀紀錄 board-search）。回到那個板「上次看到的位置」
//      是 PTT 自己記的：read.c#getkeep 依看板目錄記游標與頂列（整個登入 session），進板時
//      還原 ⇒ 列表好讀接著在那個游標上 engage。這裡不另記視野。
//   2. **認不出 ⇒ 不顯示**：只在「標題列有《板名》＋底列是文章列表 caption」的畫面出現，
//      而且至少要有兩個分頁（只有現在這個板就沒有東西可切）。搜尋結果／文摘照記但不顯示：
//      bbs.c#do_select 不清 MODE_SELECT／MODE_DIGEST ⇒ 子列表裡 s<板> 落地仍是子列表
//      （別板的搜尋結果／文摘，也不回 getkeep 記的位置）。看不出是不是子列表也不顯示。
//   3. 分頁清單只存本機（localStorage `pttchrome.boardTabs.v1`），不同步。順序照第一次去的
//      先後（像瀏覽器分頁，不跟著 MRU 跳動）；滿了丟掉最久沒去的那個（不丟現在這個）。
import { readEffectivePrefs } from './pref_storage';
import { parseBoardName } from './screen_titles';
import { isArticleListFooter } from './screen_captions';
import { submitSearch, submitBlockedHint } from './article_search';
import { searchListMode } from './search_status';
import { HINT_ERROR } from './status_hint';

export const BOARD_TABS_ID = 'boardTabs';
export const BOARD_TABS_KEY = 'pttchrome.boardTabs.v1';
export const BOARD_TABS_MAX = 6;

export function isBoardTabsTarget(el) {
  return !!(el && typeof el.closest === 'function' && el.closest('#' + BOARD_TABS_ID));
}

// 這一幀是哪個板的文章列表；不是（或看不出板名）⇒ null。
export function articleListBoardOf(rowTexts) {
  const t = rowTexts || [];
  if (!isArticleListFooter(t[t.length - 1] || '')) return null;
  return parseBoardName(t[0] || '');
}

// 記一次「到了 name 這個板」（純函式）。tabs：[{ name, at }]。已有就只更新時間（位置不動）；
// 沒有就接在最後；超過上限丟掉最久沒去的（不會是剛到的這個）。板名比對不分大小寫。
export function visitBoard(tabs, name, now) {
  const list = (tabs || []).slice();
  const lower = String(name).toLowerCase();
  const i = list.findIndex((t) => t.name.toLowerCase() === lower);
  if (i >= 0) {
    list[i] = { name: list[i].name, at: now };
    return list;
  }
  list.push({ name: String(name), at: now });
  while (list.length > BOARD_TABS_MAX) {
    let oldest = -1;
    for (let k = 0; k < list.length - 1; ++k) if (oldest < 0 || list[k].at < list[oldest].at) oldest = k;
    list.splice(oldest, 1);
  }
  return list;
}

export function closeBoardTab(tabs, name) {
  const lower = String(name).toLowerCase();
  return (tabs || []).filter((t) => t.name.toLowerCase() !== lower);
}

// 分頁列上要畫的板：現在這個板不列（上方標題列／手機 App Bar 本來就寫著板名，點它也只是切到
// 自己）。記錄照舊有它，離開之後就會出現。
export function tabsToShow(names, current) {
  const cur = String(current || '').toLowerCase();
  return (names || []).filter((n) => n.toLowerCase() !== cur);
}

function readTabs(storage) {
  try {
    const raw = storage && storage.getItem(BOARD_TABS_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? v.filter((t) => t && typeof t.name === 'string' && t.name) : [];
  } catch (e) {
    return [];
  }
}

function writeTabs(storage, tabs) {
  try {
    if (storage) storage.setItem(BOARD_TABS_KEY, JSON.stringify(tabs));
  } catch (e) {
    // 存不了（隱私模式、配額）：這一頁照常用，下次開站從空的開始。
  }
}

function defaultStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch (e) {
    return null;
  }
}

const HIDDEN_PATCH = { visible: false };

export function BoardTabs(core, opts) {
  this._core = core;
  this._storage = opts && 'storage' in opts ? opts.storage : defaultStorage();
  this._listeners = new Set();
  this._tabs = readTabs(this._storage);
  this._state = { visible: false, tabs: this._tabs.map((t) => t.name), current: null, left: 0, top: 0, width: 0, rowHeight: 0, mobile: false };
  const self = this;
  if (core.buf && core.buf.addEventListener)
    core.buf.addEventListener('screenSettled', function() {
      self.refresh();
    });
  if (typeof window !== 'undefined' && window.addEventListener)
    window.addEventListener('resize', function() {
      self.refresh();
    });
}

BoardTabs.prototype = {
  get state() {
    return this._state;
  },

  onChange: function(fn) {
    this._listeners.add(fn);
    fn(this._state);
    const set = this._listeners;
    return function() {
      set.delete(fn);
    };
  },

  _set: function(patch) {
    const next = Object.assign({}, this._state, patch);
    if (Object.keys(patch).every((k) => next[k] === this._state[k])) return;
    this._state = next;
    this._listeners.forEach(function(fn) {
      fn(next);
    });
  },

  _rowTexts: function() {
    const buf = this._core.buf;
    if (!buf || typeof buf.getRowText !== 'function') return null;
    const t = [];
    for (let r = 0; r < buf.rows; ++r) t.push(buf.getRowText(r, 0, buf.cols));
    return t;
  },

  _commit: function(tabs) {
    this._tabs = tabs;
    writeTabs(this._storage, tabs);
  },

  // 桌機：疊在終端機第 1 列（文章列表的按鍵提示列）上，與終端機同寬。
  _geometry: function() {
    const core = this._core;
    const view = core.view;
    const main = view && view.mainDisplay;
    if (!main || typeof main.getBoundingClientRect !== 'function') return null;
    const r = main.getBoundingClientRect();
    const rows = (core.buf && core.buf.rows) || 24;
    if (!r.width || !r.height) return null;
    const rowHeight = view.chh || r.height / rows;
    return { left: Math.round(r.left), top: Math.round(r.top + rowHeight), width: Math.round(r.width), rowHeight: Math.round(rowHeight) };
  },

  refresh: function() {
    const core = this._core;
    const rows = this._rowTexts();
    const board = rows ? articleListBoardOf(rows) : null;
    if (!readEffectivePrefs().enableBoardTabs || !board) {
      if (this._state.visible) this._set(HIDDEN_PATCH);
      return;
    }
    const tabs = visitBoard(this._tabs, board, Date.now());
    this._commit(tabs);
    const names = tabs.map((t) => t.name);
    const g = this._geometry();
    if (!g || names.length < 2 || searchListMode(rows) !== 'plain') {
      this._set({ visible: false, tabs: names, current: board });
      return;
    }
    // tabs 陣列每次都是新的 ⇒ 名單沒變就沿用舊的，不觸發重畫。
    const same = names.length === this._state.tabs.length && names.every((n, i) => n === this._state.tabs[i]);
    this._set({
      visible: true,
      tabs: same ? this._state.tabs : names,
      current: board,
      left: g.left,
      top: g.top,
      width: g.width,
      rowHeight: g.rowHeight,
      mobile: !!core.mobile,
    });
  },

  _hint: function(msg, ms, level) {
    const view = this._core.view;
    if (view && view.flashListHint) view.flashListHint(msg, ms || 2000, level);
  },

  // 點分頁：原生 s<板>⏎（submitSearch，同首頁儀表板的看板卡片）。現在這個板不送。
  open: function(name) {
    const core = this._core;
    if (!name || !this._state.visible) return false;
    if (this._state.current && name.toLowerCase() === this._state.current.toLowerCase()) return false;
    const sent = submitSearch(core, 'board', name, {
      onFail: () => this._hint('開不了看板 ' + name + '（已停在原生畫面）', 0, HINT_ERROR),
    });
    if (!sent) this._hint(submitBlockedHint(core));
    return sent;
  },

  // 長按／右鍵：關掉這個分頁。現在這個板不關（下一幀就會再記回來）。
  close: function(name) {
    if (!name || (this._state.current && name.toLowerCase() === this._state.current.toLowerCase())) return false;
    this._commit(closeBoardTab(this._tabs, name));
    const names = this._tabs.map((t) => t.name);
    this._set({ tabs: names, visible: this._state.visible && names.length >= 2 });
    return true;
  },
};

export default BoardTabs;
