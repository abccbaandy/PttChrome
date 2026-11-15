// 手機文章內找字（P75，pref mobileFindInArticle，預設開；components/ArticleFind）。
//
// 手機 App（WebView）沒有瀏覽器的「在網頁中尋找」，長文、幾百則推文裡找一個詞只能一路滑。
// 好讀文章的「更多」多一顆「找字」：App Bar 下方一條找字列，打字即時標亮整篇符合處，上一個／
// 下一個把那一列捲到畫面中間。
//
// 三條線：
//   1. **一個 byte 都不送**：只讀畫面已經畫出來的列（#mainContainer 的 bbsline），不碰 PTT。
//   2. **不改終端機的渲染輸出**：標亮用 CSS Custom Highlight API（`CSS.highlights` ＋ Range），
//      由瀏覽器自己跟著版面畫，DOM 一個節點都不加、不改（render_dom_equivalence 的 golden 不受影響）。
//      瀏覽器沒有這個 API ⇒ 不標亮，計數與跳轉照常。
//   3. **找的是使用者看得到的字**：在畫面列的文字上找（推文、內文、標題都在），跨列不算（一列
//      一個字串）。好讀邊捲邊載、列被換掉 ⇒ MutationObserver 收到就重找（目前這個盡量留在同一處）。
//
// 只在手機好讀累積頁（view._renderedLines === buf.pageLines）或本機唯讀頁出現（同選取文字頁）；
// 離開文章（換了一篇、不在累積頁）就收起、標亮全清。
// 守護：tests/unit/article_find.test.js、offline e2e mobile_article_find.offline.spec.js。
import { readEffectivePrefs } from './pref_storage';
import { renderChunksAround } from '../render/screen_chunk';

export const FIND_HIGHLIGHT = 'pttFind';
export const FIND_CURRENT_HIGHLIGHT = 'pttFindCurrent';
// 好讀邊捲邊載時列會一批批換：等它停一下再重找。
export const RESCAN_DEBOUNCE_MS = 150;

// 畫面上的空白是 &nbsp;（U+00A0）：比對前一律換成一般空白，使用者打的空白才對得上。
function norm(s) {
  return String(s == null ? '' : s).replace(/ /g, ' ').toLowerCase();
}

// text 裡 query 出現的位置（不分大小寫、不重疊、照順序）。query 是空的（或只有空白）⇒ []。
export function findInText(text, query) {
  const q = norm(query);
  if (!q.trim()) return [];
  const t = norm(text);
  const out = [];
  let i = t.indexOf(q);
  while (i >= 0) {
    out.push(i);
    i = t.indexOf(q, i + q.length);
  }
  return out;
}

// 一列元素裡的文字節點與它們在整列字串裡的起點：[{ node, start }]，以及整列字串。
function rowTextNodes(rowEl) {
  const doc = rowEl.ownerDocument;
  const walker = doc.createTreeWalker(rowEl, 4 /* NodeFilter.SHOW_TEXT */);
  const nodes = [];
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n, start: text.length });
    text += n.nodeValue;
  }
  return { nodes: nodes, text: text };
}

// 整列字串的 offset → { node, offset }。end 為真時落在節點尾（Range 結尾用）。
function locate(nodes, pos, end) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const len = n.node.nodeValue.length;
    if (pos < n.start + len || (end && pos === n.start + len)) return { node: n.node, offset: pos - n.start };
  }
  const last = nodes[nodes.length - 1];
  return { node: last.node, offset: last.node.nodeValue.length };
}

// 被藏起來的列（黑名單推文等）不算：它們在 DOM 裡但使用者看不到。
function rowHidden(rowEl) {
  return !!(rowEl.closest && rowEl.closest('[hidden]'));
}

// container 裡所有畫面列的符合處：[{ rowEl, range }]，照畫面順序。
export function scanMatches(container, query) {
  if (!container || !norm(query).trim()) return [];
  const doc = container.ownerDocument;
  const rows = container.querySelectorAll('[data-type="bbsline"]');
  const out = [];
  for (let r = 0; r < rows.length; r++) {
    const rowEl = rows[r];
    if (rowHidden(rowEl)) continue;
    const { nodes, text } = rowTextNodes(rowEl);
    if (!nodes.length) continue;
    const hits = findInText(text, query);
    const qlen = norm(query).length;
    for (let h = 0; h < hits.length; h++) {
      const a = locate(nodes, hits[h], false);
      const b = locate(nodes, hits[h] + qlen, true);
      const range = doc.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      out.push({ rowEl: rowEl, range: range });
    }
  }
  return out;
}

// 重找之後目前這個要落在哪：同一列（同一個元素，或同 data-row）裡的第 k 個；那一列沒了 ⇒
// 第一個在它之後的；都沒有 ⇒ 0。prev＝{ rowEl, row, nth }。
export function carryIndex(matches, prev) {
  if (!matches.length) return -1;
  if (!prev) return 0;
  const same = [];
  for (let i = 0; i < matches.length; i++) {
    const el = matches[i].rowEl;
    if (el === prev.rowEl || (prev.row != null && el.getAttribute('data-row') === prev.row)) same.push(i);
  }
  if (same.length) return same[Math.min(prev.nth, same.length - 1)];
  return 0;
}

