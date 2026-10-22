// 首頁儀表板（pref enableHomeDashboard，預設開）：主功能表上蓋一層面板，列出我的最愛
// （有新文章的標亮）、最近去過的看板、新信提示。設計與 pttbbs 讀碼依據見
// docs/home-dashboard.md —— 改這支之前先讀它。
//
// 三條規則：
//   1. **不是 modal**：鍵盤照常進 #t 送給 PTT。使用者在面板開著時打任何字 ⇒ 面板收起、
//      那個鍵照原生走（主功能表的快捷鍵、↑↓ 都還在）。
//   2. **認不出 ⇒ 原生**：只在「標題列是主功能表＋畫面上有 (F)avorite 選單項＋游標不在
//      輸入欄」時出現；抓我的最愛的任何一步落地不符就停手，人留在 PTT 給的畫面上。
//   3. **每個動作都是原生鍵**：抓最愛＝Ctrl+Z f（menu.c#ZA_Select 的「我的最愛」）→ 讀頁
//      →（跳號翻頁）→ 跳回原游標 → q；開看板＝搜尋彈窗同一條 s<板>⏎（submitSearch）；
//      開信箱＝Ctrl+Z m。抓最愛只在面板打開、快取過期時做一次；手動更新（按鈕、F5、
//      手機工具列、下拉）一律經 screen_refresh。
//
// 進看板之後的「有新文章」不重抓：文章列表看得到最新一篇的已讀標記就照它改
// （newestArticleUnread），使用者自己開原生我的最愛時照抄那一頁的 ˇ —— 一個 byte 都不送。
// 面板的捲動位置是閱讀紀錄的 home 紀錄（readingPosition／requestViewportRestore）。

import { rowHasTitle, MAIN_MENU, BOARD_LIST, parseBoardName, isArticleListTitleRow } from './screen_titles';
import { isArticleListFooter, isSubListFooter } from './screen_captions';
import { parseListEntry } from './agent_parse';
import { listRowMark } from './unread_jump';
import { parseMenuItemRow } from './menu_items';
import {
  BRD_HEADER_ROWS,
  classifyBoardListScreen,
  isBoardListBlockedRow,
  isBoardListFolderRow,
  isBoardListSeparatorRow,
  parseBoardListName,
  parseBoardListNum
} from './board_list_parse';
import { charCells } from './string_util';
import { submitSerializedSteps, beginInFlight, endInFlight, searchGateFacts, submitSearch } from './article_search';
import { serializedOpHint } from './serialized_op_gate';
import { isRefreshKeyEvent } from './screen_refresh';
import { readEffectivePrefs } from './pref_storage';
import { recordFor } from './reading_record';
import { HINT_ERROR } from './status_hint';

export const HOME_FAV_FETCH_FLAG = 'homeFavFetchInFlight';
export const HOME_FAV_CACHE_KEY = 'pttchrome.homeFavorites.v1';
export const HOME_RECENT_KEY = 'pttchrome.homeRecentBoards.v1';
// 快取多久算新鮮（面板打開時超過就自動重抓一次）。
export const FAV_TTL_MS = 5 * 60 * 1000;
// 最多讀幾頁（一頁 20 個）：抓太多頁＝面板開著要等很久，我的最愛通常一兩頁。
export const FAV_MAX_PAGES = 5;
export const RECENT_LIMIT = 8;
// 主功能表落地後等多久才自動抓：登入後的 deep link／斷線回到原處會在同一個 settle
// 出發，讓它們先走；使用者一進主功能表就按鍵的話，計時到了也不會抓（面板已收起）。
export const AUTO_FETCH_DELAY_MS = 600;

const ZA_FAVORITE = '\x1af';
const ZA_MAIL = '\x1am';
const STEP_TIMEOUT_MS = 3000;
// 整段的上限：每步最多 hardTimeout 10s，FAV_MAX_PAGES 頁＋開、回游標、離開。
const FETCH_WATCHDOG_MS = 60000;
// 中文敘述欄寬（board.c brdlist_coldefs 的「中   文   敘   述」34 欄）。
const DESC_CELLS = 34;
const BOARD_SYMBOLS = '◎Σ☆';

