// 讀完接著讀下一篇（pref enableNextArticleCard，預設開）：好讀文章讀到文末，最後一則推文
// 下面留一段空白，再放一張「下一篇」的標題卡（標題、推文數、作者，取自列表快照）。點它才
// 換文，**捲到底不會自己換**（怕看不到最底部的推文）。設計見 docs/next-article.md —— 改這支
// 之前先讀它。
//
// 三條規則：
//   1. **下一篇＝列表順序的下一列**：原生「看完按空白」是 read.c 的 crs_ln + 1，不是「下一篇
//      新文」。所以卡片只認列表快照裡編號正好接在這篇後面的那一列（被刪的跳過）；沒看過那一
//      列（還沒載入的頁）、或這篇是最後一篇（下一列是沒有編號的置底文）⇒ 不出現。搜尋結果／
//      文摘是另一個編號空間（read.c MODE_SELECT 重新編號）⇒ 另留一份快照，下一篇是結果的
//      下一筆（同原生）。
//   2. **換文＝原生鍵**：完整列表走 aid_navigation.startNum（與雙欄閱讀同一條：s<板>⏎ →
//      <編號>⏎ → ⏎），搜尋結果走 startSubNum（← 回同一份結果 → <編號>⏎ → 游標那列認得出
//      才 ⏎），每步依畫面驗證；落地後再比一次作者＋主題，不符就提示，人留在 PTT 給的畫面。
//   3. **不寫 #mainContainer**：卡片是 `.main`（好讀的捲動容器）裡、#screenRoot 後面的獨立
//      節點，跟著文末一起捲；核心渲染鏈不知道它存在。換文途中蓋住原生鏡像的遮罩
//      （#nextArticleVeil）也一樣：body 底下 fixed 對齊 `.main`，不碰終端機的任何節點。
//
// 認得出這篇、卻沒有下一篇時，卡片換成「已無下一篇」（列表到底了）或「已到文末」（下一篇
// 在還沒看過的列表頁），不能點 —— 讓人知道功能還在，只是這裡沒得接。

import { isArticleListTitleRow } from './screen_titles';
import { isArticleListFooter } from './screen_captions';
import { listPageOf, listEntryOf, mergeSnapshot, sameBoard, findCurrentNum, cursorHintFresh } from './split_reader';
import { subjectKey, subjectMatches } from './long_push_anchor';
import { hiddenReason, listFilterOf } from './list_row_filter';
import { serializedOpHint } from './serialized_op_gate';
import { readEffectivePrefs } from './pref_storage';
import { recordFor } from './reading_record';
import { HINT_ERROR } from './status_hint';
import { i18n } from './i18n';

export const NEXT_ARTICLE_ID = 'nextArticleCard';
export const NEXT_ARTICLE_VEIL_ID = 'nextArticleVeil';
// 換文整段的上限（同雙欄閱讀）。
const NAV_WATCHDOG_MS = 45000;
// 換文成功後，遮罩最多等好讀把新文章畫出來這麼久（ensureEnabledOnArticle 可能延到下一次
// settle 才接手）；逾時照樣拿掉，寧可閃一下原生也不要蓋著畫面。
const VEIL_RELEASE_MAX_MS = 2500;
// 遮罩淡出的時間（CSS transition 同值）。
const VEIL_FADE_MS = 180;

// ---------------------------------------------------------------------------
// 純判讀（tests/unit/next_article.test.js）
// ---------------------------------------------------------------------------

// 快照裡接在 num 後面的那一篇：編號要連續（中間缺一號＝那一列沒看過，不知道是什麼），
// 列表好讀會藏起來的列（被刪、鎖文、黑名單：list_row_filter#hiddenReason，判準同列表上
// 看到的）跳過。filter＝listFilterOf(view)；skipped 有給就把跳過的 { num, why } 推進去
// （錄製檔 log 用）。找不到 ⇒ null。
export function nextEntryAfter(entries, num, filter, skipped) {
  if (!entries || !entries.length || num == null) return null;
  const byNum = new Map();
  for (const e of entries) byNum.set(e.num, e);
  const f = filter || {};
  for (let n = num + 1; byNum.has(n); n++) {
    const e = byNum.get(n);
    const why = e.deleted ? 'deleted' : e.text ? hiddenReason(e.text, f.blacklist, f.titleKeywords) : null;
    if (!why) return e;
    if (skipped) skipped.push({ num: n, why: why });
  }
  return null;
}