function highlightsApi() {
  const css = typeof CSS !== 'undefined' ? CSS : null;
  if (!css || !css.highlights || typeof Highlight === 'undefined') return null;
  return css.highlights;
}

export function ArticleFind(core) {
  this._core = core;
  this._listeners = new Set();
  this._state = { open: false, query: '', total: 0, index: -1 };
  this._matches = [];
  this._observer = null;
  this._timer = null;
  this._articleId = null;
  const self = this;
  if (core && core.buf && core.buf.addEventListener)
    core.buf.addEventListener(
      'screenSettled',
      function() {
        return self._onSettled();
      },
      { feature: 'mobileFindInArticle', disable: () => self.close() }
    );
}

ArticleFind.prototype = {
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

  // 好讀累積頁或本機唯讀頁才有（同 select_text_page._source）。
  _onArticlePage: function() {
    const core = this._core;
    const view = core && core.view;
    const buf = view && view.buf;
    if (!view || !buf) return false;
    const lines = view._renderedLines;
    if (!lines || !lines.length) return false;
    return lines === buf.pageLines || (!!view._staticRows && lines === view._staticRows);
  },

  _container: function() {
    const view = this._core && this._core.view;
    return (view && view.mainDisplay) || (typeof document !== 'undefined' ? document.getElementById('mainContainer') : null);
  },

  // 入口要不要出現（開「更多」那一刻算）。
  available: function() {
    const core = this._core;
    if (!core || !core.mobile) return false;
    if (!readEffectivePrefs().mobileFindInArticle) return false;
    return this._onArticlePage();
  },

  open: function() {
    if (this._state.open) return true;
    if (!this.available()) return false;
    const view = this._core.view;
    this._articleId = view ? view._articleInstanceId : null;
    this._set({ open: true, query: '', total: 0, index: -1 });
    this._watch();
    return true;
  },

  close: function() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    if (this._observer) this._observer.disconnect();
    this._observer = null;
    this._matches = [];
    this._paint();
    if (this._state.open) this._set({ open: false, query: '', total: 0, index: -1 });
  },

  setQuery: function(q) {
    if (!this._state.open) return;
    this._state = Object.assign({}, this._state, { query: String(q || '') });
    this._rescan(null, true);
  },

  next: function() {
    this._step(1);
  },

  prev: function() {
    this._step(-1);
  },

  _step: function(d) {
    const n = this._matches.length;
    if (!this._state.open || !n) return;
    const i = this._state.index < 0 ? 0 : (this._state.index + d + n) % n;
    this._set({ index: i });
    this._paint();
    this._reveal(i);
  },

  // 離開文章（換了一篇、不在累積頁）⇒ 收起。
  _onSettled: function() {
    if (!this._state.open) return;
    const view = this._core && this._core.view;
    const changed = view && view._articleInstanceId !== this._articleId;
    if (!this._onArticlePage() || changed) this.close();
  },

  _watch: function() {
    const el = this._container();
    if (!el || typeof MutationObserver === 'undefined') return;
    const self = this;
    this._observer = new MutationObserver(function() {
      if (self._timer) clearTimeout(self._timer);
      self._timer = setTimeout(function() {
        self._timer = null;
        if (self._state.open) self._rescan(self._currentRef(), false);
      }, RESCAN_DEBOUNCE_MS);
    });
    this._observer.observe(el, { childList: true, subtree: true, characterData: true });
  },

  // 目前這個是哪一列的第幾個（重找後用它找回同一處）。
  _currentRef: function() {
    const i = this._state.index;
    const m = this._matches[i];
    if (!m) return null;
    let nth = 0;
    for (let j = i - 1; j >= 0 && this._matches[j].rowEl === m.rowEl; j--) nth++;
    return { rowEl: m.rowEl, row: m.rowEl.getAttribute('data-row'), nth: nth };
  },

  // reveal：使用者剛打字 ⇒ 跳到第一個；版面變動重找 ⇒ 不捲（使用者可能正在滑）。
  _rescan: function(prev, reveal) {
    this._matches = scanMatches(this._container(), this._state.query);
    const index = carryIndex(this._matches, prev);
    this._set({ total: this._matches.length, index: index, query: this._state.query });
    this._paint();
    if (reveal && index >= 0) this._reveal(index);
  },

  _paint: function() {
    const hl = highlightsApi();
    if (!hl) return;
    hl.delete(FIND_HIGHLIGHT);
    hl.delete(FIND_CURRENT_HIGHLIGHT);
    if (!this._matches.length) return;
    const cur = this._matches[this._state.index];
    const rest = this._matches.filter((m) => m !== cur).map((m) => m.range);
    if (rest.length) hl.set(FIND_HIGHLIGHT, new Highlight(...rest));
    if (cur) hl.set(FIND_CURRENT_HIGHLIGHT, new Highlight(cur.range));
  },

  // 那一列捲到畫面中間。分塊裡的列先叫它的塊照常渲染，量到的才是真位置（screen_chunk）。
  _reveal: function(i) {
    const m = this._matches[i];
    if (!m || !m.rowEl.isConnected) return;
    renderChunksAround(m.rowEl);
    if (typeof m.rowEl.scrollIntoView === 'function') m.rowEl.scrollIntoView({ block: 'center' });
  },
};

export default ArticleFind;
