// 文章導覽軸（設計見 docs/article-tools.md「文章導覽軸」）。
//
// 好讀文章的終端機右緣一條細軸（手機也有）：標出推文從哪裡開始、新推文（new_comments 的
// 標記）、提到我的推文、圖片的位置，以及目前看到哪；點或拖就捲過去。幾千則推文的文章
// 不用一直滑才找得到推文從哪開始、新推文在哪；文章工具側欄只有寬螢幕才有。
//   1. **一個 byte 都不送**：資料全取自好讀的累積頁（buf.pageLines，與文章工具側欄同一支
//      analyzeArticle），捲動只動好讀的視口（easyReading.scrollToArticleRow／scrollTop）。
//      還沒讀到的部分不在軸上，照現有的往下捲／End 補。
//   2. 出現條件同推文列（pageState 3＋好讀開著＋不在 functionMode＋累積頁非空）：原生 pmore、
//      列表、選單一律不出現。
//   3. 只疊在終端機最右一欄上（像捲軸），不推動、不縮小終端機（docs/terminal-size.md LOCKED）。
import { analyzeArticle } from './article_tools';
import { getImageProxyConfig } from './image_proxy';
import { readEffectivePrefs } from './pref_storage';
import { COMMENT_BAR_HEIGHT } from './comment_bar';

export const ARTICLE_NAV_ID = 'articleNav';
// 軸的寬度（可點範圍，CSS px）。看得到的只有中間一條細線。
export const ARTICLE_NAV_WIDTH = 14;
// 一種標記最多畫幾個（幾千則推文的文章：再多也只是糊成一條）。
const MARK_LIMIT = 300;

export function isArticleNavTarget(el) {
  return !!(el && typeof el.closest === 'function' && el.closest('#' + ARTICLE_NAV_ID));
}

// 累積頁的分析結果 → 軸上的標記（純函式）。f ＝在累積頁裡的位置（0～1，列號 / 總列數）。
//   comments：第一則推文（只有一個；點它＝跳到推文）
//   new：第一則新推文（new_comments.rowFor）
//   mention：提到我的推文；image：圖片
export function navMarks(analysis, total, newRow) {
  const n = Math.max(1, total | 0);
  const a = analysis || {};
  const marks = [];
  const at = (row) => Math.min(1, Math.max(0, row / n));
  const comments = a.comments || [];
  const commentRow = comments.length ? comments[0].row : null;
  if (commentRow != null) marks.push({ kind: 'comments', row: commentRow, f: at(commentRow) });
  if (newRow != null) marks.push({ kind: 'new', row: newRow, f: at(newRow) });
  (a.mentions || []).slice(0, MARK_LIMIT).forEach((c) => marks.push({ kind: 'mention', row: c.row, f: at(c.row) }));
  (a.images || []).slice(0, MARK_LIMIT).forEach((img) => marks.push({ kind: 'image', row: img.row, f: at(img.row) }));
  return { commentRow, marks };
}

// 軸的位置：終端機右緣、從 .main 頂到可見內容下緣（好讀 footer 上緣；推文列顯示中再扣列高）。
export function articleNavGeometry({ mainRect, footerTop, commentBarShown }) {
  if (!mainRect || !mainRect.width) return null;
  let bottom = footerTop != null ? Math.min(mainRect.bottom, footerTop) : mainRect.bottom;
  if (commentBarShown) bottom -= COMMENT_BAR_HEIGHT;
  const top = Math.max(0, mainRect.top);
  const height = Math.round(bottom - top);
  if (height < 80) return null;
  return { left: Math.round(mainRect.right - ARTICLE_NAV_WIDTH), top: Math.round(top), height };
}

const EMPTY = { commentRow: null, marks: [] };

