// 寬螢幕雙欄閱讀（pref enableSplitReading，預設開）：讀文章時，終端機左邊的空白處列出
// 剛才那份文章列表，點一篇就換過去讀，像 Gmail／RSS 閱讀器。設計見 docs/split-reader.md
// —— 改這支之前先讀它。
//
// 三條規則：
//   1. **PTT 同一時間只有一個畫面**：左欄是我們在列表上看過的那幾頁的快照（每次文章列表
//      settle 就併進來），不是活的列表。換文＝真的走一趟原生鍵：aid_navigation.startNum
//      （文章內 s<板>⏎ → <編號>⏎ → ⏎，每步依畫面驗證），失敗就停在 PTT 給的畫面。
//   2. **認不出 ⇒ 原生**：只在「看板文章（pageState 3）＋看得出看板＋上一次看到的列表是
//      同一板的完整列表」時出現。搜尋結果／文摘是另一個編號空間（read.c MODE_SELECT），
//      拿那裡的編號去 startNum 會開錯篇 ⇒ 不出現。這篇是清單上哪一篇，用作者＋主題比對
//      （long_push_anchor 同一套），對不上就不標。
//   3. **只用空白處**：終端機恆 80 欄、水平置中（docs/terminal-size.md LOCKED），左欄只放
//      在終端機左邊的空白裡，放不下（視窗太窄、字太大、手機）就不出現，不推動終端機。

import { isArticleListTitleRow, parseBoardName } from './screen_titles';
import { isArticleListFooter, isSubListFooter } from './screen_captions';
import { parseListEntry } from './agent_parse';
import { parseListArticleNumLoose } from './comment_parse';
import { blacklistHit, listFilterOf } from './list_row_filter';
import { listRowIdentity, subjectKey, subjectMatches } from './long_push_anchor';
import { charCells } from './string_util';
import { serializedOpHint } from './serialized_op_gate';
import { readEffectivePrefs } from './pref_storage';
import { recordFor } from './reading_record';
import { HINT_ERROR } from './status_hint';

export const SPLIT_READER_ID = 'splitReader';
export const SPLIT_COLLAPSED_KEY = 'pttchrome.splitReader.collapsed.v1';
// 左邊空白至少要這麼寬才放左欄（標題折兩行，一行十個中文字上下）。預設的「固定終端機
// 大小」會把字放大到撐滿視窗，實測（offline e2e，Chromium）常見桌機視窗左邊只剩：
// 1920×960 → 155px、2560×1300 → 195px、1536×730 → 163px、1366×650 → 158px；
// 1920×1080（F11 全螢幕）→ 75px 放不下 ⇒ 下限壓在 150 以下，一般視窗才看得到它。
export const SPLIT_MIN_PANE_PX = 140;
export const SPLIT_MAX_PANE_PX = 420;
// 左欄與終端機之間留的縫。
export const SPLIT_GAP_PX = 8;
// 收起時左緣那條「展開」把手的寬度。
export const SPLIT_HANDLE_PX = 28;
// 快照最多留幾篇（一頁 20 篇 × 15 頁），超過就丟離游標最遠的。
export const SPLIT_SNAPSHOT_LIMIT = 300;
// 換文整段的上限（startNum 每步最多 hardTimeout 10s，三四步）。
const NAV_WATCHDOG_MS = 45000;

// ---------------------------------------------------------------------------
// 純判讀（tests/unit/split_reader.test.js）
// ---------------------------------------------------------------------------

// 列表一列的已讀欄（bbs.c#readdoent 的 type，第 8 格）：+ ~ M = S # 是未讀。
const UNREAD_MARKS = '+~M=S#';
export function listRowUnread(text) {
  let col = 0;
  for (const ch of text || '') {
    if (col === 8) return UNREAD_MARKS.indexOf(ch) >= 0;
    col += charCells(ch);
    if (col > 8) return false;
  }
  return false;
}

