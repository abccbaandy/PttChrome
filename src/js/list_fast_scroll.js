// 列表快速捲動把手（P30，設計見 docs/easy-reading-list.md「快速捲動把手」）。
//
// 大看板想往回翻到幾小時前，只能一直往上捲（每次補一頁）或自己打編號。這支在列表好讀的
// 文章列表右緣放一個 Android 通訊錄式的把手：
//   1. **捲動時才出現**，停下 FAST_SCROLL_IDLE_MS 後收起（平常不蓋卡片右緣、不擋點擊）。
//   2. **拖動途中一個 byte 都不送**：把手旁浮出「編號 N」，N 由把手在軌道上的位置換算
//      （1 到這個看板看過的最大編號，線性）。
//   3. **放開才送一次原生跳號 `<N>⏎`**：走列表好讀既有的 jump-number 交易
//      （list_session#jumpToNumber → _beginJumpNumber，零回應、逾時退原生都已處理），
//      跳過去之後照常上下捲、補頁。閱讀紀錄 'list-fast-scroll'（目的就是移動，不還原）。
//   4. **只在列表好讀的完整文章列表**：搜尋結果／文摘的編號空間不同（跳號會跳錯）、原生
//      格線、看板列表、交易進行中 ⇒ 不出現。緩衝已經涵蓋整個看板（從 1 到板尾）也不出現。
//   5. 功能開關 pref enableListFastScroll（預設開）。
import { readEffectivePrefs } from './pref_storage';
import { OWNER_ARTICLE_LIST, listRenderOwnerOf } from './list_render_owner';
import { recordFor } from './reading_record';

export const FAST_SCROLL_ID = 'listFastScrollHandle';
export const FAST_SCROLL_IDLE_MS = 1500;
// 把手的高與寬（px，CSS 同值）：手指拖得到的大小。
export const FAST_SCROLL_HANDLE_H = 44;
export const FAST_SCROLL_HANDLE_W = 28;

export function isListFastScrollTarget(el) {
  return !!(el && typeof el.closest === 'function' && el.closest('#' + FAST_SCROLL_ID));
}

function clamp01(f) {
  const x = Number(f);
  if (!(x > 0)) return 0;
  return x >= 1 ? 1 : x;
}

// 軌道位置（0＝最上面＝最舊）→ 編號。
export function fastScrollNumAt(frac, hi) {
  const top = Math.max(1, Math.floor(Number(hi) || 1));
  return Math.max(1, Math.min(top, Math.round(1 + clamp01(frac) * (top - 1))));
}

// 編號 → 軌道位置。
export function fastScrollFracOf(num, hi) {
  const top = Math.floor(Number(hi) || 1);
  if (top <= 1) return 0;
  return clamp01(((Number(num) || 1) - 1) / (top - 1));
}

// 這個看板到目前為止看過的最大編號：補到板尾（edgeDown）時以緩衝為準（刪文會讓板尾
// 變小），否則只增不減（遠跳到舊的那段之後，緩衝的最大編號會變小）。換板重來。
export function nextHiSeen(prev, info) {
  if (!info) return prev;
  const same = prev && prev.board === info.board;
  if (info.edgeDown || !same) return { board: info.board, hi: info.hi };
  return { board: info.board, hi: Math.max(prev.hi, info.hi) };
}

// 要不要出現（純函式）：開關開、列表好讀完整列表、緩衝沒涵蓋整個看板。
export function fastScrollAvailable(enabled, info, hiSeen) {
  if (!enabled || !info || !hiSeen) return false;
  return info.lo > 1 || info.hi < hiSeen;
}

// 拖動中把手的頂端 y（clientY 是手指／滑鼠的位置，抓在把手中間）→ 軌道位置。
export function fastScrollFracFromPointer(clientY, track) {
  const span = track.height - FAST_SCROLL_HANDLE_H;
  if (!(span > 0)) return 0;
  return clamp01((clientY - track.top - FAST_SCROLL_HANDLE_H / 2) / span);
}

const HIDDEN = Object.freeze({
  visible: false,
  dragging: false,
  frac: 0,
  num: null,
  hi: 0,
  top: 0,
  height: 0,
  right: 0
});

