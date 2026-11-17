// 設定備份「閱讀紀錄」（P98；架構 review A10 ④「備份涵蓋全部」）：把使用者累積、掉了會心疼的
// 本機紀錄匯出成一個檔案，換手機／重灌時匯入。設計見 docs/user-data.md「設定備份」。
//
// 規則：
//   - 涵蓋 USER_DATA 裡 kind＝history 的 localStorage 紀錄（HISTORY_BACKUP_IDS；守護
//     tests/unit/history_backup.test.js 對 user_data_keys.USER_DATA 的 backup 欄）。離線文章（IndexedDB）
//     有自己的匯出入（saved_articles.js），設定本身走 pref_backup.js，三者分開。
//   - **匯入＝合併，不蓋掉這台**：同一筆取比較新的（各種紀錄自己的時間欄），沒有時間欄的（最近看板、
//     搜尋紀錄）這台的排前面；各自照擁有者原本的上限截掉。
//   - 不上雲（稍後閱讀若開著雲端同步，照原本的同步規則之後才會上去）、不送鍵、不含憑證（這些鍵本來就
//     不存帳密／token）。
//   - 檔案不可信：每一筆都照擁有者的形狀檢查，對不上的丟掉；網址欄位只收 http／https。
import { readJson, readRaw, writeJson, defaultStorage } from './user_data';
import { parseRecentArticles, recentKey, RECENT_ARTICLES_LIMIT } from './recent_articles';
import {
  normalizeReadLaterMap,
  mergeReadLater,
  trimReadLater,
  readLaterMapFromList,
} from './read_later_sync';
import { NEW_COMMENTS_LIMIT } from './new_comments';
import { BOARD_TABS_MAX } from './board_tabs';
import { RECENT_LIMIT } from './home_dashboard';
import { MAX_SEARCH_HISTORY } from './search_history';
import { MAX_HISTORY } from './upload_history';

export const HISTORY_BACKUP_KIND = 'history';
export const HISTORY_BACKUP_VERSION = 1;

/** 匯出的紀錄種類（user_data_keys.STORAGE_KEYS 的 id），順序＝匯出檔裡的順序。 */
export const HISTORY_BACKUP_IDS = Object.freeze([
  'recentArticles',
  'readLater',
  'newComments',
  'boardTabs',
  'homeRecentBoards',
  'searchHistory',
  'uploadHistory',
]);

const BOARD_RE = /^[0-9A-Za-z][0-9A-Za-z_.-]{0,31}$/;
const HTTP_RE = /^https?:\/\/\S+$/i;
const SEARCH_KINDS = ['title', 'author', 'push', 'board'];
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0);

// ── 各種紀錄：clean（檔案或本機讀到的值 → 乾淨的值，認不出回 null）＋ merge（本機, 匯入, now）──

function cleanRecent(v) {
  if (!isObj(v)) return null;
  return parseRecentArticles(JSON.stringify({ recent: v.recent })).recent;
}
// 同一篇取 at 新的那筆（標題、讀到的位置缺的話用另一筆補），整份照 at 由新到舊。
function mergeRecent(local, incoming) {
  const byKey = new Map();
  for (const e of (local || []).concat(incoming || [])) {
    const k = recentKey(e.board, e.aid);
    const old = byKey.get(k);
    if (!old) {
      byKey.set(k, e);
      continue;
    }
    const [win, lose] = e.at > old.at ? [e, old] : [old, e];
    const out = Object.assign({}, win, { title: win.title || lose.title || '' });
    if (out.line == null && lose.line != null) out.line = lose.line;
    byKey.set(k, out);
  }
  return Array.from(byKey.values())
    .sort((a, b) => b.at - a.at)
    .slice(0, RECENT_ARTICLES_LIMIT);
}