// 一張文章列表畫面 → { board, mode, entries[], cursorNum }；不是文章列表 ⇒ null。
// mode：'plain' 完整列表、'select' 搜尋結果／文摘（底列 caption，read.c#i_read_caption）。
// 置底文（★，沒有編號）不收：startNum 跳不到它。
// 游標列：curY（終端機游標停在那一列，cursor_show 之後）優先；給不出來才看列首的
// STR_CURSOR「>」或 STR_CURSOR2「●」（include/common.h，使用者可選）。
export function listPageOf(rowTexts, curY) {
  const t = rowTexts || [];
  const n = t.length;
  const row0 = t[0] || '';
  const last = t[n - 1] || '';
  if (!isArticleListTitleRow(row0) || !isArticleListFooter(last)) return null;
  const board = parseBoardName(row0);
  if (!board) return null;
  const entries = [];
  let cursorNum = null;
  for (let r = 3; r < n - 1; r++) {
    const text = t[r];
    const e = parseListEntry(text);
    if (!e) continue;
    // STR_CURSOR2「●」是全形，蓋掉序號欄的前兩格 ⇒ 嚴格的欄位解析讀不出編號，退回寬鬆的。
    const num = e.num != null ? e.num : e.pinned ? null : parseListArticleNumLoose(text);
    if (num == null) continue;
    const id = listRowIdentity(text);
    entries.push({
      num: num,
      title: e.title,
      author: e.author,
      date: e.date,
      recommend: e.recommend,
      deleted: !!e.deleted,
      unread: !e.deleted && listRowUnread(text),
      subject: id ? id.subject : null,
      // 列原文：黑名單判定（list_row_filter）吃整列文字，用的時候才比（使用者隨時可能改名單）。
      text: text
    });
    if (r === curY || (curY == null && /^[>●]/.test(text))) cursorNum = num;
  }
  return { board, mode: isSubListFooter(last) ? 'select' : 'plain', entries, cursorNum };
}

export function sameBoard(a, b) {
  return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
}

// 把一頁併進快照（照編號排序）。換板就整份換掉；超過上限丟離 pivot 最遠的。
export function mergeSnapshot(prev, page, limit) {
  const cap = limit || SPLIT_SNAPSHOT_LIMIT;
  const map = new Map();
  if (prev && sameBoard(prev.board, page.board)) for (const e of prev.entries) map.set(e.num, e);
  for (const e of page.entries) map.set(e.num, e);
  let entries = Array.from(map.values()).sort((a, b) => a.num - b.num);
  if (entries.length > cap) {
    const pivot =
      page.cursorNum != null ? page.cursorNum : page.entries.length ? page.entries[0].num : entries[0].num;
    entries = entries
      .slice()
      .sort((a, b) => Math.abs(a.num - pivot) - Math.abs(b.num - pivot))
      .slice(0, cap)
      .sort((a, b) => a.num - b.num);
  }
  return { board: page.board, entries };
}

// 左欄顯示的條目：黑名單命中的不列（list_row_filter，跟列表上看到的一樣）；正在讀的那篇
// （keepNum）就算命中也留著，「目前這篇」的標記才不會不見。刪除文照舊列出、不能點。
// 沒有任何一列被拿掉 ⇒ 回傳原陣列（state 比參照，不觸發重畫）。
export function shownEntries(entries, filter, keepNum) {
  if (!entries || !filter || (!filter.blacklist && !filter.titleKeywords)) return entries;
  const out = entries.filter(
    (e) => e.num === keepNum || e.deleted || !blacklistHit(e.text, filter.blacklist, filter.titleKeywords)
  );
  return out.length === entries.length ? entries : out;
}

// 正在讀的這篇是清單上哪一篇：作者＋主題（列表主題可能被截成 …）。同主題的回文很多，
// 所以先信「開文前游標停的那篇」，再信唯一的符合者，都不成就不標（null）。
// 主題對不上也可能是同一篇：PTT 的 T（bbs.c edit_title）只改 .DIR 的標題（modify_dir_lite），
// 文章檔頭不動 ⇒ 改過標題的文章，列表與檔頭永遠不一樣。hintFresh（cursorHintFresh）時，
// 游標那篇作者對得上就信它。
export function findCurrentNum(entries, article, hintNum, hintFresh) {
  if (!entries || !article || !article.author) return null;
  const author = String(article.author).toLowerCase();
  const subject = subjectKey(article.title);
  const hits = subject
    ? entries.filter(
        (e) => e.subject && !e.deleted && String(e.author).toLowerCase() === author && subjectMatches(e.subject, subject)
      )
    : [];
  if (hintNum != null) {
    for (const e of hits) if (e.num === hintNum) return e.num;
    if (hintFresh) {
      const e = entries.find((x) => x.num === hintNum);
      if (e && !e.deleted && String(e.author).toLowerCase() === author) return e.num;
    }
  }
  return hits.length === 1 ? hits[0].num : null;
}

