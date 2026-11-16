// 最近讀過的文章＋稍後閱讀（pref enableRecentArticles，預設開）。設計見
// docs/recent-articles.md —— 改這支之前先讀它。
//
// 三條規則：
//   1. **記的時候一個 byte 都不送**：文章身分＝看板＋AID，取自 aid_navigation.findLocalPostAid
//      （只讀文末「※ 文章網址:」那一列，不按 Q）；讀不到網址列（還沒捲到、轉錄文、站內信）
//      就不記。最近讀過只存在這個瀏覽器（localStorage）；稍後閱讀登入雲端同步時跨裝置同步
//      （pref syncReadLater，read_later_sync.js：逐篇新者為準、刪除留墓碑，增刪都同步）。
//   2. **開回去走既有入口**：點一筆 ＝ deepLinkController.request({ board, aid })，跟指令面板
//      貼文章網址同一條（登入前暫存、AID 跳文、閱讀紀錄、忙碌提示都由那條負責）。
//   3. 這裡只管清單：首頁儀表板、指令面板、右鍵選單只讀 state、呼叫 open／toggleLater。
//
// 接著上次讀到的地方（pref resumeRecentArticles，預設開）：好讀文章裡捲動時順手記下視窗頂端
// 那一列（閱讀紀錄的文章量測，記在「最近讀過」那一筆的 line）；開回去時 AID 跳文落地、
// 落地那篇確實是這一篇，才交給好讀的一次性還原（easy_reading.requestScrollRestore，累積到位
// 才捲）。只捲視口、一個 byte 都不多送；頂端閃一行「接著上次讀到的地方｜回到開頭」。

import { STORAGE_KEYS } from './user_data_keys';
import { readEffectivePrefs } from './pref_storage';
import { recordFor } from './reading_record';
import { i18n } from './i18n';
import { PAGE_STATE, screenOf } from './screen_model';
import {
  READ_LATER_LIMIT,
  readLaterKey,
  normalizeReadLaterMap,
  mergeReadLater,
  trimReadLater,
  liveReadLater,
  planReadLaterUpload,
  readLaterMapFromList
} from './read_later_sync';

export { READ_LATER_LIMIT };

export const RECENT_ARTICLES_KEY = STORAGE_KEYS.recentArticles;
// 稍後閱讀（含刪除的墓碑）：read_later_sync.js 的 map，跟雲端 users/{uid}.readLater 同一個形狀。
// 舊版放在 RECENT_ARTICLES_KEY 的 later 陣列，第一次讀時搬過來（_laterMap）。
export const READ_LATER_KEY = STORAGE_KEYS.readLater;
export const RECENT_ARTICLES_LIMIT = 30;
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
  if (s.navActive || s.pageState !== PAGE_STATE.READING || s.inst == null || s.inst === s.armedInst || !s.easy) return 'wait';
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

