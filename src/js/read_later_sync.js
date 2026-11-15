// 稍後閱讀的跨裝置同步（docs/recent-articles.md「稍後閱讀同步」——改這支前先讀它）。
//
// 語意＝跟設定一樣：A 裝置加了 B 看得到，B 刪了 A 也跟著消失。做法是**每篇各自 last-writer-wins**：
//   一篇＝{ board, aid, title, at（加入的時間，排序用）, mt（最後一次增刪的時間）, del? }，
//   刪除不是把那筆拿掉，而是留一筆 del:true 的墓碑（tombstone）。兩邊對同一篇各有一筆時，mt 新的贏。
//   沒有墓碑的話，「B 刪了」跟「A 還沒傳上去」分不出來，A 下次同步又會把它加回去。
// 雲端放在偏好同一份文件 users/{uid} 的 `readLater` 欄位（map，key＝readLaterKey），本機放
// localStorage（recent_articles.js#READ_LATER_KEY），兩邊同一個形狀。
//
// 本檔是純函式（不碰 Firebase、不碰 storage），unit 守（tests/unit/read_later_sync.test.js）；
// 接線在 recent_articles.js（狀態）與 pref_sync.js（讀寫雲端）。

export const READ_LATER_LIMIT = 50;
// 墓碑留多久：離線的裝置超過這麼久才回來，它手上別台已刪的那幾篇會被加回來（可接受）。
export const READ_LATER_TOMBSTONE_MS = 60 * 24 * 3600 * 1000;
// 墓碑最多留幾筆（新的優先）：連墓碑一起 ≤ 50＋300 篇，firestore.rules 擋 400。
export const READ_LATER_TOMBSTONE_LIMIT = 300;
const TITLE_MAX = 120;
const BOARD_RE = /^[0-9A-Za-z][0-9A-Za-z_.-]{0,31}$/;
const AID_RE = /^[0-9A-Za-z_-]{8}$/;

// map 的 key：「看板小寫:AID」（Firestore 欄位名稱用 / 容易誤會成路徑）。
export function readLaterKey(board, aid) {
  if (!BOARD_RE.test(String(board || '')) || !AID_RE.test(String(aid || ''))) return null;
  return String(board).toLowerCase() + ':' + aid;
}

const num = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0);

// 一筆 → 乾淨的一筆；不合法回 null。
export function cleanReadLaterEntry(e) {
  if (!e || typeof e !== 'object') return null;
  if (!readLaterKey(e.board, e.aid)) return null;
  const at = num(e.at);
  const out = {
    board: String(e.board),
    aid: String(e.aid),
    title: typeof e.title === 'string' ? e.title.slice(0, TITLE_MAX) : '',
    at: at,
    mt: num(e.mt) || at,
  };
  if (e.del === true) out.del = true;
  return out;
}

// 讀回來的 map（雲端或本機）→ 乾淨的 { key: entry }。壞資料、key 對不上的一律丟掉。
export function normalizeReadLaterMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const k of Object.keys(raw)) {
    const e = cleanReadLaterEntry(raw[k]);
    if (e && readLaterKey(e.board, e.aid) === k) out[k] = e;
  }
  return out;
}

// 同一篇兩筆誰贏：mt 新的；一樣新時，活的贏過墓碑（加回來優先，不吃掉使用者的動作）、
// 有標題的贏過沒標題的；再一樣就 a（呼叫端放本機）。
export function newerEntry(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  if (a.mt !== b.mt) return a.mt > b.mt ? a : b;
  if (!!a.del !== !!b.del) return a.del ? b : a;
  if (!a.title && b.title) return b;
  return a;
}

// 兩份 map 逐篇合併。
export function mergeReadLater(local, cloud) {
  const out = {};
  const keys = new Set(Object.keys(local || {}).concat(Object.keys(cloud || {})));
  keys.forEach((k) => {
    out[k] = newerEntry((local || {})[k], (cloud || {})[k]);
  });
  return out;
}

// 清單上限與墓碑回收：
//   - 活的超過 READ_LATER_LIMIT ⇒ 最舊的（at）變成墓碑（mt＝now），跟使用者自己刪一樣會同步出去；
//   - 墓碑超過 READ_LATER_TOMBSTONE_MS，或超過 READ_LATER_TOMBSTONE_LIMIT 筆的舊墓碑 ⇒ 整筆拿掉。
// 每台裝置照同一個規則做 ⇒ 收斂到同一個結果。回傳新的 map（不改輸入）。
export function trimReadLater(map, now) {
  const out = Object.assign({}, map || {});
  const live = Object.keys(out)
    .filter((k) => !out[k].del)
    .sort((x, y) => out[y].at - out[x].at || (x < y ? -1 : 1));
  for (const k of live.slice(READ_LATER_LIMIT)) out[k] = Object.assign({}, out[k], { del: true, mt: Math.max(now, out[k].mt) });
  const dead = Object.keys(out)
    .filter((k) => out[k].del)
    .sort((x, y) => out[y].mt - out[x].mt || (x < y ? -1 : 1));
  dead.forEach((k, i) => {
    if (i >= READ_LATER_TOMBSTONE_LIMIT || now - out[k].mt > READ_LATER_TOMBSTONE_MS) delete out[k];
  });
  return out;
}

// 首頁、指令面板看的清單：活的那幾篇，新加的在前。
export function liveReadLater(map) {
  return Object.keys(map || {})
    .map((k) => map[k])
    .filter((e) => !e.del)
    .sort((a, b) => b.at - a.at);
}

// 這台要寫上雲的變動：{ set: { key: entry }, del: [key] }；沒事回 null。
// 以「本機＋雲端合併、再 trim」的結果為準：
//   - 結果跟雲端那筆不一樣（本機贏了、或上限把它變成墓碑）⇒ set（墓碑也上傳）；
//   - 雲端有、結果裡被回收掉的（過期或超量的墓碑）⇒ del。
export function planReadLaterUpload(local, cloud, now) {
  const c = cloud || {};
  const merged = trimReadLater(mergeReadLater(local, c), now);
  const set = {};
  const del = [];
  for (const k of Object.keys(merged)) if (!c[k] || !sameEntry(merged[k], c[k])) set[k] = merged[k];
  for (const k of Object.keys(c)) if (!merged[k]) del.push(k);
  if (!Object.keys(set).length && !del.length) return null;
  return { set: set, del: del };
}

function sameEntry(a, b) {
  return (
    a.board === b.board &&
    a.aid === b.aid &&
    a.title === b.title &&
    a.at === b.at &&
    a.mt === b.mt &&
    !!a.del === !!b.del
  );
}

// 舊版本機的「稍後再讀」陣列（recent_articles v1 的 later，每筆 { board, aid, title, at }）→ map。
// 遷移只做一次（recent_articles.js#_readLaterMap）。
export function readLaterMapFromList(list) {
  const out = {};
  (Array.isArray(list) ? list : []).forEach((raw) => {
    const e = cleanReadLaterEntry(Object.assign({}, raw, { mt: raw && raw.at, del: false }));
    if (!e) return;
    const k = readLaterKey(e.board, e.aid);
    if (!out[k]) out[k] = e;
  });
  return out;
}
