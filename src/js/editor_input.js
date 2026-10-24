// 編輯器輸入框（P27，設計見 docs/editor-input.md）。
//
// PTT 編輯器（Ctrl+P 發文、y 回文、寄信，pageState 6：底列「編輯文章」＋插入／取代狀態框）在手機上
// 是縮小的 80 欄格線，字小到看不清、不能選取、不能拖游標，打長文幾乎不可能；桌機用輸入法打長段
// 也容易錯。這支在編輯器畫面多一個「輸入框」入口（桌機：終端機右下角的鈕；手機：底部導覽第一格），
// 按下跳出一般文字框（手機是 bottom sheet），用系統原生的鍵盤、輸入法、選字、貼上、拼字修正打字，
// 按「插入」就把整段送進編輯器游標處，可以打一段插一段。存檔、離開照舊用原生 Ctrl+X。
//   1. **送法＝貼上**：插入走 App.onPasteDone（與 Ctrl+V／Shift+Insert 同一條漏斗：序列化操作在途
//      時擋下、normalizePasteText 把換行轉成 Enter、_convSend 轉碼）。送之前先 stripNonBig5 濾掉
//      PTT 畫不出來的字（同長推文），濾掉了什麼告訴使用者。不做顏色（ANSI 色碼照舊用原生 Ctrl+C）。
//   2. **只在編輯器**：pageState 6 是 term_buf.setPageState 的編輯器判準（footer caption＋狀態框兩個
//      要素都要對上）；認不出 ⇒ 入口不出現、插入不送（已開著的框按插入時再判一次）。
//   3. 開關 pref enableEditorInput（預設開）；會替使用者送字 ⇒ 在安全模式名單內。
import { readEffectivePrefs } from './pref_storage';
import { stripNonBig5 } from './long_push';

export const EDITOR_INPUT_ID = 'editorInputChip';
export const EDITOR_PAGE_STATE = 6;

export function isEditorInputTarget(el) {
  return !!(el && typeof el.closest === 'function' && el.closest('#' + EDITOR_INPUT_ID));
}

// 這一幀要不要有入口（純函式）。
export function editorInputAvailable(facts) {
  const f = facts || {};
  return !!(f.enabled && !f.safeMode && f.pageState === EDITOR_PAGE_STATE);
}

// 插入前的整理（純函式）：濾掉 PTT 畫不出來的字；只剩空白／換行也算空（不送）。
export function prepareEditorInsert(text) {
  const r = stripNonBig5(text);
  return { text: r.text, dropped: r.dropped, empty: !r.text.replace(/[\s\n]/g, '') };
}

const CLOSED = Object.freeze({ available: false, open: false, mobile: false, right: 0, bottom: 0 });

export function EditorInput(core) {
  this._core = core;
  this._listeners = new Set();
  this._state = CLOSED;
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

EditorInput.prototype = {
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
    if (Object.keys(next).every((k) => next[k] === this._state[k])) return;
    this._state = next;
    this._listeners.forEach(function(fn) {
      fn(next);
    });
  },

  _available: function() {
    const core = this._core;
    const prefs = readEffectivePrefs();
    return editorInputAvailable({
      enabled: !!prefs.enableEditorInput,
      safeMode: !!prefs.nativeSafeMode,
      pageState: core.buf ? core.buf.pageState : null
    });
  },

  // 桌機的鈕：終端機右下角、底列（狀態列）上面一列。
  _geometry: function() {
    const view = this._core.view;
    const main = view && view.mainDisplay;
    if (!main || typeof main.getBoundingClientRect !== 'function' || typeof window === 'undefined')
      return { right: 0, bottom: 0 };
    const r = main.getBoundingClientRect();
    const chh = view.chh || 0;
    return {
      right: Math.max(0, Math.round(window.innerWidth - r.right)),
      bottom: Math.max(0, Math.round(window.innerHeight - r.bottom + chh))
    };
  },

  refresh: function() {
    const available = this._available();
    const g = available ? this._geometry() : { right: 0, bottom: 0 };
    this._set({ available: available, mobile: !!this._core.mobile, right: g.right, bottom: g.bottom });
  },

  open: function() {
    this.refresh();
    if (!this._state.available) return false;
    this._set({ open: true });
    return true;
  },

  close: function() {
    this._set({ open: false });
  },

  // 插入：回 { ok, dropped, reason }。ok ＝已交給貼上漏斗（框收起）；reason 'empty'／'not-editor'
  // ＝沒送（框留著，內容不丟）。
  insert: function(text) {
    const p = prepareEditorInsert(text);
    if (p.empty) return { ok: false, dropped: p.dropped, reason: 'empty' };
    this.refresh();
    if (!this._state.available) return { ok: false, dropped: p.dropped, reason: 'not-editor' };
    const core = this._core;
    this._set({ open: false });
    if (typeof core.onPasteDone === 'function') core.onPasteDone(p.text);
    return { ok: true, dropped: p.dropped };
  }
};

export default EditorInput;
