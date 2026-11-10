// 存到本機（P64）的儲存層：IndexedDB，兩個 object store：
//   meta：清單用的摘要（saved_article_codec.savedArticleMeta），首頁／指令面板只讀這個；
//   body：整篇（buildSavedArticle 的完整紀錄，含 encodeRows 的內文），打開那一篇才讀。
// 設計見 docs/saved-articles.md。
//
// 規則：
//   1. **只存在這個瀏覽器、不上雲**（跟「最近讀過」一樣；內文可能很大，Firestore 額度扛不住）。
//   2. **滿了就拒絕，不自動刪舊的**：存檔是使用者明確留下的東西，偷偷刪掉比存不進去更糟。
//   3. IndexedDB 在私密視窗／被封鎖時會 throw 或 open 失敗 ⇒ 每個操作都回 Promise，失敗
//      resolve 成 { ok: false, reason }（不 reject），呼叫端只要照結果提示。
import { savedArticleMeta } from './saved_article_codec';

export const SAVED_DB_NAME = 'pttchrome-saved-articles';
export const SAVED_DB_VERSION = 1;
export const SAVED_ARTICLES_LIMIT = 200;
// 單篇上限（列數）。22000 行的超長文約 1.8M 格，放得下；再大就拒絕，免得一篇吃掉配額。
export const SAVED_ARTICLE_MAX_LINES = 30000;

function req2promise(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('transaction aborted'));
  });
}

export function SavedArticlesStore(opts) {
  const o = opts || {};
  this._idb = o.indexedDB !== undefined ? o.indexedDB : globalThis.indexedDB;
  this._name = o.name || SAVED_DB_NAME;
  this._limit = o.limit || SAVED_ARTICLES_LIMIT;
  this._maxLines = o.maxLines || SAVED_ARTICLE_MAX_LINES;
  this._db = null;
}

SavedArticlesStore.prototype = {
  _open: function () {
    if (this._db) return this._db;
    this._db = new Promise((resolve, reject) => {
      if (!this._idb) {
        reject(new Error('indexedDB unavailable'));
        return;
      }
      let r;
      try {
        r = this._idb.open(this._name, SAVED_DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('body')) db.createObjectStore('body', { keyPath: 'key' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('indexedDB blocked'));
    });
    // 開失敗不要把壞掉的 Promise 留著：下次再試（例如使用者解除封鎖網站資料）。
    this._db.catch(() => {
      this._db = null;
    });
    return this._db;
  },

  // 清單（新存的在前）。失敗回 []。
  list: async function () {
    try {
      const db = await this._open();
      const tx = db.transaction('meta', 'readonly');
      const all = await req2promise(tx.objectStore('meta').getAll());
      return all
        .map(savedArticleMeta)
        .filter(Boolean)
        .sort((a, b) => b.savedAt - a.savedAt);
    } catch (e) {
      return [];
    }
  },

  has: async function (key) {
    try {
      const db = await this._open();
      const tx = db.transaction('meta', 'readonly');
      return !!(await req2promise(tx.objectStore('meta').get(key)));
    } catch (e) {
      return false;
    }
  },

  // 整篇紀錄；沒有或壞掉回 null。
  get: async function (key) {
    try {
      const db = await this._open();
      const tx = db.transaction('body', 'readonly');
      const rec = await req2promise(tx.objectStore('body').get(key));
      return rec && savedArticleMeta(rec) ? rec : null;
    } catch (e) {
      return null;
    }
  },

  // rec：buildSavedArticle 的輸出。同一篇再存一次＝覆蓋（更新到現在讀到的版本），不佔新名額。
  put: async function (rec) {
    const meta = savedArticleMeta(rec);
    if (!meta || !rec.body) return { ok: false, reason: 'invalid' };
    if (meta.lineCount > this._maxLines) return { ok: false, reason: 'tooLarge' };
    try {
      const db = await this._open();
      const tx = db.transaction(['meta', 'body'], 'readwrite');
      const metaStore = tx.objectStore('meta');
      const existing = await req2promise(metaStore.get(meta.key));
      if (!existing) {
        const count = await req2promise(metaStore.count());
        if (count >= this._limit) {
          tx.abort();
          return { ok: false, reason: 'full' };
        }
      }
      metaStore.put(meta);
      tx.objectStore('body').put(rec);
      await txDone(tx);
      return { ok: true, replaced: !!existing };
    } catch (e) {
      return { ok: false, reason: e && e.name === 'QuotaExceededError' ? 'quota' : 'error' };
    }
  },

  remove: async function (key) {
    try {
      const db = await this._open();
      const tx = db.transaction(['meta', 'body'], 'readwrite');
      tx.objectStore('meta').delete(key);
      tx.objectStore('body').delete(key);
      await txDone(tx);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: 'error' };
    }
  },

  close: function () {
    const p = this._db;
    this._db = null;
    if (p) p.then((db) => db.close(), () => {});
  },
};
