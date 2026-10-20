// 讀完接著讀下一篇（pref enableNextArticleCard，預設開）：好讀文章讀到文末，最後一則推文
// 下面留一段空白，再放一張「下一篇」的標題卡（標題、推文數、作者，取自列表快照）。點它才
// 換文，**捲到底不會自己換**（怕看不到最底部的推文）。設計見 docs/next-article.md —— 改這支
// 之前先讀它。
//
// 三條規則：
//   1. **下一篇＝列表順序的下一列**：原生「看完按空白」是 read.c 的 crs_ln + 1，不是「下一篇
//      新文」。所以卡片只認列表快照裡編號正好接在這篇後面的那一列（被刪的跳過）；沒看過那一
//      列（還沒載入的頁）、或這篇是最後一篇（下一列是沒有編號的置底文）⇒ 不出現。搜尋結果／
//      文摘是另一個編號空間 ⇒ 從那裡進的文章不出現。
//   2. **換文＝原生鍵**：aid_navigation.startNum（與雙欄閱讀同一條：s<板>⏎ → <編號>⏎ → ⏎，
//      每步依畫面驗證），落地後再比一次作者＋主題，不符就提示，人留在 PTT 給的畫面。
//   3. **不寫 #mainContainer**：卡片是 `.main`（好讀的捲動容器）裡、#screenRoot 後面的獨立
//      節點，跟著文末一起捲；核心渲染鏈不知道它存在。

import { isArticleListTitleRow } from './screen_titles';
import { isArticleListFooter } from './screen_captions';
import { listPageOf, mergeSnapshot, sameBoard, findCurrentNum } from './split_reader';
import { subjectKey, subjectMatches } from './long_push_anchor';
import { serializedOpHint } from './serialized_op_gate';
import { readEffectivePrefs } from './pref_storage';
import { recordFor } from './reading_record';
import { HINT_ERROR } from './status_hint';
import { i18n } from './i18n';

export const NEXT_ARTICLE_ID = 'nextArticleCard';
// 換文整段的上限（同雙欄閱讀）。
const NAV_WATCHDOG_MS = 45000;

// ---------------------------------------------------------------------------
// 純判讀（tests/unit/next_article.test.js）
// ---------------------------------------------------------------------------

// 快照裡接在 num 後面的那一篇：編號要連續（中間缺一號＝那一列沒看過，不知道是什麼），
// 被刪的跳過。找不到 ⇒ null。
export function nextEntryAfter(entries, num) {
  if (!entries || !entries.length || num == null) return null;
  const byNum = new Map();
  for (const e of entries) byNum.set(e.num, e);
  for (let n = num + 1; byNum.has(n); n++) {
    const e = byNum.get(n);
    if (!e.deleted) return e;
  }
  return null;
}

// 落地的文章是不是卡片上那一篇（作者＋主題，列表主題可能被截成 …）。
export function landedOn(entry, article) {
  if (!entry || !article || !article.author) return false;
  if (String(entry.author).toLowerCase() !== String(article.author).toLowerCase()) return false;
  const subject = subjectKey(article.title);
  return !!(subject && entry.subject && subjectMatches(entry.subject, subject));
}

function enabled() {
  return !!readEffectivePrefs().enableNextArticleCard;
}

// ---------------------------------------------------------------------------
// 控制器
// ---------------------------------------------------------------------------

export function NextArticle(core) {
  this._core = core;
  this._snapshot = null; // { board, entries }
  this._lastList = null; // { board, mode, cursorNum }
  this._nav = null; // { entry, timer }
  this._el = null;
  this._state = { visible: false, entry: null, pending: false };
  const self = this;
  if (core.buf && core.buf.addEventListener)
    core.buf.addEventListener('screenSettled', function() {
      self._onSettled();
    });
}