// ---------------------------------------------------------------------------
// 純判讀（tests/unit/home_dashboard.test.js）
// ---------------------------------------------------------------------------

// 這一幀是不是可以蓋面板的主功能表。facts ＝ searchGateFacts 同形。
// 要有 (F)avorite：面板的主體就是我的最愛，主功能表沒有這一項（權限、改版）就不接管。
export function isHomeScreen(facts) {
  if (!facts || facts.inputField) return false;
  const rowTexts = facts.rowTexts || [];
  if (!rowHasTitle(rowTexts[0] || '', MAIN_MENU)) return false;
  for (let r = 1; r < rowTexts.length - 1; ++r) {
    const item = parseMenuItemRow(rowTexts[r]);
    if (item && item.key === 'F') return true;
  }
  return false;
}

// menu.c#redraw_title：ISNEWMAIL 時標題列中段換成「你有新信件」。
export function hasNewMail(row0Text) {
  return (row0Text || '').indexOf('你有新信件') >= 0;
}

// 我的最愛的一列 → { num, name, desc, unread } 或 null（分隔線／目錄／禁入／空白列）。
// 版型（board.c#brdlist_renderer）：`%6d%c%s`（編號、隱板標記、未讀「ˇ」或兩格空白）
// → 板名 → 類別 → ◎/Σ/☆ → 中文敘述（34 欄）→ 人氣 → 板主。舊版是 `%7d`，欄位順序相同。
// 未讀看「編號與板名之間有沒有ˇ」，不靠欄位位置（rowToText 把全形收成一個字）。
export function parseFavRow(text) {
  if (!text) return null;
  const num = parseBoardListNum(text);
  if (num == null) return null;
  if (isBoardListSeparatorRow(text) || isBoardListFolderRow(text) || isBoardListBlockedRow(text))
    return null;
  const name = parseBoardListName(text);
  if (!name) return null;
  const at = text.indexOf(name);
  const head = text.slice(0, at);
  const unread = head.indexOf('ˇ') >= 0;
  return { num: num, name: name, desc: parseFavDesc(text.slice(at + name.length)), unread: unread };
}

// 板名之後：類別 → 符號 → 敘述。找不到符號就不猜（回 ''）。
function parseFavDesc(rest) {
  const m = /^\s+\S+\s+(.)/.exec(rest || '');
  if (!m || BOARD_SYMBOLS.indexOf(m[1]) < 0) return '';
  let out = '';
  let cells = 0;
  for (const ch of rest.slice(m[0].length)) {
    const w = charCells(ch);
    if (cells + w > DESC_CELLS) break;
    out += ch;
    cells += w;
  }
  return out.trim();
}

// 一幀我的最愛 → { entries, topNum, lastNum, cursorNum, full, newflag } 或 null。
// 只認 variant 'fav'（board_list_parse 的指紋）；按 y 列出全部看板時是 'all'，不收。
export function favPage(facts) {
  const brd = classifyBoardListScreen(facts);
  if (!brd || brd.variant !== 'fav') return null;
  const rowTexts = facts.rowTexts || [];
  const rows = facts.rows || rowTexts.length;
  const entries = [];
  let lastNum = null;
  let numbered = 0;
  for (let r = BRD_HEADER_ROWS; r <= rows - 2; ++r) {
    if (brd.nums[r] == null) continue;
    numbered++;
    lastNum = brd.nums[r];
    const e = parseFavRow(rowTexts[r]);
    if (e) entries.push(e);
  }
  return {
    entries: entries,
    topNum: brd.topNum,
    lastNum: lastNum,
    cursorNum: brd.cursorNum,
    newflag: brd.newflag,
    // 一頁滿了（body 每一列都有編號）才可能還有下一頁。
    full: numbered >= rows - 1 - BRD_HEADER_ROWS
  };
}

