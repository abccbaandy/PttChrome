// 本機收藏的清單同步到雲端（P70）。設計見 docs/saved-articles.md「清單同步到雲端」——改這支前先讀它。
//
// 只同步**清單**（看板、AID、標題、作者、存的時間，一篇約 200 byte），內文永遠只在這個瀏覽器
// （IndexedDB）。雲端放在偏好同一份文件 users/{uid} 的 `saved` 欄位：一個 map，key＝cloudKey，
// value＝一篇的摘要。用 map 不用陣列：每台裝置只 set／deleteField 自己動到的那幾篇
// （setDoc merge:true 逐 key 合併），兩台同時存不會互相蓋掉整份清單。
//
// 本檔是純函式（不碰 Firebase、不碰 IndexedDB），unit 守；接線在 saved_articles.js（狀態）
// 與 pref_sync.js（讀寫雲端）。

import { savedArticleKey } from './saved_article_codec';

// 雲端清單上限：每台裝置本機最多 200 篇（SAVED_ARTICLES_LIMIT），幾台裝置聯集起來可能更多，
// 超過就丟掉最舊、而且這台沒存的。firestore.rules 用同一個數字擋（300 篇 × 約 200 byte ≈ 60KB，
// 遠低於文件 1MB 上限，也不會讓每次偏好同步多帶太多）。
export const CLOUD_SAVED_LIMIT = 300;
const TITLE_MAX = 120;
const AUTHOR_MAX = 40;
const BOARD_RE = /^[0-9A-Za-z][0-9A-Za-z_.-]{0,31}$/;
const AID_RE = /^[0-9A-Za-z_-]{8}$/;

// map 的 key：本機 key（「看板小寫/AID」）把 / 換成 :（Firestore 欄位名稱用 / 容易誤會成路徑）。
export function cloudKey(board, aid) {
  const k = savedArticleKey(board, aid);
  return k ? k.replace('/', ':') : null;
}

// 本機清單的一列（saved_article_codec.savedArticleMeta）→ 雲端的一篇。看板／AID 不合法回 null。
export function cloudEntryFromMeta(m) {
  if (!m || !BOARD_RE.test(String(m.board || '')) || !AID_RE.test(String(m.aid || ''))) return null;
  return {
    board: String(m.board),
    aid: String(m.aid),
    title: String(m.title || '').slice(0, TITLE_MAX),
    author: String(m.author || '').slice(0, AUTHOR_MAX),
    savedAt: typeof m.savedAt === 'number' && isFinite(m.savedAt) ? m.savedAt : 0,
  };
}

// 雲端讀回來的 map → 乾淨的 { key: entry }（別台裝置、舊版或手改的壞資料一律丟掉）。
export function normalizeCloudSaved(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const k of Object.keys(raw)) {
    const e = cloudEntryFromMeta(raw[k]);
    if (e && cloudKey(e.board, e.aid) === k) out[k] = e;
  }
  return out;
}

// 首頁「其他裝置存的」：雲端有、這台沒存的，新存的在前。
export function othersFromCloud(cloud, localList) {
  const mine = new Set((localList || []).map((m) => cloudKey(m.board, m.aid)));
  return Object.keys(cloud || {})
    .filter((k) => !mine.has(k))
    .map((k) => cloud[k])
    .sort((a, b) => b.savedAt - a.savedAt);
}

// 這台要寫上雲的變動：{ set: { key: entry }, del: [key] }；沒事回 null。
//   - removed：這台剛刪的 key ⇒ del（只在使用者刪的那一刻給；別台還留著的不會被這裡刪）；
//   - 這台有、雲端沒有（或雲端那筆比較舊）⇒ set，新存的優先；
//   - 雲端滿了（CLOUD_SAVED_LIMIT）：只准擠掉**比要加的那篇更舊**、而且不是這台存的那篇；
//     擠不掉就這篇不上雲。每次擠掉都是「舊的換新的」⇒ 好幾台裝置一起超過上限時，
//     雲端單調往「最新的 N 篇」收斂，不會互相刪來刪去。
export function planCloudUpload({ cloud, localList, removed }) {
  const c = cloud || {};
  const del = new Set();
  for (const k of removed || []) if (k && c[k]) del.add(k);
  const live = new Map(Object.keys(c).filter((k) => !del.has(k)).map((k) => [k, c[k]]));
  const mine = new Set();
  const want = [];
  for (const m of localList || []) {
    const e = cloudEntryFromMeta(m);
    if (!e) continue;
    const k = cloudKey(e.board, e.aid);
    if (del.has(k)) continue;
    mine.add(k);
    const have = live.get(k);
    if (!have || have.savedAt < e.savedAt) want.push([k, e]);
  }
  want.sort((a, b) => b[1].savedAt - a[1].savedAt);
  const set = {};
  for (const [k, e] of want) {
    if (!live.has(k) && live.size >= CLOUD_SAVED_LIMIT) {
      let victim = null;
      for (const [vk, ve] of live)
        if (!mine.has(vk) && ve.savedAt < e.savedAt && (!victim || ve.savedAt < live.get(victim).savedAt)) victim = vk;
      if (!victim) continue;
      live.delete(victim);
      del.add(victim);
    }
    live.set(k, e);
    set[k] = e;
  }
  if (!Object.keys(set).length && !del.size) return null;
  return { set, del: [...del] };
}