// nextEntryAfter 找不到時，是不是因為這篇之後列表就結束了（endNum＝快照看到的列表盡頭，
// split_reader#listPageOf）：從下一號到盡頭每一號都看過（而且都被跳過）⇒ 真的沒有下一篇。
// 中間缺號、或沒看過盡頭 ⇒ false（不知道，是還沒載入的頁）。
export function listEndsAfter(entries, num, endNum) {
  if (!entries || num == null || endNum == null || num > endNum) return false;
  const seen = new Set();
  for (const e of entries) seen.add(e.num);
  for (let n = num + 1; n <= endNum; n++) if (!seen.has(n)) return false;
  return true;
}

// 落地的文章是不是卡片上那一篇（作者＋主題，列表主題可能被截成 …）。檔頭主題對不上也
// 可能是同一篇：PTT 的 T（bbs.c edit_title）只改 .DIR、不改文章檔頭 ⇒ 這時改比 seen（換文
// 途中 `<編號>⏎` 之後列表上游標停的那一列）：列表對列表，改過的標題兩邊一樣。
export function landedOn(entry, article, seen) {
  if (!entry || !article || !article.author) return false;
  const author = String(entry.author).toLowerCase();
  if (author !== String(article.author).toLowerCase()) return false;
  const subject = subjectKey(article.title);
  if (subject && entry.subject && subjectMatches(entry.subject, subject)) return true;
  return !!(
    seen &&
    String(seen.author).toLowerCase() === author &&
    seen.subject &&
    entry.subject &&
    subjectMatches(seen.subject, entry.subject)
  );
}

// 快照裡同一個編號的兩列是不是同一篇（列表對列表：作者＋主題）。
export function sameListEntry(a, b) {
  return !!(
    a &&
    b &&
    String(a.author).toLowerCase() === String(b.author).toLowerCase() &&
    a.subject &&
    b.subject &&
    subjectMatches(a.subject, b.subject)
  );
}

// 搜尋結果的快照：編號是這一次搜尋自己的空間，換了條件（再搜一次、增加條件）同一個編號
// 就是別篇 ⇒ 新的一頁與舊快照有任何一號對不上（兩邊都不是被刪的）就整份換掉，不混用。
// 畫面上看不出搜尋條件，所以只能這樣認；漏認的由換文時的 verify（游標那列）擋下。
export function mergeSubSnapshot(prev, page) {
  if (prev && sameBoard(prev.board, page.board)) {
    const byNum = new Map();
    for (const e of prev.entries) byNum.set(e.num, e);
    for (const e of page.entries) {
      const old = byNum.get(e.num);
      if (old && !old.deleted && !e.deleted && !sameListEntry(old, e)) return mergeSnapshot(null, page);
    }
  }
  return mergeSnapshot(prev, page);
}

function enabled() {
  return !!readEffectivePrefs().enableNextArticleCard;
}

// ---------------------------------------------------------------------------
// 控制器
// ---------------------------------------------------------------------------