// 「開文前游標停的那篇」（list.cursorNum）只對看過列表之後打開的第一篇可信：之後在文章裡
// 用原生鍵換文（pmore 讀完按空白＝read.c READ_NEXT、]／+ 同主題）不經過列表，游標早就不是
// 那篇了。第一次看到的檔頭記在 list 上（每次列表 settle 都換一個新的 list 物件），之後檔頭
// 不同 ⇒ 不可信。
export function cursorHintFresh(list, article) {
  if (!list || !article || !article.author) return false;
  const key = [article.board, article.author, article.title].map((s) => String(s || '').toLowerCase()).join('\n');
  if (list.articleKey == null) list.articleKey = key;
  return list.articleKey === key;
}

// 左邊空白（終端機左緣到視窗左緣）→ 左欄寬度；放不下 ⇒ 0。
export function paneWidthFor(sideSpace) {
  const w = Math.floor((sideSpace || 0) - SPLIT_GAP_PX);
  if (w < SPLIT_MIN_PANE_PX) return 0;
  return Math.min(w, SPLIT_MAX_PANE_PX);
}

function enabled() {
  return !!readEffectivePrefs().enableSplitReading;
}

function readCollapsed() {
  try {
    return window.localStorage.getItem(SPLIT_COLLAPSED_KEY) === '1';
  } catch (e) {
    return false;
  }
}

function writeCollapsed(v) {
  try {
    if (v) window.localStorage.setItem(SPLIT_COLLAPSED_KEY, '1');
    else window.localStorage.removeItem(SPLIT_COLLAPSED_KEY);
  } catch (e) {
    // 無痕視窗／被擋：只記在這一頁。
  }
}

// ---------------------------------------------------------------------------
// 控制器
// ---------------------------------------------------------------------------

export function SplitReader(core) {
  this._core = core;
  this._listeners = new Set();
  this._snapshot = null; // { board, entries }
  this._lastList = null; // { board, mode, cursorNum, articleKey }：上一次看到的文章列表（articleKey 見 cursorHintFresh）
  this._nav = null; // { num, timer }：自己發起的換文
  this._shownCache = null; // _shown 的上一次結果
  this._state = {
    visible: false,
    board: null,
    entries: [],
    currentNum: null,
    pendingNum: null,
    width: 0,
    collapsed: readCollapsed()
  };
  const self = this;
  if (core.buf && core.buf.addEventListener)
    core.buf.addEventListener('screenSettled', function() {
      self._onSettled();
    });
  if (typeof window !== 'undefined' && window.addEventListener)
    window.addEventListener('resize', function() {
      self._relayout();
    });
}