// 各頁依編號合併、去重（同一號以後到的為準）。
export function mergeFavEntries(pages) {
  const byNum = new Map();
  (pages || []).forEach(function(p) {
    (p || []).forEach(function(e) {
      byNum.set(e.num, e);
    });
  });
  return Array.from(byNum.values())
    .sort(function(a, b) {
      return a.num - b.num;
    })
    .map(function(e) {
      return { name: e.name, desc: e.desc, unread: e.unread };
    });
}

// 快取新不新鮮：沒抓過、或超過 TTL ⇒ 該抓。剛失敗過的 TTL 內不重試（失敗＝這個帳號／
// 版本認不出來，一直重試只是一直送鍵）。
export function shouldFetchFavorites(state, now) {
  const s = state || {};
  if (s.fetching) return false;
  if (s.failedAt != null && now - s.failedAt < FAV_TTL_MS) return false;
  return s.fetchedAt == null || now - s.fetchedAt >= FAV_TTL_MS;
}

// 最近看板：新的放最前、不分大小寫去重、最多 RECENT_LIMIT 個。
export function pushRecentBoard(list, name) {
  if (!name) return list || [];
  const key = name.toLowerCase();
  const rest = (list || []).filter(function(n) {
    return String(n).toLowerCase() !== key;
  });
  return [name].concat(rest).slice(0, RECENT_LIMIT);
}

// 這一幀是哪個看板的文章列表（記最近看板用）。看板列表的標題列也有《板名》（目前看板），
// 所以要連底列一起認。
export function articleListBoard(rowTexts, rows) {
  const t = rowTexts || [];
  const n = rows || t.length;
  const row0 = t[0] || '';
  if (!isArticleListTitleRow(row0) || !isArticleListFooter(t[n - 1] || '')) return null;
  return parseBoardName(row0);
}

// 看板的「有新文章」（board.c#check_newpost）＝ brc_unread_time(lastposttime) ——
// lastposttime 是 .DIR 最後一筆（最新一篇、不含置底）的建立時間（cache.c#setbtotal）。
// 所以「這個板還有沒有新文章」只看最新那一篇，與讀過其他哪幾篇無關。
//
// 這一幀文章列表 → true（最新一篇未讀）| false（已讀）| null（這幀看不出來）。
// 認得出「最新一篇」的前提：它下面接著置底文（★）或空白列（板尾那頁）；最新一篇剛好
// 在條目區最後一列時分不出後面還有沒有 ⇒ null。搜尋結果／文摘（獨立編號空間）⇒ null。
// 已讀標記（bbs.c#readdoent cell 8）：'+'、'M' ＝ brc_unread == 1（未讀）；' '、'm'、'~'、
// '='、's'、'*' ＝ 0 或 2（check_newpost 傳 modified 0，有新推文不算）⇒ 已讀；'S'、'#'
// 分不出 1 或 2、'!'、'D' 蓋掉了未讀資訊、刪除文 ⇒ null。
const BOARD_UNREAD_MARKS = '+M';
const BOARD_READ_MARKS = ' m~=s*';
export function newestArticleUnread(rowTexts, rows) {
  const t = rowTexts || [];
  const n = rows || t.length;
  if (isSubListFooter(t[n - 1] || '')) return null;
  let tail = false;
  for (let r = n - 2; r >= 3; --r) {
    const text = t[r] || '';
    if (!text.trim()) {
      tail = true;
      continue;
    }
    const e = parseListEntry(text);
    if (!e) return null;
    if (e.pinned) {
      tail = true;
      continue;
    }
    if (e.num == null || !tail || e.deleted) return null;
    const mark = listRowMark(text);
    if (mark == null) return null;
    if (BOARD_UNREAD_MARKS.indexOf(mark) >= 0) return true;
    if (BOARD_READ_MARKS.indexOf(mark) >= 0) return false;
    return null;
  }
  return null;
}

