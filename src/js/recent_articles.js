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
//
// 接著上次讀到的地方（pref resumeRecentArticles，預設開）：好讀文章裡捲動時順手記下視窗頂端
// 那一列（閱讀紀錄的文章量測，記在「最近讀過」那一筆的 line）；開回去時 AID 跳文落地、
// 落地那篇確實是這一篇，才交給好讀的一次性還原（easy_reading.requestScrollRestore，累積到位
// 才捲）。只捲視口、一個 byte 都不多送；頂端閃一行「接著上次讀到的地方｜回到開頭」。

import { readEffectivePrefs } from './pref_storage';
import { recordFor } from './reading_record';
import { i18n } from './i18n';

export const RECENT_ARTICLES_KEY = 'pttchrome.recentArticles.v1';
export const RECENT_ARTICLES_LIMIT = 30;
export const READ_LATER_LIMIT = 50;
// 開回去之後最多等多久落地（AID 跳文含切板通常幾秒內）。
export const RESUME_ARM_MS = 30000;
// 捲動停下來多久才記位置（捲動途中每一幀都量節點太浪費）。
export const RESUME_SAMPLE_MS = 300;
export const RESUME_TOAST_ID = 'recentResume';
export const RESUME_TOAST_MS = 6000;

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
  return withLine(
    {
      board: board,
      aid: aid,
      title: typeof e.title === 'string' ? e.title : '',
      at: typeof e.at === 'number' ? e.at : 0
    },
    e.line
  );
}

// 有位置才帶 line 欄位（沒讀到一半的紀錄維持原本的四個欄位）。
function withLine(e, line) {
  const out = Object.assign({}, e);
  const l = resumeLineOf(line);
  if (l != null) out.line = l;
  else delete out.line;
  return out;
}

// 存得下的閱讀位置：文章的列索引（可帶小數＝列內比例，見 term_view.currentLineIndex）。
// 還在第一列、壞值 ⇒ null（沒有「接著讀」可言）。
export function resumeLineOf(line) {
  return typeof line === 'number' && isFinite(line) && line >= 1 ? Math.round(line * 1000) / 1000 : null;
}

// 閱讀紀錄的文章量測 → 要記的位置。讀到文末（atBottom）不記：讀完的文章開回去從頭，
// 新推文由 new_comments 的「以下是新推文」標出來。
export function resumeLineFromRecord(article) {
  if (!article || !article.easy || article.atBottom) return null;
  return resumeLineOf(article.lineIndex);
}

// 開回去之後要不要捲（純決策，tests/unit/recent_articles.test.jsx）：
//   跳文還在跑、還沒落在新的一篇（_articleInstanceId 沒換）、好讀還沒接手 ⇒ 'wait'；
//   落地那篇（aid_navigation.currentPostAid）就是要開的這篇 ⇒ 'apply'；別篇、認不出 ⇒ 'drop'；
//   等太久 ⇒ 'drop'。
export function nextResumeStep(s) {
  if (s.ageMs > RESUME_ARM_MS) return 'drop';
  if (s.navActive || s.pageState !== 3 || s.inst == null || s.inst === s.armedInst || !s.easy) return 'wait';
  return s.landedKey && s.landedKey === s.key ? 'apply' : 'drop';
}

