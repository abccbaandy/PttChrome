// 搜尋狀態列（設計見 docs/article-search.md「搜尋狀態列」）。
//
// 停在搜尋結果（read.c MODE_SELECT）時，終端機右上角浮一條「搜尋中：標題「Re」 ＋條件 ✕」。
// PTT 的搜尋結果跟完整列表幾乎長一樣（編號、推文計數都另算），常忘了自己在搜尋結果裡。
//   1. **一個 byte 都不自己送**：✕＝替使用者按 ←（read_cmd_quit 在列表上只離開子模式），
//      ＋條件＝替使用者按 `/`（攔截開著是搜尋彈窗，在搜尋結果裡送出就是 PTT 的「增加條件」）。
//      兩者都走鍵盤同一條分派（view.sendKeyAsUser）。
//   2. **認不出 ⇒ 不顯示**：只認底列 caption「系列文章」（新版 read.c#i_read_caption），
//      舊版 caption「文章選讀」分不出子模式，靠標題列右段「系列《板》」（只能證明「是」）。
//      文摘（MODE_DIGEST）不是搜尋，不顯示。
//   3. **關鍵字只在確定時顯示**：PTT 畫面上沒有搜尋條件，只有經搜尋彈窗送出的才知道。
//      看到完整列表就忘掉；有人在原生 prompt 下了條件（彈窗沒經手）⇒ 只顯示「搜尋結果」。
//      從搜尋結果 `s` 換板仍在搜尋模式、條件照舊（read_ctx 帶著走），所以不比對板名。
import { readEffectivePrefs } from './pref_storage';
import { footerCaption, isArticleListFooter } from './screen_captions';
import { parseBoardKey, boardNameFromKey } from './screen_titles';
import { isSearchPromptFrame, searchGateFacts } from './article_search';

export const SEARCH_STATUS_ID = 'searchStatus';
// 會記住的搜尋種類（看板搜尋 `s` 是換板，不是篩選）。
export const STATUS_KINDS = ['title', 'author', 'push'];

export function isSearchStatusTarget(el) {
  return !!(el && typeof el.closest === 'function' && el.closest('#' + SEARCH_STATUS_ID));
}

// 一幀文章列表的子模式：'select' 搜尋結果、'digest' 文摘、'plain' 完整列表；
// 不是文章列表（或判不出來）⇒ null。
export function searchListMode(rowTexts) {
  const t = rowTexts || [];
  const last = t[t.length - 1] || '';
  const row0 = t[0] || '';
  if (!isArticleListFooter(last) || parseBoardKey(row0) == null) return null;
  const cap = footerCaption(last);
  if (cap === '系列文章') return 'select';
  if (cap === '文摘列表') return 'digest';
  if (cap === '文章列表') return 'plain';
  // 舊格式「文章選讀」：標題列右段 title_tail_msgs（menu.c#showtitle）。右段可能被省略
  // （看板描述太長）⇒ 判不出來就是 null。
  if (/系列《[^》]*》\s*$/.test(row0)) return 'select';
  if (/文摘《[^》]*》\s*$/.test(row0)) return 'digest';
  if (/看板《[^》]*》\s*$/.test(row0)) return 'plain';
  return null;
}

// 記憶的下一個狀態（純函式）。memory：null | { known, conds: [{kind, text}], fresh }。
//   plain ⇒ 忘掉（離開了搜尋結果，或搜尋沒結果被 PTT 退回原列表）；
//   原生搜尋 prompt（不是彈窗送的）⇒ 條件不再完整，known=false。
// fresh：剛記下、還沒看過「不是完整列表」的一幀。PTT 收下搜尋（prompt 消失）的那一刻，
// 畫面可能還是搜尋前的完整列表（結果還沒畫完）——那一幀不算離開。沒結果時 PTT 先
// vmsg（不是列表）再退回原列表，所以照樣會忘掉。
export function nextSearchMemory(memory, frame) {
  const f = frame || {};
  if (f.nativePrompt) return { known: false, conds: [] };
  if (!memory) return null;
  if (f.mode === 'plain') return memory.fresh ? memory : null;
  return memory.fresh ? { known: memory.known, conds: memory.conds } : memory;
}

