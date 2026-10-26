// 新推文標記（pref markNewComments，預設開）：重開讀過的文章時，上次讀完之後才出現的推文
// 前面畫一條灰色細線「以下是新推文」，浮動工具面板多一顆「跳到新推文」。設計見
// docs/new-comments.md —— 改這支之前先讀它。
//
// 三條規則：
//   1. **一個 byte 都不送**：推文數取自好讀的累積頁（buf.pageLines），文章身分是看板＋AID
//      （aid_navigation.findLocalPostAid，只讀文末的網址列，不按 Q）。紀錄只存在這個瀏覽器
//      （localStorage，不上雲）。
//   2. **只在好讀讀到文末才記**：沒讀完的文章不算「看過」，下次照樣不標。
//   3. **推文的數法＝樓層的數法**（comment_parse.FloorCounter，BePTT 演算法）：過了
//      「※ 發信站／文章網址」那一列之後的第 k 則推文。兩邊用同一個計數器，記的與找的對得上。
//      新格式推文（`│` 內容列）目前不算 ⇒ 那種文章不標（認不出 ⇒ 不動）。
//
// 文章列表的「+N」（pref listNewPushCount，預設開）也住在這裡：讀完時順手記下這篇的
// 推噓分（推 +1、噓 -1、→ 0，＝pttbbs post.c 改 .DIR recommend 的規則）與作者＋主題，
// 列表上同一板、作者＋主題對得上唯一一筆紀錄、推文數欄是精確數字（1～99）時，顯示
// 「列表推文數 − 讀完時的分數」（> 0 才顯示）。一樣一個 byte 都不送。

import { parseComment, FloorCounter } from './comment_parse';
import { readEffectivePrefs } from './pref_storage';
import { parseListEntry } from './agent_parse';
import { listRowIdentity, subjectKey, subjectMatches } from './long_push_anchor';

export const NEW_COMMENTS_KEY = 'pttchrome.newComments.v1';
// 最多記幾篇（超過丟最久沒讀的）。一篇一筆 [推文數, 時間]，一千篇約 40KB。
export const NEW_COMMENTS_LIMIT = 1000;

// ---------------------------------------------------------------------------
// 純邏輯（tests/unit/new_comments.test.js）
// ---------------------------------------------------------------------------

// 逐列餵文字，記下第 k 則推文在哪一列（只算過了文末 meta 列之後的）。
export class CommentScanner {
  constructor() {
    this.counter = new FloorCounter();
    this.rows = []; // rows[k-1] ＝第 k 則推文的列
    this.scanned = 0;
    this.score = 0; // 推噓分（只算過了文末 meta 列之後的）
  }

  feed(text) {
    const row = this.scanned++;
    const c = parseComment(text);
    if (!c) {
      this.counter.nonComment(text);
      return;
    }
    const f = this.counter.next(c.type);
    if (!this.counter.metaSeen) return;
    this.rows[f.seq - 1] = row;
    if (c.type === '推') this.score++;
    else if (c.type === '噓') this.score--;
  }

  get count() {
    return this.counter.metaSeen ? this.counter.seq : 0;
  }

  // 上次看到 seen 則 ⇒ 第 seen+1 則（第一則新推文）在哪一列；還沒有／沒讀到 ⇒ null。
  rowAfter(seen) {
    if (seen == null || seen < 0) return null;
    const r = this.rows[seen];
    return r == null ? null : r;
  }
}

export function articleKey(board, aid) {
  return board && aid ? String(board).toLowerCase() + '/' + aid : null;
}

function readAll(storage) {
  try {
    return parseAll(storage.getItem(NEW_COMMENTS_KEY));
  } catch (e) {
    return {};
  }
}

function parseAll(raw) {
  try {
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v : {};
  } catch (e) {
    return {};
  }
}

export function loadSeen(storage, key) {
  if (!storage || !key) return null;
  const e = readAll(storage)[key];
  return Array.isArray(e) && typeof e[0] === 'number' ? e[0] : null;
}