export function isRecentResumeTarget(el) {
  return !!(el && el.closest && el.closest('#' + RESUME_TOAST_ID));
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
  // 位置同理：重讀一次（noteRead 不帶位置）不洗掉上次讀到的地方。
  const merged = withLine(
    Object.assign({}, entry, { title: entry.title || (old && old.title) || '' }),
    entry.line != null ? entry.line : old && old.line
  );
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
  // 記下 _lastKey 時的文章實例（view._articleInstanceId）：捲動記位置只認這一篇。
  this._lastInst = null;
  // 開回去等落地：{ key, line, armedInst, at }。
  this._resume = null;
  this._sampleTimer = null;
  this._scrollBound = null;
  this._toastTimer = null;
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
    this._bindScroll();
    this._advanceResume();
    const buf = this._core.buf;
    if (!buf || buf.pageState !== 3) {
      // 離開文章：下次再進同一篇要重新排到最前面。
      this._lastKey = null;
      this._lastInst = null;
      this._hideToast();
      return;
    }
    if (!this.enabled()) return;
    const cur = this.currentArticle();
    if (!cur) return;
    const key = recentKey(cur.board, cur.aid);
    if (key === this._lastKey) return;
    this._lastKey = key;
    this._lastInst = (this._core.view || {})._articleInstanceId;
    this.noteRead(cur);
  },

  resumeEnabled: function() {
    const p = readEffectivePrefs();
    return !!(p.enableRecentArticles && p.resumeRecentArticles);
  },

  // ---- 記位置：好讀文章的捲動停下來時量一次 ------------------------------------

  _bindScroll: function() {
    const disp = (this._core.view || {}).mainDisplay;
    if (!disp || this._scrollBound === disp || typeof disp.addEventListener !== 'function') return;
    this._scrollBound = disp;
    const self = this;
    disp.addEventListener(
      'scroll',
      function() {
        clearTimeout(self._sampleTimer);
        self._sampleTimer = setTimeout(function() {
          self._sampleTimer = null;
          self.samplePosition();
        }, RESUME_SAMPLE_MS);
      },
      { passive: true }
    );
  },

  // 只在「畫面靜止、好讀接手中、還是記下網址列的那一篇」時量：離開文章那一幀的重畫也會
  // 觸發捲動（scrollTop 歸零），那時 server 的畫面已經不是這篇了，量到的 0 不能記。
  // 好讀的一次性還原還沒落地時不量（視口停在頂端不代表讀到那裡）。
  samplePosition: function() {
    if (!this._lastKey || !this.resumeEnabled()) return false;
    const core = this._core;
    const buf = core.buf;
    const view = core.view || {};
    const er = core.easyReading;
    if (!buf || buf.pageState !== 3 || buf._settleTimer || !er || !er._enabled || er._functionMode) return false;
    if (er._pendingScrollRestore || view._articleInstanceId !== this._lastInst) return false;
    const article = recordFor(core).current({ view: view, buf: buf }).article;
    return this._saveLine(this._lastKey, resumeLineFromRecord(article));
  },

  // 只改「最近讀過」那一筆的 line，不換順序、不通知清單的聽眾（位置不顯示在任何清單上）。
  _saveLine: function(key, line) {
    const data = this.state;
    const i = data.recent.findIndex(function(e) {
      return recentKey(e.board, e.aid) === key;
    });
    if (i < 0 || (data.recent[i].line == null ? null : data.recent[i].line) === line) return false;
    const recent = data.recent.slice();
    recent[i] = withLine(recent[i], line);
    const next = { recent: recent, later: data.later };
    const raw = JSON.stringify(next);
    try {
      if (this._storage) this._storage.setItem(RECENT_ARTICLES_KEY, raw);
    } catch (e) {
      // 寫不進去：只活在記憶體。
    }
    this._raw = raw;
    this._data = next;
    return true;
  },

  // 上次讀到哪（最近讀過裡那一筆的 line）；沒有 ⇒ null。
  savedLine: function(key) {
    const hit = this.state.recent.find(function(e) {
      return recentKey(e.board, e.aid) === key;
    });
    return hit && hit.line != null ? hit.line : null;
  },

  // ---- 開回去：落地後捲到上次的位置 ---------------------------------------------

  _advanceResume: function() {
    const r = this._resume;
    if (!r) return;
    const core = this._core;
    const view = core.view || {};
    const buf = core.buf;
    const er = core.easyReading;
    const nav = core.aidNavigation;
    const landed = nav && typeof nav.currentPostAid === 'function' ? nav.currentPostAid() : null;
    const step = nextResumeStep({
      ageMs: Date.now() - r.at,
      navActive: !!(nav && nav.active),
      pageState: buf ? buf.pageState : null,
      inst: view._articleInstanceId,
      armedInst: r.armedInst,
      easy: !!(er && er._enabled && !er._functionMode),
      landedKey: landed ? recentKey(landed.board, landed.aid) : null,
      key: r.key
    });
    if (step === 'wait') return;
    this._resume = null;
    if (step !== 'apply' || !er.requestScrollRestore) {
      core.debugRecorder?.log('recentArticles.resume', { action: 'drop', key: r.key });
      return;
    }
    er.requestScrollRestore(r.line);
    core.debugRecorder?.log('recentArticles.resume', { action: 'apply', key: r.key, line: r.line });
    this._showToast();
  },

  // 「回到開頭」：收掉還沒落地的還原，捲回頂端。
  backToTop: function() {
    const core = this._core;
    const er = core.easyReading;
    if (er && er.cancelScrollRestore) er.cancelScrollRestore('recent-top');
    const disp = (core.view || {}).mainDisplay;
    if (disp) disp.scrollTop = 0;
    this._hideToast();
  },

  _showToast: function() {
    if (typeof document === 'undefined') return;
    let el = document.getElementById(RESUME_TOAST_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = RESUME_TOAST_ID;
      el.setAttribute('role', 'status');
      const text = document.createElement('span');
      text.className = 'recentResumeText';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'recentResumeTop';
      const self = this;
      // App 的滑鼠入口在 window：不搶 #t 焦點、不外傳成點終端機（App._onUploadLayer 也認它）。
      el.addEventListener('mousedown', function(e) {
        e.preventDefault();
        e.stopPropagation();
      });
      el.addEventListener('mouseup', function(e) {
        e.stopPropagation();
      });
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        self.backToTop();
      });
      el.appendChild(text);
      el.appendChild(btn);
      document.body.appendChild(el);
    }
    el.querySelector('.recentResumeText').textContent = i18n('recent_resumeHint');
    el.querySelector('.recentResumeTop').textContent = i18n('recent_resumeTop');
    el.hidden = false;
    clearTimeout(this._toastTimer);
    const self = this;
    this._toastTimer = setTimeout(function() {
      self._hideToast();
    }, RESUME_TOAST_MS);
  },

  _hideToast: function() {
    clearTimeout(this._toastTimer);
    this._toastTimer = null;
    if (typeof document === 'undefined') return;
    const el = document.getElementById(RESUME_TOAST_ID);
    if (el) el.hidden = true;
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
  // 上次讀到一半（最近讀過那一筆有 line）且已經開跳 ⇒ 落地後接著讀（_advanceResume）。
  // 收著等登入（'pending'）不接：登入前開不了清單，這條只會是別的入口。
  open: function(entry) {
    const dl = this._core && this._core.deepLinkController;
    if (!entry || !dl || typeof dl.request !== 'function') return false;
    // 落地不閃「已跳至 #AID」（P51）：開回自己清單上的那篇，文章出現就是回應；讀到一半的
    // 還有頂端「接著上次讀到的地方」，兩張提示疊在內文上（手機一上一下）只是噪音。
    const res = dl.request({ board: entry.board, aid: entry.aid }, { quietLanding: true });
    const key = recentKey(entry.board, entry.aid);
    const line = key ? this.savedLine(key) : null;
    this._resume =
      res === 'navigating' && line != null && this.resumeEnabled()
        ? { key: key, line: line, armedInst: (this._core.view || {})._articleInstanceId, at: Date.now() }
        : null;
    return !!res;
  }
};

export default RecentArticles;
