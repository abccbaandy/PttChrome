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
//   4. **它就是這一頁的捲軸**：顯示中 `.main` 掛 ARTICLE_NAV_ON_CLASS，原生捲軸整個不畫
//      （main.css），右緣不會有兩條；內容超出時再掛 ARTICLE_NAV_GUTTER_CLASS 補回捲軸的寬度
//      （_syncGutter）。標記與滑塊用同一把尺（像素位置 / scrollHeight）。
import { analyzeArticle } from './article_tools';
import { getImageProxyConfig } from './image_proxy';
import { readEffectivePrefs } from './pref_storage';
import { COMMENT_BAR_HEIGHT, commentBarHeight } from './comment_bar';
import { offsetTopWithin } from './scroll_anchor';
import { isScreenChunk, isChunkRendered } from '../render/screen_chunk';
import { PAGE_STATE } from './screen_model';

export const ARTICLE_NAV_ID = 'articleNav';
// 顯示中掛在 `.main` 上：原生捲軸隱形（main.css）。
export const ARTICLE_NAV_ON_CLASS = 'articleNavOn';
// 顯示中而且內容超出（原本會有原生捲軸）時再掛：padding-right 補回捲軸佔的寬度（main.css）。
export const ARTICLE_NAV_GUTTER_CLASS = 'articleNavGutter';
// 軸的寬度（可點範圍，CSS px）。看得到的只有中間一條細線。
export const ARTICLE_NAV_WIDTH = 14;
// 一種標記最多畫幾個（幾千則推文的文章：再多也只是糊成一條）。
const MARK_LIMIT = 300;
// 標記那一列沒有自己的節點（黑名單整列移除、併進合併塊、手機收起來的列）時，前後找幾列。
const LOOKAROUND = 24;

export function isArticleNavTarget(el) {
  return !!(el && typeof el.closest === 'function' && el.closest('#' + ARTICLE_NAV_ID));
}

// 累積頁的分析結果 → 軸上的標記（純函式）。f ＝在累積頁裡的位置（0～1）：這裡先給列號 /
// 總列數，畫出來之後 ArticleNav._measure 換成像素位置（行內圖片讓列高極不均，列號比例跟
// 滑塊對不上）。
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

// 軸的位置：終端機右緣、從 .main 頂到可見內容下緣（好讀 footer 上緣；推文列顯示中再扣列高，
// 打字中列會長高 ⇒ 給 commentBarHeight 量到的高度，沒給就當單行高）。
export function articleNavGeometry({ mainRect, footerTop, commentBarShown, commentBarHeight: barH }) {
  if (!mainRect || !mainRect.width) return null;
  let bottom = footerTop != null ? Math.min(mainRect.bottom, footerTop) : mainRect.bottom;
  if (commentBarShown) bottom -= barH || COMMENT_BAR_HEIGHT;
  const top = Math.max(0, mainRect.top);
  const height = Math.round(bottom - top);
  if (height < 80) return null;
  return { left: Math.round(mainRect.right - ARTICLE_NAV_WIDTH), top: Math.round(top), height };
}

// 頂層列節點在 scroller 內容裡的頂端（px，offsetTop 系，不含 transform，同滑塊的 scrollTop）。
// 閉塊（長頁分塊，render/screen_chunk.js）裡的節點不量 —— 會逼瀏覽器當場排版整塊 —— 以塊的
// 位置＋節點在塊裡的序位比例估；塊照常渲染之後（捲近／點「推」跳過去），下一次量測就是真位置。
// 沒有版面（display:none）回 null。
export function nodeTopWithin(node, scroller) {
  const chunk = node.parentNode;
  if (isScreenChunk(chunk) && !isChunkRendered(chunk)) {
    const kids = chunk.children;
    const i = Math.max(0, Array.prototype.indexOf.call(kids, node));
    return offsetTopWithin(chunk, scroller) + (chunk.offsetHeight * i) / Math.max(1, kids.length);
  }
  if (node.offsetParent === null) return null;
  return offsetTopWithin(node, scroller);
}