// 我的最愛清單裡某個板的未讀改成 unread（不分大小寫）。沒有這個板、或本來就一樣 ⇒
// 回原陣列（呼叫端用 === 判斷有沒有變）。
export function withBoardUnread(boards, name, unread) {
  if (!Array.isArray(boards) || !name) return boards;
  const key = String(name).toLowerCase();
  let changed = false;
  const next = boards.map(function(b) {
    if (String(b.name).toLowerCase() !== key || !!b.unread === !!unread) return b;
    changed = true;
    return Object.assign({}, b, { unread: !!unread });
  });
  return changed ? next : boards;
}

// 使用者自己開著原生的我的最愛：那一頁的 ˇ 就是 PTT 剛算的（check_newpost 在載入清單、
// 從看板退回時都會重算）⇒ 照抄進快取。只改清單裡已有的板，不增不減（只看到一頁）。
export function withFavPageUnread(boards, entries) {
  let out = boards;
  (entries || []).forEach(function(e) {
    out = withBoardUnread(out, e.name, e.unread);
  });
  return out;
}

// ---------------------------------------------------------------------------
// 閱讀紀錄：面板的捲動位置（reading_record 的 home 紀錄，docs/reading-record.md）
// ---------------------------------------------------------------------------
//
// 首頁紀錄：{ kind:'home', key, offset, scrollTop }。key ＝ 視窗頂端那張卡片
// （'board:<板>'／'recent:<板>'），offset ＝ 它的上緣離面板上緣幾 px。只存身分＋列錨：
// 清單更新後順序、張數會變，視窗寬度不同時一列放幾張也不同，像素對不上。
const ANCHOR_SELECTOR = '[data-home-board], [data-home-recent]';

function anchorKeyOf(el) {
  const b = el.getAttribute('data-home-board');
  if (b != null) return 'board:' + b;
  return 'recent:' + el.getAttribute('data-home-recent');
}

function anchorSelector(key) {
  const i = key.indexOf(':');
  const attr = key.slice(0, i) === 'board' ? 'data-home-board' : 'data-home-recent';
  const v = key.slice(i + 1);
  const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, '\\$&');
  return '[' + attr + '="' + esc + '"]';
}

export function homeAnchorOf(container) {
  if (!container || !container.getBoundingClientRect) return null;
  const top = container.getBoundingClientRect().top;
  const record = { kind: 'home', key: null, offset: 0, scrollTop: container.scrollTop };
  if (!container.scrollTop) return record;
  const items = container.querySelectorAll(ANCHOR_SELECTOR);
  for (let i = 0; i < items.length; ++i) {
    const r = items[i].getBoundingClientRect();
    if (r.bottom > top + 1) {
      record.key = anchorKeyOf(items[i]);
      record.offset = r.top - top;
      return record;
    }
  }
  return record;
}

// 認不出（那張卡片不在了）⇒ 不動，回 false。key 為 null ＝ 量的時候還在卡片之上
// （標題列附近）⇒ 回原 scrollTop。
export function applyHomeAnchor(container, record) {
  if (!container || !record) return false;
  if (record.key == null) {
    container.scrollTop = record.scrollTop || 0;
    return true;
  }
  const el = container.querySelector(anchorSelector(record.key));
  if (!el) return false;
  const delta =
    el.getBoundingClientRect().top - container.getBoundingClientRect().top - (record.offset || 0);
  container.scrollTop += delta;
  return true;
}

// 使用者按的這個鍵要不要收起面板。純修飾鍵、F 鍵（我們自己的快捷鍵，送不到 PTT）不算；
// 重新整理鍵（⌘R）也不算——它要由 screen_refresh 認成首頁（重抓我的最愛），面板先收起
// 的話就認不出來、交還瀏覽器整頁重載（＝斷線）。
export function keyDismissesHome(e) {
  if (!e || !e.key) return false;
  if (isRefreshKeyEvent(e)) return false;
  if (/^(Shift|Control|Alt|Meta|CapsLock|Dead|Process|Unidentified)$/.test(e.key)) return false;
  if (/^F\d{1,2}$/.test(e.key)) return false;
  return true;
}

