// 好讀文章底部常駐推文列（設計見 docs/long-push.md「底部常駐推文列」）。
//
// 好讀文章的最下面常駐一條「推／噓／→＋文字」輸入列，打完按 Enter 就推出去。送出
// **整條沿用長推文管線**（探路 X → 分段 → 冷卻等待 → 草稿保存 → 錯誤框），這裡只管
// 兩件事：
//   1. 什麼時候出現、畫在哪（控制器，狀態給 components/CommentBar 照畫）；
//   2. 探路回來之後「直接送」還是「退回長推文輸入框讓使用者看一眼」（quickPushPlan，純函式）。
// 送鍵入口只有 ContextMenu 注入的 App.openQuickPush（同 openLongPushModal 的合約）。
//
// 出現條件同文章工具側欄（article_tools._inEasyArticle）：pageState 3＋好讀開著＋不在
// functionMode＋累積頁非空。原生 pmore、列表、選單都不出現 ⇒ 認不出就是原生。
// 送出期間長推文會切進 functionMode（原生鏡像），列跟著收起，送完回到好讀再出現。
import { readEffectivePrefs } from './pref_storage';
import { stripNonBig5, splitPushSegments } from './long_push';

export const COMMENT_BAR_ID = 'commentBar';
// 列高（CSS px）。終端機累積頁尾端要多留這麼高的空白，最後一列才捲得出列的下面
// （CSS 變數 --comment-bar-h，見 main.css `.commentBarShown`）。
export const COMMENT_BAR_HEIGHT = 40;
// 超過這麼多則就不直接送，退回輸入框（那裡有「還是要送」的二次確認）。同 LongPushModal。
export const QUICK_PUSH_MAX_SEGMENTS = 20;

export function isCommentBarTarget(el) {
  return !!(el && typeof el.closest === 'function' && el.closest('#' + COMMENT_BAR_ID));
}

// 送鍵的功能 ⇒ 受長推文總開關與安全模式管（enableCommentBar 在 NATIVE_SAFE_MODE_KEYS，
// 傳進來的是 readEffectivePrefs 的值：安全模式開著時它已經是 false）。
export function commentBarEnabled(prefs) {
  const v = prefs || {};
  return !!(v.enableLongPush && v.enableCommentBar);
}

/**
 * 探路（preflight）成功之後，這一次要直接送，還是退回長推文輸入框。
 *
 * 退回的情況都是「使用者該先看一眼」：PTT 會把這次改成 →（作者本人／90 秒內）、這塊板
 * 禁噓卻選了噓、有字推不出去會被濾掉、或分段太多（輸入框那裡有二次確認）。退回時內容
 * 已經在草稿裡，輸入框一打開就看得到，一個字都不會丟。
 *
 * @param {object} result  LongPushSession.onPreflight 的參數（blocked 為 false 的那種）
 * @param {{text: string, type: string}} quick
 * @param {number} maxBytes
 * @returns {{direct: boolean, reason: string, text: string}}
 */
export function quickPushPlan(result, quick, maxBytes) {
  const r = result || {};
  const raw = String((quick && quick.text) || '');
  const type = (quick && quick.type) || 'push';
  const { text, dropped } = stripNonBig5(raw);
  if (!text.trim()) return { direct: false, reason: 'empty', text };
  if (r.degraded) return { direct: false, reason: 'degraded', text };
  if (type === 'boo' && r.booAllowed === false) return { direct: false, reason: 'noBoo', text };
  if (dropped && dropped.length) return { direct: false, reason: 'dropped', text };
  if (splitPushSegments(text, r.maxBytes || maxBytes).length > QUICK_PUSH_MAX_SEGMENTS)
    return { direct: false, reason: 'tooMany', text };
  return { direct: true, reason: 'ok', text };
}

// 列的位置：與終端機同寬、貼在終端機可見內容的最下緣（桌機在好讀 footer 那一列之上，
// 手機換行版面 footer 收起，就是終端機底＝底部導覽上緣）。bottom 是距視窗底的距離。
// bottomInset：疊在視窗底的浮層（手機底部導覽列＋軟鍵盤＋safe-area，view.keyboardInset）。
// 手機的 .main 會因列高取整比可用高度高幾 px、延伸到導覽列後面 ⇒ 至少要讓出它，不然推文
// 列壓在導覽列上（e2e mobile_bottom_overlay）。
// footerTop：好讀 footer 的上緣（顯示中才給）。footer 疊在格線最後一列、不在 `.main` 最下緣
// （`.main` 比格線高 10px，main.css #easyReadingLastRow），所以量它的上緣，不用 `.main` 下緣扣高度。
export function commentBarGeometry({ mainRect, footerTop, innerHeight, bottomInset }) {
  if (!mainRect || !mainRect.width) return null;
  const contentBottom = footerTop != null ? Math.min(mainRect.bottom, footerTop) : mainRect.bottom;
  return {
    left: Math.round(mainRect.left),
    width: Math.round(mainRect.width),
    bottom: Math.max(0, Math.round(innerHeight - contentBottom), Math.round(bottomInset || 0)),
  };
}

