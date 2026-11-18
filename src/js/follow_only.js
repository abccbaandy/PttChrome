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
import { STORAGE_KEYS } from './user_data_keys';
import { defaultStorage, readFlag, writeFlag } from './user_data';
import { readEffectivePrefs } from './pref_storage';
import { OWNER_ARTICLE_LIST } from './list_render_owner';
import { PAGE_STATE } from './screen_model';

export const FOLLOW_ONLY_ID = 'followOnlyChip';
export const FOLLOW_ONLY_KEY = STORAGE_KEYS.followOnly;

export function isFollowOnlyTarget(el) {
  return !!(el && typeof el.closest === 'function' && el.closest('#' + FOLLOW_ONLY_ID));
}

function readOn(storage) {
  return readFlag('followOnly', storage);
}

// 私密視窗／存不了：這一頁照樣切，只是不記得（user_data.writeFlag 的契約）。
function writeOn(storage, on) {
  writeFlag('followOnly', !!on, storage);
}

// 這一幀要不要出現鈕（純函式）。facts：{ enabled, followListOn, hasFollow, listWindow, pageState }。
export function followOnlyAvailable(facts) {
  const f = facts || {};
  return !!(f.enabled && f.followListOn && f.hasFollow && f.listWindow && f.pageState !== PAGE_STATE.READING);
}

const HIDDEN = { visible: false, on: false, empty: false, right: 0, top: 0, mobile: false, inTabs: false, compact: false };

// 鈕高（FollowOnly.css .followOnlyChip height）。
export const FOLLOW_ONLY_CHIP_HEIGHT = 24;

// P108（L 11/18 同意）：桌機的鈕原本疊在標題列（終端機第 0 列）最右邊，蓋住「看板《板名》」的後半。
//   - 看板分頁開著 ⇒ 移到分頁列（第 1 列，本來就被分頁列整條蓋住）的最右邊，垂直置中，不多蓋任何字；
//   - 分頁關著 ⇒ 留在原位、縮成只剩星號的小圓鈕（只蓋到最後的「》」）。整段都被收起時照舊寫「這一段沒有」
//     （那是唯一的說明，不能縮）。
// 手機不變（入口在「更多」，浮動鈕只在 empty 時出現，位置由 CSS 定）。純函式：tabs＝BoardTabs.state。
export function followOnlySlot(tabs, opts) {
  const o = opts || {};
  if (o.mobile) return { inTabs: false, compact: false, top: o.top };
  if (tabs && tabs.visible && !tabs.mobile && tabs.rowHeight > 0) {
    return {
      inTabs: true,
      compact: false,
      top: Math.round(tabs.top + (tabs.rowHeight - FOLLOW_ONLY_CHIP_HEIGHT) / 2),
    };
  }
  return { inTabs: false, compact: !o.empty, top: o.top + 1 };
}

export function FollowOnly(core, opts) {
  this._core = core;
  this._storage = opts && 'storage' in opts ? opts.storage : defaultStorage();
  this._listeners = new Set();
  this._state = Object.assign({}, HIDDEN);
  if (core.view) core.view.followOnly = readOn(this._storage);
  const self = this;
  // 故障停用（docs/feature-isolation.md）：settle 出錯 ⇒ 這次連線收起切換鈕、列表回到全部（篩選
  // 經 suspended() 失效，view.listFollowOnly 回 null；使用者存的切換狀態不動），resize、設定變更、
  // 點鈕這些入口也擋。新連線 enableAllListeners 恢復：篩選照存的狀態回來。
  this._onSettle = function() {
    self.refresh();
  };
  if (core.buf && core.buf.addEventListener)
    core.buf.addEventListener('screenSettled', this._onSettle, {
      feature: 'enableFollowOnly',
      disable: () => self._suspend(),
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

  // 被故障停用中（這次連線）：篩選不生效、鈕不出現。
  suspended: function() {
    const buf = this._core.buf;
    return !!(buf && buf.isListenerDisabled && buf.isListenerDisabled(this._onSettle));
  },

  _suspend: function() {
    this._set({ visible: false });
    const view = this._core.view;
    if (view && view.followOnly && typeof view.redraw === 'function') view.redraw(true);
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

  // 看板分頁的位置變了就跟著挪（P108）。看板分頁在建構子裡排在這個功能之後（features.js 第二段），
  // 建構當下還沒有 ⇒ 第一次 refresh 時才訂（onChange 會立刻回呼一次，先立旗標擋重入）。
  _watchTabs: function() {
    const tabs = this._core.boardTabs;
    if (this._tabsWatched || !tabs || typeof tabs.onChange !== 'function') return;
    this._tabsWatched = true;
    const self = this;
    tabs.onChange(function() {
      self.refresh();
    });
  },

  refresh: function() {
    if (this.suspended()) return this._set({ visible: false });
    this._watchTabs();
    const facts = this._facts();
    if (!followOnlyAvailable(facts)) return this._set({ visible: false });
    const g = this._geometry();
    if (!g) return this._set({ visible: false });
    const on = !!this._core.view.followOnly;
    const count = on ? this._visibleCount() : null;
    const empty = on && count === 0;
    const mobile = !!this._core.mobile;
    const tabs = this._core.boardTabs;
    const slot = followOnlySlot(tabs && tabs.state, { mobile: mobile, empty: empty, top: g.top });
    this._set({
      visible: true,
      on: on,
      empty: empty,
      right: g.right,
      top: slot.top,
      mobile: mobile,
      inTabs: slot.inTabs,
      compact: slot.compact,
    });
  },

  // 切換鈕：只改顯示（view.followOnly）＋重畫，本身不送鍵（不夠看時由列表好讀照常補頁）。
  toggle: function() {
    const view = this._core.view;
    if (!view || this.suspended()) return;
    view.followOnly = !view.followOnly;
    writeOn(this._storage, view.followOnly);
    if (typeof view.redraw === 'function') view.redraw(true);
    this.refresh();
  },
};

export default FollowOnly;