export function ListFastScroll(core, opts) {
  this._core = core;
  this._doc = opts && 'document' in opts ? opts.document : typeof document !== 'undefined' ? document : null;
  this._listeners = new Set();
  this._state = HIDDEN;
  this._hiSeen = null;
  this._shown = false;
  this._idleTimer = null;
  this._drag = null;
  const self = this;
  if (core.buf && core.buf.addEventListener)
    core.buf.addEventListener('screenSettled', function() {
      self._noteInfo();
      if (self._shown || self._drag) self.refresh();
    });
  // 捲動列表好讀的視口（`.listBodyView`，scroll 不冒泡 ⇒ capture）。
  if (this._doc && this._doc.addEventListener)
    this._doc.addEventListener(
      'scroll',
      function(e) {
        const t = e && e.target;
        if (t && t.classList && t.classList.contains('listBodyView')) self.noteScroll();
      },
      { capture: true, passive: true }
    );
}

ListFastScroll.prototype = {
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

  _set: function(next) {
    const cur = this._state;
    if (Object.keys(next).every((k) => next[k] === cur[k])) return;
    this._state = next;
    this._listeners.forEach(function(fn) {
      fn(next);
    });
  },

  _session: function() {
    const core = this._core;
    if (!core.buf || listRenderOwnerOf(core.buf) !== OWNER_ARTICLE_LIST) return null;
    return core.listSession || null;
  },

  _info: function() {
    const ls = this._session();
    return ls && typeof ls.fastScrollInfo === 'function' ? ls.fastScrollInfo() : null;
  },

  _noteInfo: function() {
    const info = this._info();
    this._hiSeen = nextHiSeen(this._hiSeen, info);
    return info;
  },

  _track: function() {
    const view = this._core.view;
    const main = view && view.mainDisplay;
    const body = main && typeof main.querySelector === 'function' ? main.querySelector('.listBodyView') : null;
    if (!body || typeof body.getBoundingClientRect !== 'function') return null;
    const r = body.getBoundingClientRect();
    if (!(r.height > FAST_SCROLL_HANDLE_H * 2) || !r.width) return null;
    return { top: r.top, height: r.height, right: r.right };
  },

  _hide: function() {
    this._shown = false;
    this._set(HIDDEN);
  },

  // 使用者捲了列表：出現，停下 FAST_SCROLL_IDLE_MS 後收起（拖動中不收）。
  noteScroll: function() {
    if (this._drag) return;
    this._shown = true;
    this._armIdle();
    this.refresh();
  },

  _armIdle: function() {
    const self = this;
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(function() {
      self._idleTimer = null;
      if (!self._drag) self._hide();
    }, FAST_SCROLL_IDLE_MS);
  },

  refresh: function() {
    if (!this._shown && !this._drag) return this._hide();
    const info = this._noteInfo();
    const hiSeen = this._hiSeen;
    const enabled = !!readEffectivePrefs().enableListFastScroll;
    if (!fastScrollAvailable(enabled, info, hiSeen && hiSeen.hi)) {
      this._drag = null;
      return this._hide();
    }
    const track = this._track();
    if (!track) return this._hide();
    const hi = hiSeen.hi;
    const drag = this._drag;
    const frac = drag ? drag.frac : fastScrollFracOf(info.topNum, hi);
    this._set({
      visible: true,
      dragging: !!drag,
      frac: frac,
      num: drag ? fastScrollNumAt(frac, hi) : null,
      hi: hi,
      top: track.top,
      height: track.height,
      right: track.right
    });
  },

  dragStart: function(clientY) {
    if (!this._state.visible) return false;
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = null;
    this._drag = { frac: this._state.frac };
    this.dragMove(clientY);
    return true;
  },

  // 拖動中只改畫面，一個 byte 都不送。
  dragMove: function(clientY) {
    if (!this._drag) return;
    const s = this._state;
    this._drag.frac = fastScrollFracFromPointer(clientY, s);
    this.refresh();
  },

  // 放開（commit）＝送一次跳號；取消（pointercancel）＝零送出。
  dragEnd: function(commit) {
    const drag = this._drag;
    if (!drag) return false;
    this._drag = null;
    const hi = this._hiSeen ? this._hiSeen.hi : 0;
    const info = this._info();
    this._armIdle();
    this.refresh();
    if (!commit || !info || !hi) return false;
    const num = fastScrollNumAt(drag.frac, hi);
    if (num === info.topNum) return false;
    const ls = this._session();
    const rr = recordFor(this._core);
    const bm = rr.begin('list-fast-scroll');
    const end = function(outcome) {
      if (bm) rr.end(bm, outcome);
    };
    const ok =
      !!ls &&
      ls.jumpToNumber(num, {
        onDone: function() {
          end('done');
        },
        onFail: function() {
          end('fail');
        }
      });
    if (!ok) end('cancel');
    return ok;
  }
};

export default ListFastScroll;