export function NextArticle(core) {
  this._core = core;
  this._snapshot = null; // { board, entries }：完整列表
  this._subSnapshot = null; // { board, entries }：搜尋結果／文摘（mergeSubSnapshot）
  this._lastList = null; // { board, mode, cursorNum, articleKey }（articleKey 見 split_reader.cursorHintFresh）
  this._nav = null; // { entry, timer, seen }：seen＝換文途中列表上游標停在 entry.num 的那一列
  this._pickMode = null; // 卡片上那篇取自哪份快照：'plain' | 'select'
  this._el = null;
  this._lastPickRec = null; // _logPick 的去重：同一個錄製器、同一個結果只記一次
  this._lastPickKey = null;
  this._veil = null; // 遮罩 DOM（第一次換文時才建）
  this._veilWait = null; // 換文成功、等新文章畫出來再拿掉遮罩：{ timer }
  this._veilFade = null; // 淡出中的 timer
  // entry：下一篇；null 而 visible ⇒ 終點卡，end＝'last'（列表到底）｜'unknown'（下一篇沒看過）。
  // pull／progress：往下拉的進度（pull_next_article.js），pull＝null｜'pull'｜'armed'（手機
  // 觸控）｜'wheel'（桌機滾輪），progress＝0..1；只改卡片的字與進度條。
  this._state = { visible: false, entry: null, end: null, pending: false, pull: null, progress: null };
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
    if (this._state.visible) this._set({ visible: false, pull: null, progress: null });
  },

  // 往下拉的進度（pull_next_article.js）：卡片的字改成「再往上拉」／「放開開啟」／「繼續往下
  // 捲」，progress（0..1）畫成卡片底下的進度條。終點卡（沒有下一篇）不接。
  setPull: function(pull, progress) {
    const p = pull === 'pull' || pull === 'armed' || pull === 'wheel' ? pull : null;
    if (p && (!this._state.visible || !this._state.entry)) return;
    const n = p && typeof progress === 'number' ? Math.round(Math.max(0, Math.min(1, progress)) * 100) / 100 : null;
    this._set({ pull: p, progress: n });
  },

  _wireBusy: function() {
    const core = this._core;
    if (serializedOpHint(core)) return true;
    if (core.commandQueue && !core.commandQueue.idle) return true;
    return false;
  },

  // 錄製檔：卡片挑了哪一篇、跳過了哪些（why＝list_row_filter#hiddenReason）。每次文章 settle
  // 都會走到 ⇒ 結果沒變就不重記。
  _logPick: function(current, entry, skipped) {
    const rec = this._core.debugRecorder;
    if (!rec) return;
    const info = { current: current, next: entry ? entry.num : null, skipped: skipped };
    const key = JSON.stringify(info);
    if (rec === this._lastPickRec && key === this._lastPickKey) return;
    this._lastPickRec = rec;
    this._lastPickKey = key;
    rec.log('nextArticle.pick', info);
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
    this._maybeReleaseVeil();
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
        if (page.mode === 'plain') {
          this._snapshot = mergeSnapshot(this._snapshot, page);
          // 離開過搜尋結果：下一次的結果可能是別的條件，不留舊的。
          if (!this._nav) this._subSnapshot = null;
        } else {
          this._subSnapshot = mergeSubSnapshot(this._subSnapshot, page);
        }
        // 換文途中：<編號>⏎ 之後游標停的那一列，落地比對用（landedOn）。
        const nav = this._nav;
        const snap = page.mode === 'plain' ? this._snapshot : this._subSnapshot;
        if (nav && page.mode === this._pickMode && page.cursorNum === nav.entry.num && snap && sameBoard(page.board, snap.board))
          nav.seen = page.entries.find((e) => e.num === page.cursorNum) || null;
      }
      this._hide();
      return;
    }
    const view = core.view || {};
    const board = view._articleBoard;
    const article = { board: board, author: view._articleAuthor, title: view._articleTitle };
    // 每次文章 settle 都要記（不只讀到文末那幾次）：中途在文章裡換篇再讀到底，也要認得出
    // 游標已經不可信。換文途中不記（落地後 done 會重來）。
    const hintFresh = !this._nav && buf.pageState === 3 && cursorHintFresh(this._lastList, article);
    if (this._nav || !this._inEasyArticleEnd()) {
      this._hide();
      return;
    }
    const list = this._lastList;
    const snap = list && (list.mode === 'plain' ? this._snapshot : this._subSnapshot);
    if (!board || !snap || !sameBoard(list.board, board) || !sameBoard(snap.board, board)) {
      this._hide();
      return;
    }
    const current = findCurrentNum(snap.entries, article, list.cursorNum, hintFresh);
    if (current == null) {
      this._hide();
      return;
    }
    const skipped = [];
    const entry = nextEntryAfter(snap.entries, current, listFilterOf(view), skipped);
    this._logPick(current, entry, skipped);
    if (!entry) {
      // 認得出這篇、卻接不下去：終點卡（不能點），讓人知道是到底了，不是功能壞了。
      const end = listEndsAfter(snap.entries, current, snap.endNum) ? 'last' : 'unknown';
      this._set({ visible: true, entry: null, end: end, pending: false, pull: null, progress: null });
      return;
    }
    this._pickMode = list.mode;
    this._set({ visible: true, entry: entry, end: null, pending: false });
  },

  open: function() {
    const core = this._core;
    const st = this._state;
    const entry = st.entry;
    const sub = this._pickMode === 'select';
    const snap = sub ? this._subSnapshot : this._snapshot;
    if (!st.visible || !entry || this._nav || !snap) return false;
    const nav = core.aidNavigation;
    const busy = serializedOpHint(core);
    if (busy || this._wireBusy() || !nav || typeof (sub ? nav.startSubNum : nav.startNum) !== 'function') {
      if (busy) this._hint(busy, 2500, HINT_ERROR);
      return false;
    }
    const rr = recordFor(core);
    const bm = rr.begin('next-article');
    const self = this;
    const board = snap.board;
    const done = function(result) {
      if (!self._nav || self._nav.entry !== entry) return;
      clearTimeout(self._nav.timer);
      const seen = self._nav.seen;
      self._nav = null;
      const ok = !!(result && result.ok);
      rr.end(bm, ok ? 'done' : 'fail');
      self._set({ pending: false });
      // 失敗：馬上拿掉遮罩，人看得到 PTT 給的原生畫面與錯誤提示（認不出 ⇒ 原生）。
      // 成功：等好讀把新文章畫出來才拿（_maybeReleaseVeil）。
      if (!ok) {
        self._dropVeil(true);
        return;
      }
      self._awaitVeilRelease();
      // 落地的這篇就是「看過列表後的第一篇」（cursorHintFresh 重新記）。
      if (self._lastList) self._lastList = Object.assign({}, self._lastList, { cursorNum: entry.num, articleKey: null });
      const view = core.view || {};
      if (!landedOn(entry, { author: view._articleAuthor, title: view._articleTitle }, seen))
        self._hint(i18n('next_article_mismatch'), 4000, HINT_ERROR);
    };
    this._nav = {
      entry: entry,
      timer: setTimeout(function() {
        done({ ok: false });
      }, NAV_WATCHDOG_MS)
    };
    this._set({ pending: true, pull: null, progress: null });
    // 遮罩一定要在 start 之前：start 同步就進 functionMode 鏡像原生畫面，先蓋上才不會閃。
    this._showVeil(entry);
    // 搜尋結果：<編號>⏎ 後游標那一列要是卡片上那篇才開（快照可能是上一次搜尋的）；
    // 認得出就順便當落地比對的 seen。
    const verify = function(rowText) {
      const row = listEntryOf(rowText);
      if (!row || row.num !== entry.num || row.deleted || !sameListEntry(row, entry)) return false;
      if (self._nav && self._nav.entry === entry) self._nav.seen = row;
      return true;
    };
    const started = sub ? nav.startSubNum(board, entry.num, verify, done) : nav.startNum(board, entry.num, done);
    if (!started) {
      clearTimeout(this._nav.timer);
      this._nav = null;
      rr.end(bm, 'cancel');
      this._set({ pending: false });
      this._dropVeil(true);
      return false;
    }
    return true;
  },

  // ── 換文遮罩 ────────────────────────────────────────────────────────────
  // 換文是真的走一趟原生鍵（s<板>⏎ → 列表 → <編號>⏎ → ⏎），aid_navigation 途中讓好讀進
  // functionMode 鏡像原生畫面 ⇒ 不蓋住的話會閃過原生的文章頁與列表。遮罩是 body 底下
  // fixed、對齊 `.main` 的不透明層，上面放下一篇的標題（從卡片目前的位置滑到頂端，像把
  // 下一篇捲上來），新文章由好讀畫好後淡出。不碰 #mainContainer、不攔任何渲染。

  _showVeil: function(entry) {
    const view = this._core.view;
    const main = view && view.mainDisplay;
    if (!main || typeof document === 'undefined' || !main.getBoundingClientRect) return;
    const r = main.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this._clearVeilTimers();
    const veil = this._ensureVeil();
    veil.style.left = r.left + 'px';
    veil.style.top = r.top + 'px';
    veil.style.width = r.width + 'px';
    veil.style.height = r.height + 'px';
    const fs = typeof getComputedStyle === 'function' ? getComputedStyle(main).fontSize : '';
    if (fs) veil.style.fontSize = fs;
    const [label, title, meta] = veil.firstChild.children;
    label.textContent = i18n('next_article_opening');
    title.textContent = (entry.recommend ? entry.recommend + ' ' : '') + entry.title;
    const date = (entry.date || '').trim();
    meta.textContent = entry.author + (date ? ' · ' + date : '');
    // 標題列從卡片現在的位置出發，滑到頂端（CSS transition；prefers-reduced-motion 不滑）。
    const head = veil.firstChild;
    const card = this._el && !this._el.hidden ? this._el.getBoundingClientRect() : null;
    const from = card ? Math.max(0, Math.min(card.top - r.top, r.height - card.height)) : 0;
    head.style.transition = 'none';
    head.style.transform = from ? 'translateY(' + Math.round(from) + 'px)' : '';
    veil.removeAttribute('data-leaving');
    veil.hidden = false;
    void head.offsetHeight; // 先落地起點，下一行的 transform 才會有 transition
    head.style.transition = '';
    head.style.transform = '';
  },

  _ensureVeil: function() {
    if (this._veil) return this._veil;
    const veil = document.createElement('div');
    veil.id = NEXT_ARTICLE_VEIL_ID;
    veil.hidden = true;
    veil.setAttribute('role', 'status');
    const head = document.createElement('div');
    head.className = 'nextArticleVeilHead';
    for (const cls of ['nextArticleLabel', 'nextArticleTitle', 'nextArticleMeta', 'nextArticleVeilBar']) {
      const s = document.createElement('span');
      s.className = cls;
      head.appendChild(s);
    }
    veil.appendChild(head);
    // 同卡片：不搶 #t 焦點、滑鼠不往 window 傳（App 的滑鼠入口會把它當成點終端機）。
    for (const t of ['mousedown', 'mouseup', 'click']) {
      veil.addEventListener(t, function(e) {
        if (t === 'mousedown') e.preventDefault();
        e.stopPropagation();
      });
    }
    document.body.appendChild(veil);
    this._veil = veil;
    return veil;
  },

  _clearVeilTimers: function() {
    if (this._veilWait) clearTimeout(this._veilWait.timer);
    this._veilWait = null;
    if (this._veilFade) clearTimeout(this._veilFade);
    this._veilFade = null;
  },

  // 換文成功：等好讀把新文章畫出來（_maybeReleaseVeil，每次 settle 也會問），逾時照樣拿掉。
  _awaitVeilRelease: function() {
    if (!this._veil || this._veil.hidden) return;
    const self = this;
    this._clearVeilTimers();
    this._veilWait = {
      timer: setTimeout(function() {
        self._dropVeil(false);
      }, VEIL_RELEASE_MAX_MS)
    };
    this._maybeReleaseVeil();
  },

  _maybeReleaseVeil: function() {
    if (!this._veilWait || this._nav) return;
    const core = this._core;
    const er = core.easyReading;
    const buf = core.buf;
    if (!(buf && buf.pageState === 3 && er && er._enabled && !er._functionMode)) return;
    clearTimeout(this._veilWait.timer);
    this._veilWait = null;
    const self = this;
    // 等這一幀畫完再淡出（好讀的 redraw 與這裡在同一個 task 裡）。
    const later = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
    later(function() {
      self._dropVeil(false);
    });
  },

  // immediate：馬上拿掉（失敗、取消）；否則淡出。
  _dropVeil: function(immediate) {
    const veil = this._veil;
    this._clearVeilTimers();
    if (!veil || veil.hidden) return;
    if (immediate) {
      veil.hidden = true;
      veil.removeAttribute('data-leaving');
      return;
    }
    veil.setAttribute('data-leaving', '');
    this._veilFade = setTimeout(function() {
      veil.hidden = true;
      veil.removeAttribute('data-leaving');
    }, VEIL_FADE_MS);
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
    if (!e) {
      // 終點卡：不能點（open 要 entry），也不接往下拉。
      el.setAttribute('data-end', st.end || 'unknown');
      el.setAttribute('aria-disabled', 'true');
      el.removeAttribute('data-pull');
      el.removeAttribute('data-pending');
      el.removeAttribute('title');
      el.style.removeProperty('--next-pull');
      label.textContent = i18n('next_article_label');
      title.textContent = i18n(st.end === 'last' ? 'next_article_last' : 'next_article_unknown');
      meta.textContent = i18n(st.end === 'last' ? 'next_article_last_meta' : 'next_article_unknown_meta');
      el.hidden = false;
      return;
    }
    el.removeAttribute('data-end');
    el.removeAttribute('aria-disabled');
    // 桌機的入口說明（手機沒有 hover）。
    if (this._core.mobile) el.removeAttribute('title');
    else el.title = i18n('next_article_desktop_hint');
    label.textContent = st.pending
      ? i18n('next_article_opening')
      : st.pull === 'armed'
        ? i18n('next_article_release')
        : st.pull === 'pull'
          ? i18n('next_article_pull')
          : st.pull === 'wheel'
            ? i18n('next_article_wheel')
            : i18n('next_article_label');
    if (st.pull && !st.pending) el.setAttribute('data-pull', st.pull);
    else el.removeAttribute('data-pull');
    if (st.pull && !st.pending && st.progress != null) el.style.setProperty('--next-pull', String(st.progress));
    else el.style.removeProperty('--next-pull');
    title.textContent = (e.recommend ? e.recommend + ' ' : '') + e.title;
    const date = (e.date || '').trim();
    meta.textContent = e.author + (date ? ' · ' + date : '');
    if (st.pending) el.setAttribute('data-pending', '');
    else el.removeAttribute('data-pending');
    el.hidden = false;
  }
};

export function isNextArticleTarget(el) {
  return !!(
    el &&
    typeof el.closest === 'function' &&
    el.closest('#' + NEXT_ARTICLE_ID + ', #' + NEXT_ARTICLE_VEIL_ID)
  );
}

export default NextArticle;
