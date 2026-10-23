// 最近讀過的文章＋稍後再讀（pref enableRecentArticles，預設開）。設計見
// docs/recent-articles.md —— 改這支之前先讀它。
//
// 三條規則：
//   1. **記的時候一個 byte 都不送**：文章身分＝看板＋AID，取自 aid_navigation.findLocalPostAid
//      （只讀文末「※ 文章網址:」那一列，不按 Q）；讀不到網址列（還沒捲到、轉錄文、站內信）
//      就不記。紀錄只存在這個瀏覽器（localStorage，不上雲）。
//   2. **開回去走既有入口**：點一筆 ＝ deepLinkController.request({ board, aid })，跟指令面板
//      貼文章網址同一條（登入前暫存、AID 跳文、閱讀紀錄、忙碌提示都由那條負責）。
//   3. 這裡只管清單：首頁儀表板、指令面板、右鍵選單只讀 state、呼叫 open／toggleLater。

import { readEffectivePrefs } from './pref_storage';

export const RECENT_ARTICLES_KEY = 'pttchrome.recentArticles.v1';
export const RECENT_ARTICLES_LIMIT = 30;
export const READ_LATER_LIMIT = 50;

// ---------------------------------------------------------------------------
// 純邏輯（tests/unit/recent_articles.test.js）
// ---------------------------------------------------------------------------

export function recentKey(board, aid) {
  return board && aid ? String(board).toLowerCase() + '/' + aid : null;
}

function cleanEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const board = typeof e.board === 'string' ? e.board : '';
  const aid = typeof e.aid === 'string' ? e.aid : '';
  if (!/^[0-9A-Za-z_.-]+$/.test(board) || !/^[0-9A-Za-z_-]{8}$/.test(aid)) return null;
  return {
    board: board,
    aid: aid,
    title: typeof e.title === 'string' ? e.title : '',
    at: typeof e.at === 'number' ? e.at : 0
  };
}

function cleanList(list, limit) {
  const out = [];
  const seen = new Set();
  (Array.isArray(list) ? list : []).forEach(function(raw) {
    const e = cleanEntry(raw);
    if (!e) return;
    const k = recentKey(e.board, e.aid);
    if (seen.has(k) || out.length >= limit) return;
    seen.add(k);
    out.push(e);
  });
  return out;
}

export function parseRecentArticles(raw) {
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch (e) {
    data = null;
  }
  const d = data && typeof data === 'object' ? data : {};
  return {
    recent: cleanList(d.recent, RECENT_ARTICLES_LIMIT),
    later: cleanList(d.later, READ_LATER_LIMIT)
  };
}

// 新的放最前、同一篇去重（舊的那筆沒有標題時沿用新標題，反之亦然）、超過上限丟最舊的。
export function pushEntry(list, entry, limit) {
  const k = recentKey(entry.board, entry.aid);
  const old = list.find(function(e) {
    return recentKey(e.board, e.aid) === k;
  });
  const merged = Object.assign({}, entry, { title: entry.title || (old && old.title) || '' });
  return [merged]
    .concat(
      list.filter(function(e) {
        return recentKey(e.board, e.aid) !== k;
      })
    )
    .slice(0, limit);
}

export function removeEntry(list, key) {
  return list.filter(function(e) {
    return recentKey(e.board, e.aid) !== key;
  });
}

// 指令面板用：q 空 ⇒ 稍後再讀在前、最近讀過在後，最多 limit 筆；q 非空 ⇒ 標題或板名含 q。
// 同一篇兩邊都有時只列一次（算稍後再讀）。
export function articleMatches(data, q, limit) {
  const query = String(q || '').trim().toLowerCase();
  const out = [];
  const seen = new Set();
  const add = function(e, source) {
    const k = recentKey(e.board, e.aid);
    if (seen.has(k) || out.length >= limit) return;
    if (query && (e.title + ' ' + e.board).toLowerCase().indexOf(query) < 0) return;
    seen.add(k);
    out.push(Object.assign({ key: k, source: source }, e));
  };
  (data.later || []).forEach(function(e) {
    add(e, 'later');
  });
  (data.recent || []).forEach(function(e) {
    add(e, 'recent');
  });
  return out;
}

// ---------------------------------------------------------------------------
// 控制器
// ---------------------------------------------------------------------------

