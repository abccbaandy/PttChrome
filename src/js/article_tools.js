// 文章工具側欄（pref enableArticleTools，預設開）：好讀讀文章時，終端機右邊的空白放一條
// 側欄：本篇 AID／網址複製、推文統計、推文者排行（點一個人＝只列他的推文，點一則跳過去）、
// 本篇圖片牆（點縮圖跳到那一列）。設計見 docs/article-tools.md —— 改這支之前先讀它。
//
// 三條規則：
//   1. **一個 byte 都不送**：資料全取自好讀的累積頁（buf.pageLines），跳到某列＝捲好讀的
//      視口（easy_reading.scrollToArticleRow），AID 只用免費的網址列（aid_navigation.
//      findLocalPostAid，不按 Q）。所以不在安全模式名單內（它不改原生畫面、不攔鍵）。
//   2. **只在好讀文章裡**：原生 pmore 只有眼前這一屏，統計是錯的 ⇒ 不出現。
//   3. **只用空白處**：與雙欄閱讀的左欄同一套（split_reader.paneWidthFor），放不下就不出現，
//      不推動終端機（docs/terminal-size.md LOCKED）。

import { parseArticleHeader, mentionsUser } from './comment_parse';
import { parseCommentLine, parseModernCommentLine } from './agent_parse';
import { MODERN_COMMENT_BODY_MARK } from './comment_parse';
import { RE_IMAGE_EXT, RE_IMGUR_SINGLE, RE_TWIMG, RE_TENOR } from './image_url_detect';
import { getImageProxyConfig, imgurCandidates, twimgCandidates, twimgOrigFormat } from './image_proxy';
import { aidToFn } from './aid_codec';
import { paneWidthFor } from './split_reader';
import { readEffectivePrefs } from './pref_storage';
import { HINT_ERROR } from './status_hint';

export const ARTICLE_TOOLS_ID = 'articleTools';
export const ARTICLE_TOOLS_COLLAPSED_KEY = 'pttchrome.articleTools.collapsed.v1';
// 推文者排行列幾個人。
export const TOP_USERS = 8;
// 圖片牆最多幾張（長文的圖可以上百張，全部縮圖等於全部下載）。
export const IMAGE_LIMIT = 60;

// ---------------------------------------------------------------------------
// 純判讀（tests/unit/article_tools.test.js）
// ---------------------------------------------------------------------------