export function ArticleNav(core) {
  this._core = core;
  this._listeners = new Set();
  this._lines = [];
  this._head = null;
  this._state = { visible: false, left: 0, top: 0, height: 0, mobile: false, total: 0, commentRow: null, marks: [] };
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

ArticleNav.prototype = {
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

  _inEasyArticle: function() {
    const core = this._core;
    const er = core.easyReading;
    const buf = core.buf;
    return !!(buf && buf.pageState === 3 && er && er._enabled && !er._functionMode && (buf.pageLines || []).length);
  },

  // 讀累積頁的新列（同 article_tools._syncLines：pageLines 只往後 concat，換文章／從頭重讀
  // 會整份換掉 ⇒ 首列變了或變短就重來）。回傳有沒有變。
  _syncLines: function() {
    const buf = this._core.buf;
    const acc = buf.pageLines || [];
    const head = acc.length ? buf.getRowText(0, 0, buf.cols, acc) : null;
    const inst = (this._core.view || {})._articleInstanceId;
    // 換文章的權威訊號是 view._articleInstanceId（accumulatePageLines 'rebuild' 分支 bump）：首列是
    // 「作者 … 看板 …」，同作者同看板的兩篇一字不差，下一篇又比上一篇長時首列與長度都認不出來。
    if (inst !== this._inst || head !== this._head || acc.length < this._lines.length) {
      this._lines = [];
      this._head = head;
    }
    this._inst = inst;
    if (acc.length === this._lines.length) return false;
    for (let r = this._lines.length; r < acc.length; ++r) this._lines.push(buf.getRowText(r, 0, buf.cols, acc));
    return true;
  },

  _geometry: function() {
    const core = this._core;
    const view = core.view;
    const main = view && view.mainDisplay;
    if (!main || typeof main.getBoundingClientRect !== 'function' || typeof window === 'undefined') return null;
    const footer = view.lastRowDiv;
    let footerTop = null;
    if (footer && typeof footer.getBoundingClientRect === 'function' && window.getComputedStyle(footer).display !== 'none')
      footerTop = footer.getBoundingClientRect().top;
    const bar = core.commentBar && core.commentBar.state;
    return articleNavGeometry({
      mainRect: main.getBoundingClientRect(),
      footerTop: footerTop,
      commentBarShown: !!(bar && bar.visible),
    });
  },

  refresh: function() {
    const core = this._core;
    if (!readEffectivePrefs().enableArticleNav || !this._inEasyArticle()) {
      if (this._state.visible) this._set({ visible: false });
      return;
    }
    const g = this._geometry();
    if (!g) {
      if (this._state.visible) this._set({ visible: false });
      return;
    }
    const changed = this._syncLines();
    const view = core.view || {};
    const selfId = view.highlightSelfComments ? view._selfId || null : null;
    const nc = core.newComments;
    const newRow = nc && typeof nc.rowFor === 'function' ? nc.rowFor(core.buf.pageLines || []) : null;
    const patch = { visible: true, left: g.left, top: g.top, height: g.height, mobile: !!core.mobile };
    if (changed || selfId !== this._selfId || newRow !== this._newRow || !this._state.visible) {
      this._selfId = selfId;
      this._newRow = newRow;
      const m = this._lines.length ? navMarks(analyzeArticle(this._lines, getImageProxyConfig(), selfId), this._lines.length, newRow) : EMPTY;
      Object.assign(patch, { total: this._lines.length, commentRow: m.commentRow, marks: m.marks });
    }
    this._set(patch);
  },

  // 跳到累積頁的第 row 列（好讀的視口，不送鍵）。
  jumpTo: function(row) {
    const er = this._core.easyReading;
    if (!er || typeof er.scrollToArticleRow !== 'function' || !this._inEasyArticle()) return false;
    return er.scrollToArticleRow(row);
  },

  // 拖曳／點軸：捲到累積頁的 f（0～1）處，讓那個位置落在視窗中間。
  scrollToFraction: function(f) {
    const view = this._core.view;
    const disp = view && view.mainDisplay;
    if (!disp || !this._inEasyArticle()) return false;
    const x = Math.min(1, Math.max(0, f));
    disp.scrollTop = Math.max(0, x * disp.scrollHeight - disp.clientHeight / 2);
    return true;
  },
};

export default ArticleNav;