SplitReader.prototype = {
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
    const keys = Object.keys(patch);
    if (keys.every((k) => next[k] === this._state[k])) return;
    this._state = next;
    this._listeners.forEach(function(fn) {
      fn(next);
    });
  },

  _hint: function(msg, ms, level) {
    const view = this._core.view;
    if (view && view.flashListHint) view.flashListHint(msg, ms || 3000, level);
  },

  // 左欄條目（shownEntries）。快照、黑名單、目前這篇都沒變 ⇒ 回上次那個陣列：每次文章
  // settle 都會跑，新陣列會讓左欄整個重畫。
  _shown: function(entries, keepNum) {
    const f = listFilterOf(this._core.view);
    const c = this._shownCache;
    if (c && c.src === entries && c.bl === f.blacklist && c.tk === f.titleKeywords && c.keep === keepNum) return c.out;
    const out = shownEntries(entries, f, keepNum);
    this._shownCache = { src: entries, bl: f.blacklist, tk: f.titleKeywords, keep: keepNum, out: out };
    return out;
  },

  // 終端機左邊有多少空白。量 #mainContainer（終端機本體，置中由 align=center 做）。
  _sideSpace: function() {
    const view = this._core.view;
    const el = view && view.mainDisplay;
    if (!el || typeof el.getBoundingClientRect !== 'function') return 0;
    return el.getBoundingClientRect().left;
  },

  _relayout: function() {
    if (!this._state.visible) return;
    const width = paneWidthFor(this._sideSpace());
    if (!width) this._set({ visible: false, width: 0 });
    else this._set({ width: width });
  },

  _hide: function() {
    if (this._state.visible) this._set({ visible: false });
  },

  // 線路上有沒有別人的事（AID 跳文、搜尋、長推文…）。
  _wireBusy: function() {
    const core = this._core;
    if (serializedOpHint(core)) return true;
    if (core.commandQueue && !core.commandQueue.idle) return true;
    return false;
  },

  _onSettled: function() {
    const core = this._core;
    const buf = core.buf;
    if (!buf || typeof buf.getRowText !== 'function') return;
    if (!enabled() || core.mobile) {
      this._hide();
      return;
    }
    // 先只讀頭尾兩列：每次 settle 都會跑，文章裡不必讀滿整頁。
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
      // 換文途中會經過列表：左欄留著顯示「開啟中」。
      if (!this._nav) this._hide();
      return;
    }
    const view = core.view || {};
    const board = buf.pageState === 3 ? view._articleBoard : null;
    if (!board) {
      if (!this._nav) this._hide();
      return;
    }
    const snap = this._snapshot;
    const list = this._lastList;
    const article = { board: board, author: view._articleAuthor, title: view._articleTitle };
    // 每次文章 settle 都記（左欄放不下的時候也是）：換篇之後才認得出游標已經不可信。
    const hintFresh = !this._nav && cursorHintFresh(list, article);
    if (!snap || !list || list.mode !== 'plain' || !sameBoard(list.board, board) || !sameBoard(snap.board, board)) {
      this._hide();
      return;
    }
    const width = paneWidthFor(this._sideSpace());
    if (!width) {
      this._hide();
      return;
    }
    const current = this._nav ? this._state.currentNum : findCurrentNum(snap.entries, article, list.cursorNum, hintFresh);
    this._set({
      visible: true,
      board: snap.board,
      entries: this._shown(snap.entries, current),
      currentNum: current,
      width: width
    });
  },

  setCollapsed: function(v) {
    writeCollapsed(!!v);
    this._set({ collapsed: !!v });
  },

  // 點左欄的一篇：走 aid_navigation.startNum（同 agent 工具的開文序列）。
  openNum: function(num) {
    const core = this._core;
    const st = this._state;
    if (!st.visible || !st.board || !(num > 0) || num === st.currentNum) return false;
    if (this._nav) return false;
    const entry = st.entries.find((e) => e.num === num);
    if (!entry || entry.deleted) return false;
    const nav = core.aidNavigation;
    const busy = serializedOpHint(core);
    if (busy || this._wireBusy() || !nav || typeof nav.startNum !== 'function') {
      if (busy) this._hint(busy, 2500, HINT_ERROR);
      return false;
    }
    const rr = recordFor(core);
    const bm = rr.begin('split-open');
    const self = this;
    const board = st.board;
    const done = function(result) {
      if (!self._nav || self._nav.num !== num) return;
      clearTimeout(self._nav.timer);
      self._nav = null;
      const ok = !!(result && result.ok);
      rr.end(bm, ok ? 'done' : 'fail');
      const patch = { pendingNum: null };
      if (ok) {
        patch.currentNum = num;
        // 讀過了：本地先把未讀標記拿掉（下次回列表 settle 會用 PTT 的標記蓋回來）。
        if (self._snapshot) {
          self._snapshot = {
            board: self._snapshot.board,
            entries: self._snapshot.entries.map((e) => (e.num === num && e.unread ? Object.assign({}, e, { unread: false }) : e))
          };
          patch.entries = self._shown(self._snapshot.entries, num);
        }
        // 落地的這篇就是「看過列表後的第一篇」（cursorHintFresh 重新記）。
        if (self._lastList) self._lastList = Object.assign({}, self._lastList, { cursorNum: num, articleKey: null });
      }
      self._set(patch);
    };
    this._nav = {
      num: num,
      timer: setTimeout(function() {
        done({ ok: false });
      }, NAV_WATCHDOG_MS)
    };
    this._set({ pendingNum: num });
    if (!nav.startNum(board, num, done)) {
      clearTimeout(this._nav.timer);
      this._nav = null;
      rr.end(bm, 'cancel');
      this._set({ pendingNum: null });
      return false;
    }
    return true;
  }
};

export function isSplitReaderTarget(el) {
  return !!(el && typeof el.closest === 'function' && el.closest('#' + SPLIT_READER_ID));
}

export default SplitReader;