function readJson(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // 無痕視窗／被擋：這一頁的記憶體裡還有，下次開站重抓。
  }
}

function enabled() {
  return !!readEffectivePrefs().enableHomeDashboard;
}

// ---------------------------------------------------------------------------
// 控制器
// ---------------------------------------------------------------------------

export function HomeDashboard(core) {
  this._core = core;
  this._listeners = new Set();
  this._atHome = false;
  this._dismissed = false;
  this._autoTimer = null;
  // 閱讀紀錄交回的待還原錨（面板下一次畫出來時套用，見 applyPendingViewport）。
  this._pendingViewport = null;
  const fav = readJson(HOME_FAV_CACHE_KEY);
  const recent = readJson(HOME_RECENT_KEY);
  this._state = {
    visible: false,
    fetching: false,
    boards: fav && Array.isArray(fav.boards) ? fav.boards : null,
    fetchedAt: null,
    // 上次成功抓到的時間（顯示「幾分鐘前更新」用；跨重整保留，但不算新鮮——
    // 已讀標記只對當下這次登入有意義，所以 fetchedAt 只記這一頁）。
    savedAt: fav && fav.at ? fav.at : null,
    failedAt: null,
    recents: Array.isArray(recent) ? recent : [],
    newMail: false
  };
  const self = this;
  if (core.buf && core.buf.addEventListener)
    core.buf.addEventListener('screenSettled', function() {
      self._onSettled();
    });
  const input = core.inputArea;
  if (input && input.addEventListener) {
    // capture：在 term_view 的處理之前看到，但**不吞**——鍵照常送給 PTT。
    input.addEventListener('keydown', function(e) {
      if (keyDismissesHome(e)) self.dismiss();
    }, true);
    input.addEventListener('input', function() {
      self.dismiss();
    }, true);
  }
}