// 記下這篇讀完時的推文數；超過上限丟最久的。
// info（可省）＝{ score, author, subject }：列表的「+N」用（listNewPush）。
export function saveSeen(storage, key, count, now, limit, info) {
  if (!storage || !key) return;
  const all = readAll(storage);
  all[key] = info && info.author && info.subject
    ? [count, now, info.score | 0, String(info.author).toLowerCase(), info.subject]
    : [count, now];
  const keys = Object.keys(all);
  const cap = limit || NEW_COMMENTS_LIMIT;
  if (keys.length > cap) {
    keys
      .sort((a, b) => (all[a][1] || 0) - (all[b][1] || 0))
      .slice(0, keys.length - cap)
      .forEach((k) => delete all[k]);
  }
  try {
    storage.setItem(NEW_COMMENTS_KEY, JSON.stringify(all));
  } catch (e) {
    // 滿了／被擋：這次不記，下次照樣不標。
  }
}

// 列表「+N」的快取鍵（進 annotationsKey）：紀錄的原文或看板一變就換號，整批重算。
let badgeRevision = 0;

// 列表推文數欄（pttbbs bbs.c#readdoent）→ 精確的推噓分；「爆」「XX」「X5」、空白（0 與
// -1～-10 都畫成空白）這類不精確的值 ⇒ null。
export function listRecommendValue(recommend) {
  const t = String(recommend || '').trim();
  if (!/^\d{1,2}$/.test(t)) return null;
  const v = parseInt(t, 10);
  return v >= 1 && v <= 99 ? v : null;
}

// 某一板的紀錄 → [{ author, subject, score }]（只收帶身分的新格式紀錄）。
export function boardRecords(all, board) {
  const out = [];
  if (!all || !board) return out;
  const prefix = String(board).toLowerCase() + '/';
  for (const k of Object.keys(all)) {
    if (k.indexOf(prefix) !== 0) continue;
    const e = all[k];
    if (!Array.isArray(e) || e.length < 5 || typeof e[2] !== 'number' || !e[3] || !e[4]) continue;
    out.push({ author: e[3], subject: e[4], score: e[2] });
  }
  return out;
}

// 列表的一列 → 讀完之後多了幾分（> 0 才回數字）；認不出、對到零筆或多筆、推文數不精確 ⇒ null。
export function listNewPush(records, text) {
  if (!records || !records.length) return null;
  const e = parseListEntry(text || '');
  if (!e || e.deleted || e.locked) return null;
  const now = listRecommendValue(e.recommend);
  if (now == null) return null;
  const id = listRowIdentity(text);
  if (!id) return null;
  let hit = null;
  for (const r of records) {
    if (r.author !== id.author || !subjectMatches(id.subject, r.subject)) continue;
    if (hit) return null; // 同作者同主題好幾篇讀過：分不出是哪一篇，不標
    hit = r;
  }
  if (!hit || hit.score <= -100 || hit.score >= 100) return null;
  const d = now - hit.score;
  return d > 0 ? d : null;
}

function defaultStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 控制器
// ---------------------------------------------------------------------------

export function NewComments(core, storage) {
  this._core = core;
  this._storage = storage === undefined ? defaultStorage() : storage;
  this._reset(null);
  const self = this;
  if (core.buf && core.buf.addEventListener)
    core.buf.addEventListener('screenSettled', function() {
      self._onSettled();
    });
}

