// 存到本機（P64）：存下好讀模式讀到的整篇，之後在唯讀頁打開。設計見 docs/saved-articles.md ——
// 改這支之前先讀它。
//
// 三條規則：
//   1. **存的時候一個 byte 都不送**：內容只取好讀累積頁（buf.pageLines），身分取自文末網址列
//      （aid_navigation.findLocalPostAid，不按 Q）；讀不到網址列、不在好讀文章裡就不能存。
//   2. **打開＝另開一頁唯讀頁**（`?saved=<key>`）：那一頁不 connect()（view.conn 恆 undefined ⇒
//      送不出任何鍵），畫面走 term_view.showStaticArticle（同一個 #mainContainer、同一條
//      _renderScreenLines），不會跟活連線搶畫面、也不佔 PTT 連線名額。
//   3. 只存在這個瀏覽器（IndexedDB，saved_articles_store.js），不上雲。
import {
  buildSavedArticle,
  decodeRows,
  buildSavedExport,
  parseSavedExport,
  savedExportFileName,
} from './saved_article_codec';
import { SavedArticlesStore } from './saved_articles_store';
import { HINT_ERROR } from './status_hint';
import { i18n } from './i18n';
import { readEffectivePrefs } from './pref_storage';

export const SAVED_QUERY_KEY = 'saved';
const HINT_MS = 2500;

// 唯讀頁的網址（同一個站、只多一個 query）。base 是目前頁面的網址。
export function savedReaderUrl(base, key) {
  const u = new URL(base);
  u.hash = '';
  u.search = '';
  u.searchParams.set(SAVED_QUERY_KEY, key);
  return u.toString();
}

// 這一頁是不是唯讀頁：回傳 key 或 null。key 的形狀＝saved_article_codec.savedArticleKey。
export function savedReaderKeyFrom(search) {
  let v = null;
  try {
    v = new URLSearchParams(search || '').get(SAVED_QUERY_KEY);
  } catch (e) {
    return null;
  }
  return v && /^[0-9a-z_.-]+\/[0-9A-Za-z_-]{8}$/.test(v) ? v : null;
}

// 現在能不能存（純判斷，給入口決定要不要出現）：好讀開著、在文章裡、不在 functionMode、
// 累積頁非空、讀得到本篇網址列。
export function savableArticle(core) {
  const view = core && core.view;
  const buf = core && core.buf;
  const er = core && core.easyReading;
  if (!view || !buf || !er) return null;
  if (!view.useEasyReadingMode || buf.pageState !== 3 || !er._enabled) return null;
  if (buf.easyReadingFunctionMode) return null;
  if (!buf.pageLines || !buf.pageLines.length) return null;
  const nav = core.aidNavigation;
  const hit = nav && typeof nav.findLocalPostAid === 'function' ? nav.findLocalPostAid() : null;
  if (!hit || !hit.board || !hit.aid) return null;
  return hit;
}

export function SavedArticles(core, store) {
  this._core = core;
  this._store = store || new SavedArticlesStore();
  // 清單摘要（首頁「本機收藏」畫這份）。null＝還沒讀過；refresh() 讀 IndexedDB 後通知。
  this.state = null;
  this._listeners = [];
}

SavedArticles.prototype = {
  // pref enableSavedArticles（預設開）。關掉＝入口全部不出現；已存的不刪，打開唯讀頁照常。
  enabled: function () {
    return readEffectivePrefs().enableSavedArticles !== false;
  },

  canSave: function () {
    return this.enabled() && !!savableArticle(this._core);
  },

  onChange: function (fn) {
    this._listeners.push(fn);
    const self = this;
    return function () {
      self._listeners = self._listeners.filter((l) => l !== fn);
    };
  },

  // 重讀清單並通知（首頁打開時、存／刪之後）。別的分頁存的，下次 refresh 就看得到。
  refresh: async function () {
    const list = await this._store.list();
    this.state = list;
    this._listeners.forEach((fn) => fn(list));
    return list;
  },

  // 存目前這一篇。回傳 store.put 的結果（{ ok, replaced } 或 { ok:false, reason }），並提示。
  saveCurrent: async function () {
    const core = this._core;
    const hit = savableArticle(core);
    if (!hit) return this._hint({ ok: false, reason: 'notArticle' });
    const buf = core.buf;
    const acc = buf.pageLines;
    const texts = new Array(acc.length);
    for (let r = 0; r < acc.length; ++r) texts[r] = buf.getRowText(r, 0, buf.cols, acc);
    const rec = buildSavedArticle({
      rows: acc,
      rowTexts: texts,
      board: hit.board,
      aid: hit.aid,
      url: hit.url || '',
      cols: buf.cols,
    });
    const res = rec ? await this._store.put(rec) : { ok: false, reason: 'invalid' };
    if (res.ok) this.refresh();
    return this._hint(res);
  },

  _hint: function (res) {
    const view = this._core && this._core.view;
    if (view && view.flashListHint) {
      if (res.ok) view.flashListHint(i18n(res.replaced ? 'saved_updated' : 'saved_done'), HINT_MS);
      else view.flashListHint(i18n('saved_failed_' + res.reason), HINT_MS, HINT_ERROR);
    }
    return res;
  },

  list: function () {
    return this._store.list();
  },

  remove: async function (key) {
    const res = await this._store.remove(key);
    this.refresh();
    return res;
  },

  // 在新分頁打開唯讀頁。
  open: function (key, win) {
    const w = win || (typeof window !== 'undefined' ? window : null);
    if (!w || !key) return false;
    w.open(savedReaderUrl(w.location.href, key), '_blank', 'noopener');
    return true;
  },
};