HomeDashboard.prototype = {
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
    const keys = Object.keys(patch);
    if (keys.every((k) => next[k] === this._state[k])) return;
    this._state = next;
    this._listeners.forEach(function(fn) {
      fn(next);
    });
  },

  _hint: function(msg, ms, level) {
    const view = this._core.view;
    if (view && view.flashListHint) view.flashListHint(msg, ms || 3000, level);
  },

  _facts: function() {
    return searchGateFacts(this._core);
  },

  // 線路上有沒有別人的事（AID 跳文、搜尋、deep link／斷線回到原處還在排程…）。
  _wireBusy: function() {
    const core = this._core;
    if (serializedOpHint(core)) return true;
    if (core.commandQueue && !core.commandQueue.idle) return true;
    const dl = core.deepLinkController;
    if (dl && dl.hasPending && dl.hasPending()) return true;
    const rr = core.reconnectResume;
    if (rr && rr.hasPending && rr.hasPending()) return true;
    return false;
  },

  _onSettled: function() {
    const buf = this._core.buf;
    if (!buf || typeof buf.getRowText !== 'function') return;
    // 先只讀頭尾兩列：每次 settle 都會跑，不在主功能表時不必讀滿整頁。
    const rows = buf.rows;
    const row0 = buf.getRowText(0, 0, buf.cols);
    const ends = [];
    ends[0] = row0;
    ends[rows - 1] = buf.getRowText(rows - 1, 0, buf.cols);
    const board = articleListBoard(ends, rows);
    if (board) {
      this._noteRecent(board);
      this._noteBoardUnread(board);
    }
    // 抓最愛的途中畫面會離開主功能表：面板留著顯示「更新中」，判定交給那條序列。
    if (this._state.fetching) return;
    if (this._state.boards && rowHasTitle(row0, BOARD_LIST)) this._noteFavPage();
    const facts = enabled() && rowHasTitle(row0, MAIN_MENU) ? this._facts() : null;
    const home = !!facts && isHomeScreen(facts);
    if (!home) {
      this._atHome = false;
      this._dismissed = false;
      this._clearAutoTimer();
      this._set({ visible: false });
      return;
    }
    if (!this._atHome) {
      this._atHome = true;
      this._dismissed = false;
    }
    this._set({ visible: !this._dismissed, newMail: hasNewMail(facts.rowTexts[0]) });
    if (this._state.visible) this._scheduleAutoFetch();
  },

  // 指令面板的「最近去過／我的最愛」（command_palette.quickBoardItems）：只讀現成資料。
  quickBoards: function() {
    return {
      recent: this._state.recents.slice(),
      favorites: (this._state.boards || []).map(function(b) {
        return { name: b.name, desc: b.desc };
      })
    };
  },

  _noteRecent: function(name) {
    if (this._state.recents[0] === name) return;
    const next = pushRecentBoard(this._state.recents, name);
    writeJson(HOME_RECENT_KEY, next);
    this._set({ recents: next });
  },

  // 進了看板：看得到最新一篇的已讀標記就更新那個板的「有新文章」（newestArticleUnread）。
  // 只在它是我的最愛時才讀滿整頁——每次 settle 都會跑。
  _noteBoardUnread: function(name) {
    const boards = this._state.boards;
    if (!boards || !boards.length) return;
    const key = name.toLowerCase();
    if (!boards.some((b) => String(b.name).toLowerCase() === key)) return;
    const facts = this._facts();
    if (!facts) return;
    const unread = newestArticleUnread(facts.rowTexts, facts.rows);
    if (unread != null) this._setBoards(withBoardUnread(boards, name, unread));
  },

  // 使用者自己開著原生的我的最愛（不是我們在抓）：照抄這一頁的 ˇ。
  _noteFavPage: function() {
    const p = favPage(this._facts());
    if (p) this._setBoards(withFavPageUnread(this._state.boards, p.entries));
  },

  _setBoards: function(boards) {
    if (boards === this._state.boards) return;
    // 「幾點更新」仍是上次整份抓的時間：這裡只改了個別板的未讀。
    writeJson(HOME_FAV_CACHE_KEY, { at: this._state.savedAt, boards: boards });
    this._set({ boards: boards });
  },

  // ---- 閱讀紀錄（reading_record 的 home 紀錄）----

  // 面板畫著時，視窗頂端是哪張卡片；沒畫 ⇒ null（主功能表收起時不是首頁紀錄）。
  readingPosition: function() {
    if (!this._state.visible || typeof document === 'undefined') return null;
    return homeAnchorOf(document.getElementById(HOME_DASHBOARD_ID));
  },

  // 閱讀紀錄交回來的錨：面板下一次畫出來（或這次更新完重畫）時套用。
  requestViewportRestore: function(record) {
    this._pendingViewport = record ? Object.assign({}, record) : null;
    this._diag('saved', record);
  },

  // 外殼每次畫完呼叫（useLayoutEffect）：有待還原錨就套用，一次性。
  applyPendingViewport: function(container) {
    const r = this._pendingViewport;
    if (!r || !container || !this._state.visible || this._state.fetching) return false;
    this._pendingViewport = null;
    const ok = applyHomeAnchor(container, r);
    this._diag(ok ? 'applied' : 'dropped', { key: r.key });
    return ok;
  },

  _diag: function(event, info) {
    const rec = this._core.debugRecorder;
    if (rec && rec.log) rec.log('homeDashboard.viewportRestore', Object.assign({ event: event }, info));
  },

  _clearAutoTimer: function() {
    clearTimeout(this._autoTimer);
    this._autoTimer = null;
  },

  _scheduleAutoFetch: function() {
    if (this._autoTimer || !shouldFetchFavorites(this._state, Date.now())) return;
    const self = this;
    this._autoTimer = setTimeout(function() {
      self._autoTimer = null;
      if (!self._state.visible || self._wireBusy()) return;
      if (!isHomeScreen(self._facts())) return;
      if (shouldFetchFavorites(self._state, Date.now())) self.fetchFavorites();
    }, AUTO_FETCH_DELAY_MS);
  },

  // 使用者要原生主功能表（按鈕、或直接打字）。這一趟留在主功能表期間不再出現；
  // 離開再回來（或重新整理頁面）才會再出現。
  dismiss: function() {
    if (!this._state.visible || this._state.fetching) return;
    this._dismissed = true;
    this._pendingViewport = null;
    this._clearAutoTimer();
    this._set({ visible: false });
  },

  // 面板的「更新」鈕：與 F5／手機工具列／下拉同一個入口（screen_refresh 的 'home'
  // target：同一道冷卻、同一套忙碌提示），最後落到 fetchFavorites。
  refresh: function(source) {
    const sr = this._core.screenRefresh;
    if (sr && typeof sr.refresh === 'function') return sr.refresh(source || 'button');
    return this.fetchFavorites();
  },

  // 點卡片：與搜尋彈窗的「前往看板」同一條（s<板>⏎、閱讀紀錄 board-search）。
  openBoard: function(name) {
    const core = this._core;
    if (!name || this._state.fetching) return false;
    const sent = submitSearch(core, 'board', name, {
      onFail: () => this._hint('開不了看板 ' + name + '（已停在原生畫面）', 0, HINT_ERROR)
    });
    if (!sent) this._hint(serializedOpHint(core) || '指令處理中，請稍候再試');
    return sent;
  },

  // 新信：Ctrl+Z m（ZA 的信箱，PERM_READMAIL）。落地＝離開主功能表。
  openMail: function() {
    const core = this._core;
    if (this._state.fetching) return false;
    let bm = recordFor(core).begin('home-mail');
    const finish = function(outcome) {
      if (bm) recordFor(core).end(bm, outcome);
      bm = null;
    };
    const steps = [
      {
        keys: ZA_MAIL,
        kind: 'home-mail',
        timeoutMs: STEP_TIMEOUT_MS,
        expect: function(snap, facts) {
          return !isHomeScreen(facts);
        },
        onDone: function() {
          finish('done');
        },
        onFail: () => {
          finish('fail');
          this._hint('開不了信箱（已停在原生畫面）', 0, HINT_ERROR);
        }
      }
    ];
    const sent = submitSerializedSteps(core, steps, { kind: 'home-mail' });
    if (!sent) {
      finish('cancel');
      this._hint(serializedOpHint(core) || '指令處理中，請稍候再試');
    }
    return sent;
  },

  // 抓我的最愛：Ctrl+Z f → （不在第 1 頁就跳 1）→ 一頁一頁跳號往下 → 跳回原游標 → q。
  // 序列邊走邊長（同 unread_jump）：每一頁讀完才決定下一步。
  fetchFavorites: function() {
    const core = this._core;
    if (this._state.fetching) return false;
    if (!isHomeScreen(this._facts())) return false;
    if (serializedOpHint(core)) return false;
    const self = this;
    const pages = [];
    let jumpedFirst = false;
    let lastTop = null;
    let origCursor = null;
    let landed = null;
    let bm = recordFor(core).begin('home-favorites');
    const steps = [];
    let watchdog = null;
    const finish = function(outcome) {
      clearTimeout(watchdog);
      endInFlight(core, HOME_FAV_FETCH_FLAG);
      if (bm) recordFor(core).end(bm, outcome);
      bm = null;
    };
    const fail = function() {
      if (!self._state.fetching) return;
      finish('fail');
      self._set({ fetching: false, failedAt: Date.now() });
      // 畫面停在哪就是哪（我的最愛、或回到主功能表）——下一次 settle 重新判定面板。
      self._onSettled();
      self._hint('更新我的最愛失敗（已停在原生畫面）', 0, HINT_ERROR);
    };
    const push = function(step) {
      step.fullRepaint = true;
      step.timeoutMs = STEP_TIMEOUT_MS;
      step.onFail = fail;
      step.onFlushed = fail;
      steps.push(step);
    };
    const favStep = function(keys, kind, accept) {
      push({
        keys: keys,
        kind: kind,
        expect: function(snap, facts) {
          const p = favPage(facts);
          if (!p || !accept(p)) return false;
          landed = p;
          return true;
        },
        onDone: onPage
      });
    };
    const leave = function() {
      beginInFlight(core, HOME_FAV_FETCH_FLAG);
      push({
        keys: 'q',
        kind: 'home-fav-leave',
        expect: function(snap, facts) {
          return isHomeScreen(facts);
        },
        onDone: function() {
          finish('done');
          const boards = mergeFavEntries(pages);
          const now = Date.now();
          writeJson(HOME_FAV_CACHE_KEY, { at: now, boards: boards });
          self._set({ fetching: false, boards: boards, fetchedAt: now, savedAt: now, failedAt: null });
          self._onSettled();
        }
      });
    };
    const restoreThenLeave = function(current) {
      if (origCursor == null || origCursor === current) return leave();
      beginInFlight(core, HOME_FAV_FETCH_FLAG);
      push({
        keys: String(origCursor) + '\r',
        kind: 'home-fav-restore',
        expect: function(snap, facts) {
          const p = favPage(facts);
          return !!p && p.cursorNum != null;
        },
        onDone: leave
      });
    };
    const onPage = function() {
      const p = landed;
      landed = null;
      if (origCursor == null) origCursor = p.cursorNum;
      // newflag（按 c 的新文章模式）印的是文章總數，不是編號：只收這一頁，不翻。
      if (p.newflag) {
        pages.push(p.entries);
        return leave();
      }
      // 進來停在上次的游標那頁 ⇒ 先跳回第 1 頁。
      if (!pages.length && p.topNum !== 1 && !jumpedFirst) {
        jumpedFirst = true;
        beginInFlight(core, HOME_FAV_FETCH_FLAG);
        favStep('1\r', 'home-fav-first', function(q) {
          return q.topNum === 1;
        });
        return;
      }
      // 跳超過最後一項會被夾回最後一項（stuff.c#search_num）⇒ 停在同一頁＝沒有下一頁。
      if (pages.length && p.topNum === lastTop) return restoreThenLeave(p.cursorNum);
      pages.push(p.entries);
      lastTop = p.topNum;
      if (p.full && p.lastNum != null && pages.length < FAV_MAX_PAGES) {
        beginInFlight(core, HOME_FAV_FETCH_FLAG);
        favStep(String(p.lastNum + 1) + '\r', 'home-fav-page', function(q) {
          return q.cursorNum != null;
        });
        return;
      }
      restoreThenLeave(p.cursorNum);
    };
    favStep(ZA_FAVORITE, 'home-fav-open', function() {
      return true;
    });
    if (!submitSerializedSteps(core, steps, { kind: 'home-favorites', flag: HOME_FAV_FETCH_FLAG })) {
      if (bm) recordFor(core).end(bm, 'cancel');
      bm = null;
      return false;
    }
    this._clearAutoTimer();
    this._set({ fetching: true });
    // 保底：第一步被 flush（斷線）時 submitSerializedSteps 換掉了它的 onFlushed，
    // 面板不能永遠停在「更新中」。
    watchdog = setTimeout(function() {
      fail();
      if (core.commandQueue && core.commandQueue.flushKind) core.commandQueue.flushKind('home-fav');
    }, FETCH_WATCHDOG_MS);
    return true;
  }
};

// 滑鼠入口（App 掛在 window 的 mouse_*）要放過面板：點面板不是點終端機。
export const HOME_DASHBOARD_ID = 'homeDashboard';
export function isHomeDashboardTarget(el) {
  return !!(el && el.closest && el.closest('#' + HOME_DASHBOARD_ID));
}

export default HomeDashboard;