NewComments.prototype = {
  _reset: function(head) {
    this._head = head;
    this._scanner = new CommentScanner();
    this._key = null;
    // 這篇開文時讀到的「上次看到幾則」：整段閱讀期間不變（讀完會寫新的進 storage，但
    // 這一次的標線照舊標在原處）。undefined ＝還不知道是哪一篇。
    this._seen = undefined;
    this._saved = null;
  },

  // 累積頁同步：換文章（_articleInstanceId 變了、首列變了、變短）就重來；只餵新列。
  _sync: function(lines) {
    const buf = this._core.buf;
    const head = lines.length ? buf.getRowText(0, 0, buf.cols, lines) : null;
    const inst = (this._core.view || {})._articleInstanceId;
    // 換文章的權威訊號是 view._articleInstanceId（accumulatePageLines 'rebuild' 分支 bump）：首列是
    // 「作者 … 看板 …」，同作者同看板的兩篇一字不差，下一篇又比上一篇長時首列與長度都認不出來。
    // 認錯會把這一篇的推文數記到上一篇的紀錄裡。
    if (inst !== this._inst || head !== this._head || lines.length < this._scanner.scanned) this._reset(head);
    this._inst = inst;
    for (let r = this._scanner.scanned; r < lines.length; ++r) this._scanner.feed(buf.getRowText(r, 0, buf.cols, lines));
    if (this._key) return;
    const view = this._core.view || {};
    const nav = this._core.aidNavigation;
    const local = nav && typeof nav.findLocalPostAid === 'function' ? nav.findLocalPostAid() : null;
    const key = articleKey(view._articleBoard, local && local.aid);
    if (!key) return;
    this._key = key;
    this._seen = loadSeen(this._storage, key);
  },

  // 反向讀取（End）把新頁插在中間：列號會位移、餵進去的順序也不是文章順序 ⇒ 掃描作廢，
  // 接合完成後從頭重掃（看板／AID／上次看到幾則留著）。
  _reversing: function() {
    const er = this._core.easyReading;
    if (!er || !er._reverse) return false;
    this._scanner = new CommentScanner();
    return true;
  },

  // term_view 每次畫好讀累積頁時問：第一則新推文在哪一列（pageLines 的列號）；沒有 ⇒ null。
  rowFor: function(lines) {
    if (!readEffectivePrefs().markNewComments || !lines || !lines.length) return null;
    if (this._reversing()) return null;
    this._sync(lines);
    if (this._seen == null) return null;
    return this._scanner.rowAfter(this._seen);
  },

  // term_view 畫文章列表時問：{ key, fn(text) }（key 進 annotationsKey）；關掉／認不出板 ⇒ null。
  listBadge: function(board) {
    if (!board || !this._storage || !readEffectivePrefs().listNewPushCount) return null;
    // 列表每一幀都會問：原文沒變就沿用上次解析的結果（別的分頁寫的也認得出來）。
    let raw = null;
    try {
      raw = this._storage.getItem(NEW_COMMENTS_KEY);
    } catch (e) {
      return null;
    }
    const lb = String(board).toLowerCase();
    let c = this._badgeCache;
    if (!c || c.raw !== raw || c.board !== lb) {
      c = this._badgeCache = { raw: raw, board: lb, records: boardRecords(parseAll(raw), lb), rev: ++badgeRevision };
    }
    const records = c.records;
    if (!records.length) return null;
    return {
      key: lb + '#' + c.rev,
      fn: function(text) {
        return listNewPush(records, text);
      }
    };
  },

  _onSettled: function() {
    const core = this._core;
    const er = core.easyReading;
    const buf = core.buf;
    const prefs = readEffectivePrefs();
    // 兩個功能共用這份紀錄：任一個開著就記。
    if (!prefs.markNewComments && !prefs.listNewPushCount) return;
    if (!buf || buf.pageState !== 3 || !er || !er._enabled || er._functionMode || this._reversing()) return;
    if (!er.easyReadingReachedPageEnd) return;
    const lines = buf.pageLines || [];
    if (!lines.length) return;
    this._sync(lines);
    const count = this._scanner.count;
    if (!this._key || !count || count === this._saved) return;
    const view = core.view || {};
    saveSeen(this._storage, this._key, count, Date.now(), null, {
      score: this._scanner.score,
      author: view._articleAuthor,
      subject: subjectKey(view._articleTitle)
    });
    this._saved = count;
  }
};

export default NewComments;