// cloud：稍後閱讀同步的接口（App 用 pref_sync 接，見 pttchrome.jsx；unit 給假的）：
//   { signedIn(): bool, upload(plan): Promise<bool>, subscribe(cb(rawMap)) }。沒給＝不同步。
// now：時間來源（unit 注入）。
export function RecentArticles(core, storage, cloud, now) {
  this._core = core;
  this._storage = storage !== undefined ? storage : safeLocalStorage();
  this._cloud = cloud || null;
  this._now = now || Date.now;
  this._listeners = new Set();
  this._raw = undefined;
  this._laterRaw = undefined;
  this._laterMapCache = {};
  this._data = { recent: [], later: [] };
  // 雲端的稍後閱讀（normalize 過的 map）。null＝還沒收到伺服器確定過的狀態。
  this._cloudLater = null;
  if (this._cloud && typeof this._cloud.subscribe === 'function') {
    const self = this;
    this._cloud.subscribe(function(raw) {
      self._onCloud(raw);
    });
  }
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
    const raw = this._getItem(RECENT_ARTICLES_KEY);
    const map = this._laterMap();
    if (raw !== this._raw || this._data.laterMap !== map) {
      this._raw = raw;
      this._data = { recent: parseRecentArticles(raw).recent, later: liveReadLater(map), laterMap: map };
    }
    return this._data;
  },

  _getItem: function(key) {
    try {
      return this._storage ? this._storage.getItem(key) : null;
    } catch (e) {
      return null;
    }
  },

  _setItem: function(key, raw) {
    try {
      if (this._storage) this._storage.setItem(key, raw);
    } catch (e) {
      // 寫不進去（隱私模式、配額）：只活在記憶體。
    }
  },

  // 稍後閱讀的 map（含墓碑）。每次比對 storage 原文（別的分頁寫的讀得到）。
  // 遷移：還沒有 v2 ⇒ 從舊版 v1 的 later 陣列搬過來，v1 拿掉 later（只搬一次）。
  _laterMap: function() {
    let raw = this._getItem(READ_LATER_KEY);
    if (raw == null && this._laterRaw === undefined) {
      const v1raw = this._getItem(RECENT_ARTICLES_KEY);
      let old = null;
      try {
        old = v1raw ? JSON.parse(v1raw) : null;
      } catch (e) {
        old = null;
      }
      const migrated = readLaterMapFromList(old && old.later);
      raw = JSON.stringify(migrated);
      this._setItem(READ_LATER_KEY, raw);
      if (old && Array.isArray(old.later)) this._setItem(RECENT_ARTICLES_KEY, JSON.stringify({ recent: old.recent || [] }));
      this._laterRaw = raw;
      this._laterMapCache = migrated;
      return migrated;
    }
    if (raw !== this._laterRaw) {
      let parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch (e) {
        parsed = null;
      }
      this._laterRaw = raw;
      this._laterMapCache = normalizeReadLaterMap(parsed);
    }
    return this._laterMapCache;
  },

  // 寫稍後閱讀：trim（上限、回收墓碑）→ 存 → 通知 → 同步上雲（upload＝false：收雲端時不必再比一次）。
  _writeLater: function(map, upload) {
    const next = trimReadLater(map, this._now());
    const raw = JSON.stringify(next);
    this._setItem(READ_LATER_KEY, raw);
    this._laterRaw = raw;
    this._laterMapCache = next;
    const data = this.state;
    this._listeners.forEach(function(fn) {
      fn(data);
    });
    if (upload !== false) this._syncCloud();
  },

  // pref syncReadLater（預設開）＋登入了雲端同步。
  cloudEnabled: function() {
    return (
      this.enabled() &&
      readEffectivePrefs().syncReadLater !== false &&
      !!this._cloud &&
      !!this._cloud.signedIn()
    );
  },

  // 雲端 snapshot（pref_sync 只在伺服器確定過的狀態才交過來）：逐篇合併進本機，再把本機贏的傳上去。
  _onCloud: function(raw) {
    this._cloudLater = normalizeReadLaterMap(raw);
    this._syncCloud();
  },

  // 把這台的變動寫上雲。雲端狀態還沒到就先不寫（不知道雲端有什麼就上傳，會把別台剛刪的又加回去：
  // 墓碑擋得住，但「還沒看過雲端」時連墓碑都還沒拿到）；下一個 snapshot 會再比一次。
  // 先把雲端贏的拉進本機（同步開關剛打開、剛登入時也靠這一步補齊），再把本機贏的傳上去。
  _syncCloud: function() {
    if (!this._cloudLater || !this.cloudEnabled()) return null;
    const local = this._laterMap();
    const merged = trimReadLater(mergeReadLater(local, this._cloudLater), this._now());
    if (JSON.stringify(merged) !== JSON.stringify(local)) this._writeLater(merged, false);
    const plan = planReadLaterUpload(this._laterMap(), this._cloudLater, this._now());
    if (!plan) return null;
    // 樂觀地把雲端當成已寫入：同一筆不重傳；真的失敗，下一個 snapshot 會再比出差異。
    const next = Object.assign({}, this._cloudLater, plan.set);
    plan.del.forEach(function(k) {
      delete next[k];
    });
    this._cloudLater = next;
    Promise.resolve(this._cloud.upload(plan)).catch(function() {});
    return plan;
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

  // 只寫最近讀過（稍後閱讀走 _writeLater）。data.later 不看。
  _write: function(data) {
    const raw = JSON.stringify({ recent: data.recent });
    try {
      if (this._storage) this._storage.setItem(RECENT_ARTICLES_KEY, raw);
    } catch (e) {
      // 寫不進去（無痕、容量滿）：這次只活在記憶體。
    }
    this._raw = raw;
    const map = this._laterMap();
    const next = { recent: data.recent, later: liveReadLater(map), laterMap: map };
    this._data = next;
    this._listeners.forEach(function(fn) {
      fn(next);
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
    if (!buf || !screenOf(buf).inArticle) {
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
    if (!buf || !screenOf(buf).inArticle || buf._settleTimer || !er || !er._enabled || er._functionMode) return false;
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
    const next = { recent: recent, later: data.later, laterMap: data.laterMap };
    const raw = JSON.stringify({ recent: recent });
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
      pageState: buf ? screenOf(buf).pageState : null,
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
    this._write({ recent: pushEntry(data.recent, e, RECENT_ARTICLES_LIMIT) });
    // 稍後閱讀裡那一筆沒有標題（從連結收的）⇒ 讀到時補上。**不動 mt**：補標題不是使用者的
    // 增刪，不可以蓋掉別台在這之後的刪除（同 mt 時 newerEntry 讓有標題的贏，別台照樣收得到）。
    const lk = readLaterKey(e.board, e.aid);
    const map = this._laterMap();
    const old = lk && map[lk];
    if (old && !old.del && !old.title && e.title) {
      const next = Object.assign({}, map);
      next[lk] = Object.assign({}, old, { title: e.title });
      this._writeLater(next);
    }
    return true;
  },

  isLater: function(key) {
    return this.state.later.some(function(e) {
      return recentKey(e.board, e.aid) === key;
    });
  },

  // 加一篇（墓碑也直接復活成新加的）。e 已 cleanEntry 過。
  _putLater: function(e) {
    const k = readLaterKey(e.board, e.aid);
    if (!k) return false;
    const t = this._now();
    const next = Object.assign({}, this._laterMap());
    next[k] = { board: e.board, aid: e.aid, title: e.title || '', at: t, mt: t };
    this._writeLater(next);
    return true;
  },

  // 刪一篇＝留墓碑（mt＝現在），別台同步到才知道要跟著刪。
  _dropLater: function(key) {
    const k = typeof key === 'string' ? key.replace('/', ':') : null;
    const map = this._laterMap();
    const old = k && map[k];
    if (!old || old.del) return false;
    const next = Object.assign({}, map);
    next[k] = Object.assign({}, old, { del: true, mt: Math.max(this._now(), old.mt + 1) });
    this._writeLater(next);
    return true;
  },

  // 右鍵選單「稍後閱讀」／「從稍後閱讀移除」。回傳切換後是否在清單裡；不合法 ⇒ null。
  toggleLater: function(entry, now) {
    const e = cleanEntry(Object.assign({}, entry, { at: now || this._now() }));
    if (!e) return null;
    const k = recentKey(e.board, e.aid);
    if (this.isLater(k)) {
      this._dropLater(k);
      return false;
    }
    return this._putLater(e) ? true : null;
  },

  // 列表的「稍後閱讀」（P53）：開選單時還不知道是哪一篇（AID 要按 Q 才問得到）⇒ 只收不移。
  // 'added' ／ 'exists'（本來就在，不動）／ null（不合法）。
  addLater: function(entry, now) {
    const e = cleanEntry(Object.assign({}, entry, { at: now || this._now() }));
    if (!e) return null;
    if (this.isLater(recentKey(e.board, e.aid))) return 'exists';
    return this._putLater(e) ? 'added' : null;
  },

  removeLater: function(key) {
    return this._dropLater(key);
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