NextArticle.prototype = {
  get state() {
    return this._state;
  },

  _set: function(patch) {
    const next = Object.assign({}, this._state, patch);
    if (Object.keys(patch).every((k) => next[k] === this._state[k])) return;
    this._state = next;
    this._render();
  },

  _hint: function(msg, ms, level) {
    const view = this._core.view;
    if (view && view.flashListHint) view.flashListHint(msg, ms || 3000, level);
  },

  _hide: function() {
    if (this._state.visible) this._set({ visible: false });
  },

  _wireBusy: function() {
    const core = this._core;
    if (serializedOpHint(core)) return true;
    if (core.commandQueue && !core.commandQueue.idle) return true;
    return false;
  },

  _inEasyArticleEnd: function() {
    const core = this._core;
    const er = core.easyReading;
    const buf = core.buf;
    return !!(
      buf &&
      buf.pageState === 3 &&
      er &&
      er._enabled &&
      !er._functionMode &&
      !er._reverse &&
      er.easyReadingReachedPageEnd &&
      (buf.pageLines || []).length
    );
  },

  _onSettled: function() {
    const core = this._core;
    const buf = core.buf;
    if (!buf || typeof buf.getRowText !== 'function') return;
    if (!enabled()) {
      this._hide();
      return;
    }
    const rows = buf.rows;
    const row0 = buf.getRowText(0, 0, buf.cols);
    const last = buf.getRowText(rows - 1, 0, buf.cols);
    if (isArticleListTitleRow(row0) && isArticleListFooter(last)) {
      const rowTexts = [];
      for (let r = 0; r < rows; ++r) rowTexts.push(r === 0 ? row0 : r === rows - 1 ? last : buf.getRowText(r, 0, buf.cols));
      const page = listPageOf(rowTexts, buf.cur_y);
      if (page) {
        this._lastList = { board: page.board, mode: page.mode, cursorNum: page.cursorNum };
        if (page.mode === 'plain') this._snapshot = mergeSnapshot(this._snapshot, page);
      }
      this._hide();
      return;
    }
    if (this._nav || !this._inEasyArticleEnd()) {
      this._hide();
      return;
    }
    const view = core.view || {};
    const board = view._articleBoard;
    const snap = this._snapshot;
    const list = this._lastList;
    if (!board || !snap || !list || list.mode !== 'plain' || !sameBoard(list.board, board) || !sameBoard(snap.board, board)) {
      this._hide();
      return;
    }
    const current = findCurrentNum(snap.entries, { author: view._articleAuthor, title: view._articleTitle }, list.cursorNum);
    const entry = current == null ? null : nextEntryAfter(snap.entries, current);
    if (!entry) {
      this._hide();
      return;
    }
    this._set({ visible: true, entry: entry, pending: false });
  },

  open: function() {
    const core = this._core;
    const st = this._state;
    const entry = st.entry;
    if (!st.visible || !entry || this._nav || !this._snapshot) return false;
    const nav = core.aidNavigation;
    const busy = serializedOpHint(core);
    if (busy || this._wireBusy() || !nav || typeof nav.startNum !== 'function') {
      if (busy) this._hint(busy, 2500, HINT_ERROR);
      return false;
    }
    const rr = recordFor(core);
    const bm = rr.begin('next-article');
    const self = this;
    const board = this._snapshot.board;
    const done = function(result) {
      if (!self._nav || self._nav.entry !== entry) return;
      clearTimeout(self._nav.timer);
      self._nav = null;
      const ok = !!(result && result.ok);
      rr.end(bm, ok ? 'done' : 'fail');
      self._set({ pending: false });
      if (!ok) return;
      if (self._lastList) self._lastList = Object.assign({}, self._lastList, { cursorNum: entry.num });
      const view = core.view || {};
      if (!landedOn(entry, { author: view._articleAuthor, title: view._articleTitle }))
        self._hint(i18n('next_article_mismatch'), 4000, HINT_ERROR);
    };
    this._nav = {
      entry: entry,
      timer: setTimeout(function() {
        done({ ok: false });
      }, NAV_WATCHDOG_MS)
    };
    this._set({ pending: true });
    if (!nav.startNum(board, entry.num, done)) {
      clearTimeout(this._nav.timer);
      this._nav = null;
      rr.end(bm, 'cancel');
      this._set({ pending: false });
      return false;
    }
    return true;
  },

  // 卡片 DOM：第一次要顯示時才建，放在 .main 裡 #screenRoot 的後面。
  _ensureEl: function() {
    if (this._el) return this._el;
    const view = this._core.view;
    const main = view && view.mainDisplay;
    if (!main || typeof document === 'undefined') return null;
    const el = document.createElement('button');
    el.type = 'button';
    el.id = NEXT_ARTICLE_ID;
    el.hidden = true;
    const label = document.createElement('span');
    label.className = 'nextArticleLabel';
    const title = document.createElement('span');
    title.className = 'nextArticleTitle';
    const meta = document.createElement('span');
    meta.className = 'nextArticleMeta';
    el.append(label, title, meta);
    const self = this;
    // 不搶 #t 的焦點（鍵盤照常操作文章）；App 的滑鼠入口在 window ⇒ 一律不往上傳。
    el.addEventListener('mousedown', function(e) {
      e.preventDefault();
      e.stopPropagation();
    });
    el.addEventListener('mouseup', function(e) {
      e.stopPropagation();
    });
    el.addEventListener('click', function(e) {
      e.stopPropagation();
      self.open();
    });
    const anchor = view.screenRoot && view.screenRoot.parentNode === main ? view.screenRoot.nextSibling : null;
    main.insertBefore(el, anchor);
    // reading_record 量「捲到文末了沒」要扣掉這張卡（trailingPx）。
    view.nextArticleCard = el;
    this._el = el;
    return el;
  },

  _render: function() {
    const st = this._state;
    if (!st.visible) {
      if (this._el) this._el.hidden = true;
      return;
    }
    const el = this._ensureEl();
    if (!el) return;
    const e = st.entry;
    const [label, title, meta] = el.children;
    label.textContent = st.pending ? i18n('next_article_opening') : i18n('next_article_label');
    title.textContent = (e.recommend ? e.recommend + ' ' : '') + e.title;
    const date = (e.date || '').trim();
    meta.textContent = e.author + (date ? ' · ' + date : '');
    if (st.pending) el.setAttribute('data-pending', '');
    else el.removeAttribute('data-pending');
    el.hidden = false;
  }
};

export function isNextArticleTarget(el) {
  return !!(el && typeof el.closest === 'function' && el.closest('#' + NEXT_ARTICLE_ID));
}

export default NextArticle;