// 手機收合（pref mobileCommentBarFold，預設開）：平常只留底部導覽，點導覽的「推文」才
// 展開列並叫出鍵盤；送出、離開輸入框、收鍵盤、系統返回就收回。桌機不收合。
export function commentBarFolded(prefs, mobile) {
  return !!(mobile && prefs && prefs.mobileCommentBarFold);
}

// available：出現條件成立（好讀文章＋開關開著）；visible：列真的畫出來（收合時要 expanded）。
// prefill：「回覆這則」之類的預填請求 { type, text, n }（n 每次遞增，元件靠它分辨新請求）。
// focusN：展開時要聚焦輸入框的請求序號（同上，元件靠它分辨新請求）。
const HIDDEN = {
  visible: false,
  available: false,
  folded: false,
  expanded: false,
  left: 0,
  width: 0,
  bottom: 0,
  mobile: false,
  prefill: null,
  focusN: 0,
};

export function CommentBar(core) {
  this._core = core;
  this._listeners = new Set();
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

CommentBar.prototype = {
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

  // 預填推文列（類型＋文字）並叫出輸入框。不在好讀文章（列不該出現）就不做（回 false）——
  // 不替使用者開別的東西。手機收合中會先展開。
  prefill: function(req) {
    if (!req || !this.expand({ focus: false })) return false;
    const n = ((this._state.prefill && this._state.prefill.n) || 0) + 1;
    this._set({ prefill: { type: req.type || 'push', text: String(req.text || ''), n: n } });
    return true;
  },

  // 展開列並聚焦輸入框（手機收合時底部導覽的「推文」走這裡）。不在好讀文章回 false。
  // 沒收合（桌機、手機常駐）就只聚焦。展開期間登記成 bottom sheet：系統返回先收它。
  expand: function(opts) {
    if (!this._state.available) return false;
    const patch = { visible: true };
    if (this._state.folded && !this._state.expanded) {
      patch.expanded = true;
      const core = this._core;
      if (core.registerSheetDismiss && !this._unregisterBack)
        this._unregisterBack = core.registerSheetDismiss(() => this.collapse());
    }
    if (!opts || opts.focus !== false) patch.focusN = this._state.focusN + 1;
    this._set(patch);
    return true;
  },

  // 收回展開的列（收合模式才有作用）。
  collapse: function() {
    this._releaseBack();
    if (!this._state.expanded) return;
    this._set({ expanded: false, visible: this._state.available && !this._state.folded });
  },

  _releaseBack: function() {
    const off = this._unregisterBack;
    this._unregisterBack = null;
    if (off) off();
  },

  _hide: function() {
    this._releaseBack();
    if (this._state.visible || this._state.available || this._state.expanded)
      this._set({ visible: false, available: false, expanded: false });
  },

  _inEasyArticle: function() {
    const core = this._core;
    const er = core.easyReading;
    const buf = core.buf;
    return !!(buf && buf.pageState === 3 && er && er._enabled && !er._functionMode && (buf.pageLines || []).length);
  },

  // 終端機可見內容的下緣：好讀 footer 顯示中＝它的上緣，否則 .main 的下緣。
  _geometry: function() {
    const view = this._core.view;
    const main = view && view.mainDisplay;
    if (!main || typeof main.getBoundingClientRect !== 'function' || typeof window === 'undefined') return null;
    const footer = view.lastRowDiv;
    let footerTop = null;
    if (footer && typeof footer.getBoundingClientRect === 'function' && window.getComputedStyle(footer).display !== 'none')
      footerTop = footer.getBoundingClientRect().top;
    return commentBarGeometry({
      mainRect: main.getBoundingClientRect(),
      footerTop: footerTop,
      innerHeight: window.innerHeight,
      bottomInset: view.keyboardInset,
    });
  },

  refresh: function() {
    const core = this._core;
    const prefs = readEffectivePrefs();
    if (!commentBarEnabled(prefs) || !this._inEasyArticle()) return this._hide();
    const g = this._geometry();
    if (!g) return this._hide();
    const folded = commentBarFolded(prefs, core.mobile);
    // 收合關掉（設定改了、轉成桌機）⇒ 展開狀態沒有意義了。
    if (!folded && this._state.expanded) this._releaseBack();
    const expanded = folded && this._state.expanded;
    this._set({
      visible: !folded || expanded,
      available: true,
      folded: folded,
      expanded: expanded,
      left: g.left,
      width: g.width,
      bottom: g.bottom,
      mobile: !!core.mobile,
    });
  },
};

export default CommentBar;