// 匯出／匯入（設定 → 備份「本機收藏」）。設定頁拿不到 App，直接開同一個 IndexedDB；首頁的清單
// 下次出現時自己重讀。回傳 { count } 匯出了幾篇（0 篇不下載）。
export async function exportSavedArticles(download, store, now) {
  const s = store || new SavedArticlesStore();
  const records = await s.all();
  if (!records.length) return { count: 0 };
  const payload = buildSavedExport(records, now);
  await download(savedExportFileName(now), JSON.stringify(payload), 'application/json');
  return { count: payload.articles.length };
}

// 回傳 { ok:false, reason:'badJson'|'badFormat' } 或 { ok:true, added, replaced, skipped, full }：
// 同一篇＝覆蓋；放不下（200 篇上限）的算 full，不自動刪舊的。
export async function importSavedArticles(text, store) {
  const parsed = parseSavedExport(text);
  if (!parsed.ok) return parsed;
  const s = store || new SavedArticlesStore();
  const res = { ok: true, added: 0, replaced: 0, skipped: parsed.skipped, full: 0 };
  for (const rec of parsed.records) {
    const r = await s.put(rec);
    if (r.ok) res[r.replaced ? 'replaced' : 'added']++;
    else if (r.reason === 'full') res.full++;
    else res.skipped++;
  }
  return res;
}

// 唯讀頁的按鍵：這一頁沒有連線，任何鍵都送不到 PTT ⇒ 只拿來捲動（鍵位照 pmore：
// 空白／PgDn／f 下一頁、PgUp／b 上一頁、↓／j／Enter 下一列、↑／k 上一列、Home／g／0 頂、
// End／G／$ 底）。回傳：{ top } 捲到哪；{ top: null } 吞掉（不是捲動鍵，免得被當成打字）；
// null 不管（Ctrl／Alt／Meta 組合鍵留給瀏覽器：Ctrl+F、複製…）。
// m：{ scrollTop, scrollHeight, clientHeight, lineHeight }。
export function staticReaderKey(e, m) {
  if (!e || e.ctrlKey || e.altKey || e.metaKey) return null;
  const max = Math.max(0, (m.scrollHeight | 0) - (m.clientHeight | 0));
  const page = Math.max(1, Math.round((m.clientHeight | 0) * 0.9));
  const line = Math.max(1, m.lineHeight | 0);
  const at = (t) => ({ top: Math.min(max, Math.max(0, Math.round(t))) });
  switch (e.key) {
    case 'Home':
    case 'g':
    case '0':
      return at(0);
    case 'End':
    case 'G':
    case '$':
      return at(max);
    case ' ':
    case 'PageDown':
    case 'f':
      return at(m.scrollTop + page);
    case 'PageUp':
    case 'b':
      return at(m.scrollTop - page);
    case 'ArrowDown':
    case 'j':
    case 'Enter':
      return at(m.scrollTop + line);
    case 'ArrowUp':
    case 'k':
      return at(m.scrollTop - line);
    default:
      return { top: null };
  }
}

// 唯讀頁開機：讀存檔 → 還原 → 畫。找不到／壞掉 ⇒ 畫一行說明（不連線、不 throw）。
// 回傳 'shown' | 'missing'。
export async function bootSavedReader(core, key, store) {
  const s = store || new SavedArticlesStore();
  const rec = await s.get(key);
  const rows = rec ? decodeRows(rec.body, Object.getPrototypeOf(core.buf.attr)) : null;
  if (typeof document !== 'undefined') {
    document.documentElement.classList.add('savedReader');
    if (rec && rec.title) document.title = rec.title + ' - ' + i18n('saved_readerTitle');
  }
  if (!rows || !rows.length) {
    if (core.view && core.view.flashListHint)
      core.view.flashListHint(i18n('saved_missing'), 600000, HINT_ERROR);
    return 'missing';
  }
  core.view.showStaticArticle(rows);
  // 手機底部導覽／App Bar 換成唯讀頁的版本（mobile_toolbar.staticReaderContext）：這一頁不會有
  // screenSettled，自己通知一次。
  if (typeof core._refreshScreenContext === 'function') core._refreshScreenContext();
  return 'shown';
}