function cleanNewComments(v) {
  if (!isObj(v)) return null;
  const out = {};
  for (const k of Object.keys(v)) {
    const e = v[k];
    // 鍵＝new_comments.articleKey：「看板小寫/AID」。值＝[推文數, 時間, …列表用的欄位]。
    if (!/^[0-9a-z][0-9a-z_.-]{0,31}\/[0-9A-Za-z_-]{8}$/.test(k)) continue;
    if (!Array.isArray(e) || typeof e[0] !== 'number' || typeof e[1] !== 'number') continue;
    // 後面幾欄（列表「+N」用：分數、作者、標題、日期，new_comments.saveSeen）形狀不對就只留前兩欄，
    // 不然列表比對標題時（long_push_anchor.subjectMatches）會拿到非字串。
    const tail =
      e.length >= 5 &&
      typeof e[2] === 'number' &&
      typeof e[3] === 'string' &&
      typeof e[4] === 'string' &&
      (e.length === 5 || (e.length === 6 && typeof e[5] === 'string'));
    out[k] = tail ? e.slice() : [e[0], e[1]];
  }
  return out;
}
function mergeNewComments(local, incoming) {
  const all = Object.assign({}, local || {});
  for (const k of Object.keys(incoming || {})) {
    if (!all[k] || incoming[k][1] > all[k][1]) all[k] = incoming[k];
  }
  const keys = Object.keys(all);
  if (keys.length > NEW_COMMENTS_LIMIT)
    keys
      .sort((a, b) => all[a][1] - all[b][1])
      .slice(0, keys.length - NEW_COMMENTS_LIMIT)
      .forEach((k) => delete all[k]);
  return all;
}

function cleanBoardTabs(v) {
  if (!Array.isArray(v)) return null;
  return v
    .filter((t) => t && typeof t.name === 'string' && BOARD_RE.test(t.name))
    .map((t) => ({ name: t.name, at: num(t.at) }));
}
// 這台的分頁位置不動；匯入的新板接在後面；同一個板取比較新的時間；超過上限丟最久沒去的。
function mergeBoardTabs(local, incoming) {
  const list = (local || []).map((t) => Object.assign({}, t));
  for (const t of incoming || []) {
    const i = list.findIndex((x) => x.name.toLowerCase() === t.name.toLowerCase());
    if (i >= 0) list[i].at = Math.max(list[i].at, t.at);
    else list.push(Object.assign({}, t));
  }
  while (list.length > BOARD_TABS_MAX) {
    let oldest = 0;
    for (let k = 1; k < list.length; ++k) if (list[k].at < list[oldest].at) oldest = k;
    list.splice(oldest, 1);
  }
  return list;
}

function cleanRecentBoards(v) {
  if (!Array.isArray(v)) return null;
  return v.filter((n) => typeof n === 'string' && BOARD_RE.test(n));
}
// 沒有時間欄：這台的順序在前，匯入的補在後面（不分大小寫去重）。
function mergeNames(local, incoming, limit, same) {
  const out = [];
  for (const n of (local || []).concat(incoming || [])) if (!out.some((x) => same(x, n))) out.push(n);
  return out.slice(0, limit);
}
const sameBoard = (a, b) => a.toLowerCase() === b.toLowerCase();
const sameText = (a, b) => a === b;

function cleanSearch(v) {
  if (!isObj(v)) return null;
  const out = {};
  for (const k of SEARCH_KINDS)
    out[k] = Array.isArray(v[k]) ? v[k].filter((t) => typeof t === 'string' && t.trim()) : [];
  return out;
}
function mergeSearch(local, incoming) {
  const out = {};
  for (const k of SEARCH_KINDS)
    out[k] = mergeNames((local || {})[k], (incoming || {})[k], MAX_SEARCH_HISTORY, sameText);
  return out;
}

// 上傳紀錄的網址會被畫成 <img src>／連結 ⇒ 只收 http／https，其他欄位只留字串。
function cleanUploads(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const e of v) {
    if (!e || typeof e.url !== 'string' || !HTTP_RE.test(e.url)) continue;
    const c = { url: e.url, at: num(e.at) };
    for (const key of ['deleteUrl', 'previewUrl']) if (typeof e[key] === 'string' && HTTP_RE.test(e[key])) c[key] = e[key];
    for (const key of ['filename', 'mime']) if (typeof e[key] === 'string') c[key] = e[key];
    out.push(c);
  }
  return out;
}
function mergeUploads(local, incoming) {
  const out = (local || []).slice();
  for (const e of incoming || []) if (!out.some((x) => x.url === e.url)) out.push(e);
  return out.sort((a, b) => num(b.at) - num(a.at)).slice(0, MAX_HISTORY);
}

const KINDS = {
  recentArticles: { clean: cleanRecent, merge: mergeRecent },
  readLater: {
    clean: (v) => (isObj(v) ? normalizeReadLaterMap(v) : null),
    merge: (local, incoming, now) => trimReadLater(mergeReadLater(local || {}, incoming || {}), now),
  },
  newComments: { clean: cleanNewComments, merge: mergeNewComments },
  boardTabs: { clean: cleanBoardTabs, merge: mergeBoardTabs },
  homeRecentBoards: {
    clean: cleanRecentBoards,
    merge: (l, i) => mergeNames(l, i, RECENT_LIMIT, sameBoard),
  },
  searchHistory: { clean: cleanSearch, merge: mergeSearch },
  uploadHistory: { clean: cleanUploads, merge: mergeUploads },
};