// 彈窗送出的搜尋被 PTT 收下（prompt 消失）時記一筆。fromMode ＝送出前那一幀的子模式：
// 從完整列表搜＝新的一串條件，從搜尋結果搜＝增加條件。
export function rememberSubmitted(memory, fromMode, kind, text) {
  if (STATUS_KINDS.indexOf(kind) < 0) return memory || null;
  const cond = { kind: kind, text: String(text) };
  if (fromMode === 'plain') return { known: true, conds: [cond], fresh: true };
  if (fromMode === 'select') {
    if (!memory) return { known: false, conds: [] };
    if (!memory.known) return memory;
    return { known: true, conds: memory.conds.concat([cond]) };
  }
  return memory || null;
}

function enabled() {
  return !!readEffectivePrefs().enableSearchStatus;
}

const HIDDEN = { visible: false, board: null, conds: null, right: 0, top: 0, mobile: false };

export function SearchStatus(core) {
  this._core = core;
  this._listeners = new Set();
  this._memory = null;
  this._state = Object.assign({}, HIDDEN);
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

SearchStatus.prototype = {
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

  _facts: function() {
    return searchGateFacts(this._core);
  },

  // 搜尋彈窗送出前呼叫：記下這一刻在完整列表還是搜尋結果，回傳「PTT 收下了」時要呼叫的函式。
  beginSearch: function(kind, text) {
    const facts = this._facts();
    const fromMode = facts ? searchListMode(facts.rowTexts) : null;
    const self = this;
    return function() {
      self._memory = rememberSubmitted(self._memory, fromMode, kind, text);
      self.refresh();
    };
  },

  // 終端機右上角（文章列表標題列右段＝「系列《板》」那一格）。手機由 CSS 改排到 App Bar 下面。
  _geometry: function() {
    const view = this._core.view;
    const main = view && view.mainDisplay;
    if (!main || typeof main.getBoundingClientRect !== 'function' || typeof window === 'undefined') return null;
    const r = main.getBoundingClientRect();
    if (!r.width) return null;
    return { right: Math.max(0, Math.round(window.innerWidth - r.right)), top: Math.max(0, Math.round(r.top)) };
  },

  refresh: function() {
    const core = this._core;
    const facts = this._facts();
    if (!facts) return this._set({ visible: false });
    const mode = searchListMode(facts.rowTexts);
    const nativePrompt =
      !core.searchInFlight &&
      (isSearchPromptFrame('title', facts) || isSearchPromptFrame('author', facts) || isSearchPromptFrame('push', facts));
    this._memory = nextSearchMemory(this._memory, { mode: mode, nativePrompt: nativePrompt });
    const buf = core.buf;
    if (!enabled() || mode !== 'select' || (buf && buf.pageState === 3)) return this._set({ visible: false });
    const g = this._geometry();
    if (!g) return this._set({ visible: false });
    const m = this._memory;
    const conds = m && m.known && m.conds.length ? m.conds : null;
    this._set({
      visible: true,
      board: boardNameFromKey(parseBoardKey(facts.rowTexts[0] || '')),
      conds: conds,
      right: g.right,
      top: g.top,
      mobile: !!core.mobile,
    });
  },

  // ✕：替使用者按 ←（列表上 read_cmd_quit 只離開子模式）。走鍵盤同一條分派。
  leave: function() {
    const view = this._core.view;
    if (view && typeof view.sendKeyAsUser === 'function') view.sendKeyAsUser('ArrowLeft');
  },

  // ＋條件：替使用者按 `/`。搜尋鍵攔截開著就是搜尋彈窗（在搜尋結果裡送出＝增加條件），
  // 關著就是 PTT 原生的「增加條件 標題:」；忙碌閘門也照鍵盤那條走。
  addCondition: function() {
    const view = this._core.view;
    if (view && typeof view.sendKeyAsUser === 'function') view.sendKeyAsUser('/');
  },
};

export default SearchStatus;