// 一列裡的網址（不跨列：被折行的長網址只取得到前半，縮圖會載入失敗，由 onError 收掉）。
const URL_RE = /https?:\/\/[^\s<>"'，。、）」』]+/g;
export function urlsInLine(text) {
  return (text && text.match(URL_RE)) || [];
}

// 網址 → 縮圖候選（依序試，失敗換下一個）；不是靜態圖 ⇒ null。
// imgur 單張：先試 m 尺寸（320px 縮圖）再試原圖；twimg：先試 small。相簿、tenor、影片不收。
export function thumbCandidates(url, config) {
  if (!url || RE_TENOR.test(url)) return null;
  const cfg = config || {};
  const imgur = RE_IMGUR_SINGLE.exec(url);
  if (imgur && !/\/(?:a|gallery)\//i.test(url)) {
    const id = imgur[1];
    const ext = (imgur[2] || 'jpg').toLowerCase();
    if (/^(?:mp4|gifv|webm)$/.test(ext)) return null;
    return Array.from(new Set([...imgurCandidates(id + 'm', ['jpg'], cfg), ...imgurCandidates(id, [ext], cfg)]));
  }
  const tw = RE_TWIMG.exec(url);
  if (tw) {
    const fmt = twimgOrigFormat(tw[3] || tw[2]);
    return Array.from(
      new Set(['https://pbs.twimg.com/media/' + tw[1] + '?format=' + fmt + '&name=small', ...twimgCandidates(tw[1], fmt, cfg)])
    );
  }
  if (RE_IMAGE_EXT.test(url) && !/\.svg(?:$|[?#])/i.test(url)) return [url];
  return null;
}

// 好讀累積頁（每列一個字串，索引＝pageLines 索引）→ 側欄要的全部資料。
//   author：檔頭的作者（小寫 userid；沒有檔頭 ⇒ null）
//   stats：{ push, boo, arrow, modern }（新格式推文沒有推／噓之分，另計）
//   comments：[{ row, type, user, content }]（user 小寫）
//   users：[{ user, count, op }] 依則數多到少（同數照第一次出現）
//   images：[{ url, row, thumbs }]（同網址只收第一次，最多 IMAGE_LIMIT 張）
//   mentions：內容提到 selfId 的推文（同 comments 的形狀；自己推的不算；沒有 selfId ⇒ []）。
//     判準與推文列左緣的標示同一支（comment_parse.mentionsUser）。
export function analyzeArticle(lines, config, selfId) {
  const t = lines || [];
  const header = parseArticleHeader(t[0] || '');
  const author = header && header.author ? header.author : null;
  const stats = { push: 0, boo: 0, arrow: 0, modern: 0 };
  const comments = [];
  const counts = new Map();
  const images = [];
  const seen = new Set();
  let modern = null;
  for (let row = 0; row < t.length; row++) {
    const text = t[row] || '';
    if (images.length < IMAGE_LIMIT) {
      for (const url of urlsInLine(text)) {
        if (seen.has(url) || images.length >= IMAGE_LIMIT) continue;
        const thumbs = thumbCandidates(url, config);
        if (!thumbs) continue;
        seen.add(url);
        images.push({ url, row, thumbs });
      }
    }
    if (modern && text.charAt(0) === MODERN_COMMENT_BODY_MARK) {
      const part = text.slice(1).trim();
      modern.content = modern.content ? modern.content + ' ' + part : part;
      continue;
    }
    modern = null;
    let c = parseModernCommentLine(text);
    if (c) {
      stats.modern++;
    } else {
      c = parseCommentLine(text);
      if (!c) continue;
      if (c.type === '推') stats.push++;
      else if (c.type === '噓') stats.boo++;
      else stats.arrow++;
    }
    const user = String(c.user || '').toLowerCase();
    const entry = { row, type: c.type, user, content: c.content || '' };
    comments.push(entry);
    if (c.type === 'modern') modern = entry;
    counts.set(user, (counts.get(user) || 0) + 1);
  }
  const users = Array.from(counts, ([user, count]) => ({ user, count, op: user === author }));
  users.sort((a, b) => b.count - a.count);
  const me = selfId ? String(selfId).toLowerCase() : null;
  const mentions = me ? comments.filter((c) => c.user !== me && mentionsUser(c.content, me)) : [];
  return { author, stats, comments, users, images, mentions };
}

// 本篇的 ptt.cc 網址（AID → 檔名，aid_codec）。
export function articleUrl(board, aid) {
  const fn = board && aid ? aidToFn(aid) : null;
  return fn ? 'https://www.ptt.cc/bbs/' + board + '/' + fn + '.html' : null;
}

function enabled() {
  return !!readEffectivePrefs().enableArticleTools;
}

function readCollapsed() {
  try {
    return window.localStorage.getItem(ARTICLE_TOOLS_COLLAPSED_KEY) === '1';
  } catch (e) {
    return false;
  }
}

function writeCollapsed(v) {
  try {
    if (v) window.localStorage.setItem(ARTICLE_TOOLS_COLLAPSED_KEY, '1');
    else window.localStorage.removeItem(ARTICLE_TOOLS_COLLAPSED_KEY);
  } catch (e) {
    // 無痕視窗／被擋：只記在這一頁。
  }
}

const EMPTY = { author: null, stats: { push: 0, boo: 0, arrow: 0, modern: 0 }, comments: [], users: [], images: [], mentions: [] };

// ---------------------------------------------------------------------------
// 控制器
// ---------------------------------------------------------------------------

export function ArticleTools(core) {
  this._core = core;
  this._listeners = new Set();
  // 累積頁的文字快取：pageLines 只往後 concat（screen_annotate_cache 的不變量），換文章／
  // 從頭重讀會整份換掉 ⇒ 首列變了或變短就重來。
  this._lines = [];
  this._head = null;
  this._analysis = EMPTY;
  this._state = {
    visible: false,
    width: 0,
    collapsed: readCollapsed(),
    board: null,
    aid: null,
    url: null,
    author: null,
    stats: EMPTY.stats,
    users: [],
    images: [],
    mentions: [],
    selectedUser: null,
    selectedComments: []
  };
  const self = this;
  if (core.buf && core.buf.addEventListener)
    core.buf.addEventListener('screenSettled', function() {
      self._onSettled();
    });
  if (typeof window !== 'undefined' && window.addEventListener)
    window.addEventListener('resize', function() {
      self._onSettled();
    });
}

ArticleTools.prototype = {
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
    if (view && view.flashListHint) view.flashListHint(msg, ms || 2000, level);
  },

  // 終端機右邊有多少空白。
  _sideSpace: function() {
    const view = this._core.view;
    const el = view && view.mainDisplay;
    if (!el || typeof el.getBoundingClientRect !== 'function' || typeof window === 'undefined') return 0;
    return window.innerWidth - el.getBoundingClientRect().right;
  },

  _hide: function() {
    if (this._state.visible) this._set({ visible: false });
  },

  _inEasyArticle: function() {
    const core = this._core;
    const er = core.easyReading;
    const buf = core.buf;
    return !!(buf && buf.pageState === 3 && er && er._enabled && !er._functionMode && (buf.pageLines || []).length);
  },

  // 讀累積頁的新列（只讀新增的那幾列）。回傳有沒有變。
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

  _onSettled: function() {
    const core = this._core;
    if (!enabled() || core.mobile || !this._inEasyArticle()) {
      this._hide();
      return;
    }
    const width = paneWidthFor(this._sideSpace());
    if (!width) {
      this._hide();
      return;
    }
    const changed = this._syncLines();
    const patch = { visible: true, width: width };
    const view = core.view || {};
    const board = view._articleBoard || null;
    // 自己的帳號：與推文列的「我」標示同一個來源與同一個開關（term_view._selfId）。
    const selfId = view.highlightSelfComments ? view._selfId || null : null;
    if (changed || board !== this._state.board || selfId !== this._selfId) {
      this._selfId = selfId;
      const a = (this._analysis = analyzeArticle(this._lines, getImageProxyConfig(), selfId));
      const nav = core.aidNavigation;
      const local = nav && typeof nav.findLocalPostAid === 'function' ? nav.findLocalPostAid() : null;
      const aid = local ? local.aid : null;
      Object.assign(patch, {
        board: board,
        aid: aid,
        url: articleUrl(board, aid),
        author: a.author,
        stats: a.stats,
        users: a.users.slice(0, TOP_USERS),
        images: a.images,
        mentions: a.mentions
      });
      // 換文章 ⇒ 篩選作廢；同一篇長出新推文 ⇒ 重算這個人的清單。
      if (this._state.selectedUser && !a.users.some((u) => u.user === this._state.selectedUser)) {
        patch.selectedUser = null;
        patch.selectedComments = [];
      } else if (this._state.selectedUser) {
        patch.selectedComments = a.comments.filter((c) => c.user === this._state.selectedUser);
      }
    }
    this._set(patch);
  },

  setCollapsed: function(v) {
    writeCollapsed(!!v);
    this._set({ collapsed: !!v });
  },

  // 只列某人的推文（再點一次同一人＝取消）。
  selectUser: function(user) {
    const u = user && user !== this._state.selectedUser ? String(user).toLowerCase() : null;
    this._set({
      selectedUser: u,
      selectedComments: u ? this._analysis.comments.filter((c) => c.user === u) : []
    });
  },

  // 跳到累積頁的第 row 列（好讀的視口，不送鍵）。
  jumpTo: function(row) {
    const er = this._core.easyReading;
    if (!er || typeof er.scrollToArticleRow !== 'function' || !this._inEasyArticle()) return false;
    return er.scrollToArticleRow(row);
  },

  _copy: function(text, okMsg) {
    const self = this;
    const clip = typeof navigator !== 'undefined' && navigator.clipboard;
    if (!text || !clip || typeof clip.writeText !== 'function') {
      this._hint('無法複製', 2500, HINT_ERROR);
      return Promise.resolve(false);
    }
    return clip.writeText(text).then(
      function() {
        self._hint(okMsg, 1500);
        return true;
      },
      function() {
        self._hint('無法複製', 2500, HINT_ERROR);
        return false;
      }
    );
  },

  copyUrl: function() {
    return this._copy(this._state.url, '已複製文章網址');
  },

  copyAid: function() {
    return this._copy(this._state.aid ? '#' + this._state.aid : null, '已複製 AID');
  }
};

export function isArticleToolsTarget(el) {
  return !!(el && typeof el.closest === 'function' && el.closest('#' + ARTICLE_TOOLS_ID));
}

export default ArticleTools;