/** 一種紀錄有幾筆（匯出／匯入的提示用）。 */
export function historyCount(id, value) {
  if (value == null) return 0;
  if (id === 'readLater') return Object.keys(value).filter((k) => !value[k].del).length;
  if (id === 'newComments') return Object.keys(value).length;
  if (id === 'searchHistory') return SEARCH_KINDS.reduce((n, k) => n + value[k].length, 0);
  return Array.isArray(value) ? value.length : 0;
}

// 本機現在的值（已清乾淨）。最近讀過存的是 { recent: [...] }，這裡只取清單。
function readLocal(id, storage) {
  return KINDS[id].clean(readJson(id, storage));
}

/**
 * 匯出檔。只放有東西的種類；total＝全部幾筆（0 ⇒ 呼叫端不下載）。
 * @param {Storage | null} [storage]
 * @param {Date} [now]
 */
export function buildHistoryExport(storage = defaultStorage(), now = new Date()) {
  const data = {};
  let total = 0;
  for (const id of HISTORY_BACKUP_IDS) {
    const v = readLocal(id, storage);
    const n = historyCount(id, v);
    if (!n) continue;
    data[id] = id === 'recentArticles' ? { recent: v } : v;
    total += n;
  }
  return {
    payload: {
      app: 'pttchrome',
      kind: HISTORY_BACKUP_KIND,
      schemaVersion: HISTORY_BACKUP_VERSION,
      exportedAt: now.toISOString(),
      data,
    },
    total,
  };
}

/** @param {Date} [now] */
export function historyFileName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return 'pttchrome-history-' + now.getFullYear() + p(now.getMonth() + 1) + p(now.getDate()) + '.json';
}

/**
 * 匯入檔 → 乾淨的 { id: value }。不是 JSON ⇒ badJson；不是這種匯出檔、或版本比這版新 ⇒ badFormat。
 * @param {string} text
 */
export function parseHistoryExport(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: 'badJson' };
  }
  if (
    !isObj(obj) ||
    obj.app !== 'pttchrome' ||
    obj.kind !== HISTORY_BACKUP_KIND ||
    !Number.isInteger(obj.schemaVersion) ||
    obj.schemaVersion < 1 ||
    obj.schemaVersion > HISTORY_BACKUP_VERSION ||
    !isObj(obj.data)
  )
    return { ok: false, reason: 'badFormat' };
  const data = {};
  for (const id of HISTORY_BACKUP_IDS) {
    if (!(id in obj.data)) continue;
    const v = KINDS[id].clean(obj.data[id]);
    if (v != null) data[id] = v;
  }
  return { ok: true, data };
}

// 還沒遷移到稍後閱讀 v2 的本機（v1 的 later 還在最近讀過裡）：先把它當成本機的稍後閱讀，
// 不然寫進 v2 之後 recent_articles 就不再遷移，v1 那份等於被丟掉。
function localReadLater(storage) {
  if (readRaw('readLater', storage) != null) return readLocal('readLater', storage) || {};
  const v1 = readJson('recentArticles', storage);
  return readLaterMapFromList(isObj(v1) ? v1.later : null);
}

/**
 * 匯入：逐種跟本機合併後寫回。回傳 { ok, imported（匯入檔裡共幾筆）, kinds（寫了幾種）, failed（寫不進去的種類數） }。
 * @param {string} text
 * @param {Storage | null} [storage]
 * @param {number} [now]
 */
export function importHistory(text, storage = defaultStorage(), now = Date.now()) {
  const parsed = parseHistoryExport(text);
  if (!parsed.ok) return parsed;
  let imported = 0;
  let kinds = 0;
  let failed = 0;
  for (const id of HISTORY_BACKUP_IDS) {
    if (!(id in parsed.data)) continue;
    const incoming = parsed.data[id];
    const n = historyCount(id, incoming);
    if (!n) continue;
    imported += n;
    const local = id === 'readLater' ? localReadLater(storage) : readLocal(id, storage);
    const merged = KINDS[id].merge(local, incoming, now);
    let value = merged;
    // 最近讀過：整份物件的其他欄位（舊版 v1 的 later）照留，只換 recent。
    if (id === 'recentArticles') {
      const raw = readJson(id, storage);
      value = Object.assign({}, isObj(raw) ? raw : {}, { recent: merged });
    }
    if (writeJson(id, value, storage)) kinds++;
    else failed++;
  }
  return { ok: true, imported, kinds, failed };
}
