// 只看關注（P36，設計見 docs/list-row-filter.md「只看關注」）。
//
// 文章列表（列表好讀）右上角一顆切換鈕「★ 只看關注」：開著時列表只留關注作者／標題關鍵字
// （P33 關注名單）的文章，其他列收起。
//   1. **切換本身不送鍵**：收起＝列表好讀本來就有的「藏列」（跟黑名單同一條：
//      list_session#visibleListIndices＋screen_annotations 的 listEasyReading 分支，判準在
//      list_row_filter#isFollowOnlyHidden）。翻頁、補頁照列表好讀原本的規則（藏掉的列不算進
//      「補到夠看」的列數，跟黑名單命中率高的板一樣有頁數上限）⇒ 開起來後可能接著補頁，
//      但只會有補頁腿，不會開文、跳號或動到使用者的位置。
//   2. **只在列表好讀**：原生 24 列格線收不起列 ⇒ 不出現、也不生效（view.listFollowOnly 的條件
//      之外，原生鏡像那條 render 不帶 listEasyReading）。看板列表、文章裡都不出現。
//   3. 整段都被收起時鈕上寫「這一段沒有」，不會只剩一片空白卻不知道為什麼。
//   4. 切換狀態只存本機（localStorage `pttchrome.followOnly`），不同步；功能開關是 pref
//      enableFollowOnly（預設開），關注名單是空的或名單開關關著 ⇒ 不出現。
import { readEffectivePrefs } from './pref_storage';
import { OWNER_ARTICLE_LIST } from './list_render_owner';

export const FOLLOW_ONLY_ID = 'followOnlyChip';
export const FOLLOW_ONLY_KEY = 'pttchrome.followOnly';

export function isFollowOnlyTarget(el) {
  return !!(el && typeof el.closest === 'function' && el.closest('#' + FOLLOW_ONLY_ID));
}

function defaultStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch (e) {
    return null;
  }
}

function readOn(storage) {
  try {
    return !!storage && storage.getItem(FOLLOW_ONLY_KEY) === '1';
  } catch (e) {
    return false;
  }
}

function writeOn(storage, on) {
  try {
    if (!storage) return;
    if (on) storage.setItem(FOLLOW_ONLY_KEY, '1');
    else storage.removeItem(FOLLOW_ONLY_KEY);
  } catch (e) {
    // 私密視窗／存不了：這一頁照樣切，只是不記得。
  }
}

// 這一幀要不要出現鈕（純函式）。facts：{ enabled, followListOn, hasFollow, listWindow, pageState }。
export function followOnlyAvailable(facts) {
  const f = facts || {};
  return !!(f.enabled && f.followListOn && f.hasFollow && f.listWindow && f.pageState !== 3);
}

const HIDDEN = { visible: false, on: false, empty: false, right: 0, top: 0, mobile: false };

export function FollowOnly(core, opts) {
  this._core = core;
  this._storage = opts && 'storage' in opts ? opts.storage : defaultStorage();
  this._listeners = new Set();
  this._state = Object.assign({}, HIDDEN);
  if (core.view) core.view.followOnly = readOn(this._storage);
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

FollowOnly.prototype = {
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
    const core = this._core;
    const view = core.view;
    const buf = core.buf;
    if (!view || !buf) return null;
    const a = view.followAuthors;
    const k = view.followTitleKeywords;
    return {
      enabled: !!readEffectivePrefs().enableFollowOnly,
      followListOn: !!view.enableFollowList,
      hasFollow: (a && a.size > 0) || (k && k.length > 0),
      listWindow:
        (buf.listRenderMode === 'buffer' || buf.listRenderMode === 'frozen') &&
        buf.listRenderOwner === OWNER_ARTICLE_LIST,
      pageState: buf.pageState,
    };
  },

  // 終端機右上角（同搜尋狀態列；兩個同時出現時 CSS 讓它往下一排）。手機在 App Bar 下面。
  _geometry: function() {
    const view = this._core.view;
    const main = view && view.mainDisplay;
    if (!main || typeof main.getBoundingClientRect !== 'function' || typeof window === 'undefined') return null;
    const r = main.getBoundingClientRect();
    if (!r.width) return null;
    return { right: Math.max(0, Math.round(window.innerWidth - r.right)), top: Math.max(0, Math.round(r.top)) };
  },

  _visibleCount: function() {
    const core = this._core;
    const ls = core.activeListSession ? core.activeListSession() : null;
    return ls && typeof ls.visibleRowCount === 'function' ? ls.visibleRowCount() : null;
  },

  refresh: function() {
    const facts = this._facts();
    if (!followOnlyAvailable(facts)) return this._set({ visible: false });
    const g = this._geometry();
    if (!g) return this._set({ visible: false });
    const on = !!this._core.view.followOnly;
    const count = on ? this._visibleCount() : null;
    this._set({
      visible: true,
      on: on,
      empty: on && count === 0,
      right: g.right,
      top: g.top,
      mobile: !!this._core.mobile,
    });
  },

  // 切換鈕：只改顯示（view.followOnly）＋重畫，本身不送鍵（不夠看時由列表好讀照常補頁）。
  toggle: function() {
    const view = this._core.view;
    if (!view) return;
    view.followOnly = !view.followOnly;
    writeOn(this._storage, view.followOnly);
    if (typeof view.redraw === 'function') view.redraw(true);
    this.refresh();
  },
};

export default FollowOnly;