export function RecentArticles(core, storage) {
  this._core = core;
  this._storage = storage !== undefined ? storage : safeLocalStorage();
  this._listeners = new Set();
  this._raw = undefined;
  this._data = { recent: [], later: [] };
  // 這篇記過了沒（換篇才會再記；同一篇讀很久不必每次 settle 都寫 storage）。
  this._lastKey = null;
  const self = this;
  if (core && core.buf && core.buf.addEventListener)
    core.buf.addEventListener('screenSettled', function() {
      self._onSettled();
    });
}

function safeLocalStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch (e) {
    return null;
  }
}

RecentArticles.prototype = {
  // 每次都比對 storage 的原文：別的分頁寫的、測試預先放的都讀得到。
  get state() {
    let raw = null;
    try {
      raw = this._storage ? this._storage.getItem(RECENT_ARTICLES_KEY) : null;
    } catch (e) {
      raw = null;
    }
    if (raw !== this._raw) {
      this._raw = raw;
      this._data = parseRecentArticles(raw);
    }
    return this._data;
  },

  enabled: function() {
    return !!readEffectivePrefs().enableRecentArticles;
  },

  onChange: function(fn) {
    this._listeners.add(fn);
    const set = this._listeners;
    return function() {
      set.delete(fn);
    };
  },

  _write: function(data) {
    const raw = JSON.stringify(data);
    try {
      if (this._storage) this._storage.setItem(RECENT_ARTICLES_KEY, raw);
    } catch (e) {
      // 寫不進去（無痕、容量滿）：這次只活在記憶體。
    }
    this._raw = raw;
    this._data = data;
    this._listeners.forEach(function(fn) {
      fn(data);
    });
  },

  // 本篇（findLocalPostAid）。不在文章、讀不到網址列 ⇒ null。
  currentArticle: function() {
    const nav = this._core && this._core.aidNavigation;
    const hit = nav && typeof nav.findLocalPostAid === 'function' ? nav.findLocalPostAid() : null;
    if (!hit) return null;
    const view = this._core.view || {};
    return { board: hit.board, aid: hit.aid, title: view._articleTitle || '' };
  },

  _onSettled: function() {
    const buf = this._core.buf;
    if (!buf || buf.pageState !== 3) {
      // 離開文章：下次再進同一篇要重新排到最前面。
      this._lastKey = null;
      return;
    }
    if (!this.enabled()) return;
    const cur = this.currentArticle();
    if (!cur) return;
    const key = recentKey(cur.board, cur.aid);
    if (key === this._lastKey) return;
    this._lastKey = key;
    this.noteRead(cur);
  },

  noteRead: function(entry, now) {
    const e = cleanEntry(Object.assign({}, entry, { at: now || Date.now() }));
    if (!e) return false;
    const data = this.state;
    const k = recentKey(e.board, e.aid);
    // 稍後再讀裡那一筆沒有標題（從連結收的）⇒ 讀到時補上。
    const later = data.later.map(function(x) {
      return recentKey(x.board, x.aid) === k && !x.title && e.title ? Object.assign({}, x, { title: e.title }) : x;
    });
    this._write({ recent: pushEntry(data.recent, e, RECENT_ARTICLES_LIMIT), later: later });
    return true;
  },

  isLater: function(key) {
    return this.state.later.some(function(e) {
      return recentKey(e.board, e.aid) === key;
    });
  },

  // 右鍵選單「稍後再讀」／「從稍後再讀移除」。回傳切換後是否在清單裡；不合法 ⇒ null。
  toggleLater: function(entry, now) {
    const e = cleanEntry(Object.assign({}, entry, { at: now || Date.now() }));
    if (!e) return null;
    const data = this.state;
    const k = recentKey(e.board, e.aid);
    if (this.isLater(k)) {
      this._write({ recent: data.recent, later: removeEntry(data.later, k) });
      return false;
    }
    this._write({ recent: data.recent, later: pushEntry(data.later, e, READ_LATER_LIMIT) });
    return true;
  },

  removeLater: function(key) {
    const data = this.state;
    if (!this.isLater(key)) return false;
    this._write({ recent: data.recent, later: removeEntry(data.later, key) });
    return true;
  },

  // 開回那一篇：跟指令面板貼文章網址同一條（deep link）。開不了（忙、沒連線）⇒ false。
  open: function(entry) {
    const dl = this._core && this._core.deepLinkController;
    if (!entry || !dl || typeof dl.request !== 'function') return false;
    return !!dl.request({ board: entry.board, aid: entry.aid });
  }
};

export default RecentArticles;