// 累積頁第 row 列的頂端（px）。那一列沒有自己的節點時：前面最近的是合併塊（div，不是單列
// span）⇒ 它在塊裡，取塊頂；否則（黑名單整列移除）取後面最近一列（同 _scrollToPageRow）。
// 量不到（上一幀畫的不是這份 lines）回 null。
export function rowTopWithin(screen, lines, row, scroller) {
  const node = screen.rowNode(row, lines);
  if (node === undefined) return null;
  if (node) {
    const top = nodeTopWithin(node, scroller);
    if (top != null) return top;
  }
  for (let r = row - 1; !node && r >= Math.max(0, row - LOOKAROUND); --r) {
    const prev = screen.rowNode(r, lines);
    if (!prev) continue;
    if (prev.getAttribute('type') !== 'bbsrow') return nodeTopWithin(prev, scroller);
    break;
  }
  const end = Math.min(lines.length, row + LOOKAROUND);
  for (let r = row + 1; r < end; ++r) {
    const next = screen.rowNode(r, lines);
    if (!next) continue;
    const top = nodeTopWithin(next, scroller);
    if (top != null) return top;
  }
  return null;
}

const EMPTY = { commentRow: null, marks: [] };

export function ArticleNav(core) {
  this._core = core;
  this._listeners = new Set();
  this._lines = [];
  this._head = null;
  this._state = { visible: false, left: 0, top: 0, height: 0, mobile: false, total: 0, commentRow: null, marks: [] };
  const self = this;
  this._onSettle = function() {
    self.refresh();
  };
  if (core.buf && core.buf.addEventListener)
    core.buf.addEventListener(
      'screenSettled',
      this._onSettle,
      // 出錯 ⇒ 這次連線收起導覽軸（原生捲軸跟著回來），不再接 settle（event.js 故障隔離）。
      { feature: 'enableArticleNav', disable: () => self._set({ visible: false }) }
    );
  if (typeof window !== 'undefined' && window.addEventListener)
    window.addEventListener('resize', function() {
      self.refresh();
    });
  // 推文列出現／收起／打字中長高 ⇒ 軸的下緣跟著讓位（onChange 會先給一次現況，那次跳過）。
  const bar = core.commentBar;
  if (bar && typeof bar.onChange === 'function') {
    let barH = null;
    bar.onChange(function(s) {
      const h = commentBarHeight(s);
      if (barH !== null && h !== barH) self.refresh();
      barH = h;
    });
  }
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
    if (next.visible !== this._state.visible) {
      const disp = (this._core.view || {}).mainDisplay;
      if (disp && disp.classList) {
        disp.classList.toggle(ARTICLE_NAV_ON_CLASS, next.visible);
        if (next.visible) this._syncGutter();
        else disp.classList.remove(ARTICLE_NAV_GUTTER_CLASS);
      }
    }
    this._state = next;
    this._listeners.forEach(function(fn) {
      fn(next);
    });
  },

  _inEasyArticle: function() {
    const core = this._core;
    const er = core.easyReading;
    const buf = core.buf;
    return !!(buf && buf.pageState === PAGE_STATE.READING && er && er._enabled && !er._functionMode && (buf.pageLines || []).length);
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
      this._measured = null;
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
      commentBarHeight: commentBarHeight(bar),
    });
  },

  refresh: function() {
    const core = this._core;
    // 出錯被停用（event.js 故障隔離）⇒ resize／推文列這些入口也不准把軸叫回來，新連線才恢復。
    const buf = core.buf;
    if (buf && typeof buf.isListenerDisabled === 'function' && buf.isListenerDisabled(this._onSettle)) {
      if (this._state.visible) this._set({ visible: false });
      return;
    }
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
      // 同一篇裡還在的標記沿用上次量到的像素位置（不然每補一頁都先跳回列號比例、下一幀才回來）。
      const measured = (this._state.visible && this._measured) || new Map();
      const marks = m.marks.map((x) => (measured.has(x.kind + ':' + x.row) ? Object.assign({}, x, { f: measured.get(x.kind + ':' + x.row) }) : x));
      Object.assign(patch, { total: this._lines.length, commentRow: m.commentRow, marks: marks });
    }
    this._set(patch);
    this._watch();
    this._scheduleMeasure();
  },

  // 標記位置會跟著版面變（圖片載入、閉塊照常渲染後換成實測高度、放大縮小），而那些都不經
  // settle ⇒ 內容尺寸變化時重量（ResizeObserver，rAF 合併）。控制器跟 app 同壽，不必拆。
  // 閉塊捲近變成照常渲染（CHUNK_NEAR_CLASS）時，塊內標記從「塊頂＋序位估」換成真位置，
  // 塊高不一定變 ⇒ 另外看塊的 class（MutationObserver，只在跨過預載邊界時觸發）。
  // **不掛 scroll**：捲動本身不改任何列的像素位置，每幀重量所有標記是白做（實機約 2.5 ms／幀，
  // docs/handoff/android-battery-drain.md U8；守護 tests/unit/article_nav_scroll_cost.test.jsx）。
  _watch: function() {
    const view = this._core.view || {};
    const disp = view.mainDisplay;
    if (this._watching || !disp || typeof disp.addEventListener !== 'function') return;
    this._watching = true;
    const self = this;
    const kick = function() {
      if (self._state.visible) self._scheduleMeasure();
    };
    if (view.mainContainer && typeof ResizeObserver === 'function') new ResizeObserver(kick).observe(view.mainContainer);
    if (view.mainContainer && typeof MutationObserver === 'function') {
      new MutationObserver(function(records) {
        for (let i = 0; i < records.length; ++i) {
          if (isScreenChunk(records[i].target)) return kick();
        }
      }).observe(view.mainContainer, { subtree: true, attributes: true, attributeFilter: ['class'] });
    }
  },

  _scheduleMeasure: function() {
    if (this._measureRaf || typeof requestAnimationFrame !== 'function') return;
    const self = this;
    this._measureRaf = requestAnimationFrame(function() {
      self._measureRaf = 0;
      if (self._state.visible) self._syncGutter();
      self._measure();
    });
  },

  // 原生捲軸只在內容超出時才佔寬（overflow-y:auto）⇒ 補寬度也只在超出時補，短文不能憑空
  // 窄 10px。判斷一律在「補了寬度」的版面上量：補了寬度內容只會更高，補了還放得下才拿掉
  // （同瀏覽器「不加捲軸放得下就不加」的方向，而且不會在邊界來回切）。內容尺寸變了由
  // ResizeObserver 經 _scheduleMeasure 再判一次；只在那時候強制排版，捲動時不會跑。
  _syncGutter: function() {
    const disp = (this._core.view || {}).mainDisplay;
    if (!disp || !disp.classList) return;
    disp.classList.add(ARTICLE_NAV_GUTTER_CLASS);
    if (!(disp.scrollHeight > disp.clientHeight)) disp.classList.remove(ARTICLE_NAV_GUTTER_CLASS);
  },

  // 標記換成像素尺：該列在 .main 內容裡的頂端 / scrollHeight —— 與滑塊（scrollTop /
  // scrollHeight）同一把尺。列號 / 總列數在有行內圖片的文章差一大截（圖片那一列幾百 px）。
  // 量不到（還沒畫、假 view）就留著 navMarks 的列號比例。
  _measure: function() {
    const s = this._state;
    const view = this._core.view;
    const disp = view && view.mainDisplay;
    const screen = view && view.componentScreen;
    if (!s.visible || !s.marks.length || !disp || !screen || typeof screen.rowNode !== 'function') return;
    const h = disp.scrollHeight;
    if (!h) return;
    const lines = this._core.buf.pageLines || [];
    let changed = false;
    const marks = s.marks.map(function(m) {
      const top = rowTopWithin(screen, lines, m.row, disp);
      if (top == null) return m;
      const f = Math.min(1, Math.max(0, top / h));
      if (Math.abs(f - m.f) < 1e-4) return m;
      changed = true;
      return Object.assign({}, m, { f: f });
    });
    if (!changed) return;
    this._measured = new Map(marks.map((x) => [x.kind + ':' + x.row, x.f]));
    this._set({ marks: marks });
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
