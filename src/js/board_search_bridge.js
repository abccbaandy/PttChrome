// 搜尋彈窗的「看板」種類：比照 PTT 原生的看板名稱補全（docs/article-search.md
// 「看板：原生補全橋接」）。
//
// 原生行為（mbbsd/name.c#generalnamecomplete，CompleteBoard 巨集，include/proto.h）：
//   - 每打一個字，gnc_cb_data 用 SHM->bsorted 二分搜「有沒有看得到的看板以這串開頭」
//     （completeboard_permission：非 symbolic、非群組、有讀取權限），沒有就 bell 並
//     丟掉那個字 ⇒ 不存在的看板根本打不進去。
//   - 空白鍵（gnc_cb_peek）：輸入延伸到所有符合者的共同前綴（只剩一個就補完整名），
//     並從第 2 列畫「相關資訊一覽表」、第 3 列起逐欄列出符合的看板；還有下一頁時
//     底列 vshowmsg「按空白鍵可列出更多項目」。
//   - Enter：唯一符合或完全相符才進板，否則字串清空（＝什麼都不做）。
//
// 看板清單只在 server 端（含權限過濾，隱板／秘密板因人而異），client 沒有可信的
// 離線來源 ⇒ 彈窗開在看板種類時，**背景開著原生 `s` prompt**，把輸入同步過去、讀回
// 它畫出來的補全清單。每一趟都是「退格清空 → 重打 → 空白鍵列表 → \f 保證整幀」，
// 由共用 CommandQueue 序列化（一次一條在飛，最新的輸入勝出，不必 debounce）。
//
// 收尾三條路，全部經佇列、都握著 core.searchInFlight（關掉彈窗後到 prompt 消失前
// 使用者按的鍵不可落進 prompt，理由同 article_search.js 的在途閘門）：
//   submit → 退格清空 ＋ 板名 ＋ Enter；cancel → Ctrl-C（vtuikit.c 只認 Ctrl-C 或空
//   字串為取消，ESC 不是）；prompt 根本沒開出來 → failed，呼叫端改走 submitSearch。
import {
  BOARD_PROMPT,
  isSearchPromptFrame,
  searchGateFacts,
  beginInFlight,
  endInFlight
} from './article_search';
import { recordFor } from './reading_record';

// IDLEN（include/pttstruct.h）：看板名稱最長 12 字元。
export const BOARD_NAME_MAX = 12;

const LIST_TITLE = '相關資訊一覽表'; // name.c COMPLETE_LIST_TITLE
const MORE_MSG = '按空白鍵可列出更多項目'; // name.c COMPLETE_MORE_MSG
const LIST_START_ROW = 3; // GNC_PAGE_START_Y(2) 是分隔線，清單從下一列開始

// 彈窗輸入 → 可以送進 namecomplete 的字串：只留可列印 ASCII（VGET 只收 ASCII，
// gnc_cb_data 對非 ASCII 一律 bell）、拿掉空白（空白鍵是「自動搜尋」不是內容）、
// 截到 IDLEN。
export function sanitizeBoardQuery(text) {
  return String(text == null ? '' : text)
    .replace(/[^\x21-\x7e]/g, '')
    .slice(0, BOARD_NAME_MAX);
}

// 一幀「看板名稱 prompt」的內容。不是這個 prompt 回 null。
//   field：PTT 輸入欄目前的字（含空白鍵延伸出來的部分）
//   candidates：第 3 列起的補全清單（依 PTT 的欄優先順序＝看板名稱排序）；沒畫清單
//               ＝ null
//   more：底列有「按空白鍵可列出更多項目」＝清單只是第一頁
export function parseBoardPromptFrame(facts) {
  if (!facts || !isSearchPromptFrame('board', facts)) return null;
  const rowTexts = facts.rowTexts || [];
  const rows = facts.rows || rowTexts.length;
  const line = rowTexts[1] || '';
  // 「: 」之後就是輸入欄（板名不含空白）；空白數不寫死，只取第一個字串。
  const field = (line.slice(BOARD_PROMPT.length).match(/^:?\s*(\S*)/) || ['', ''])[1];
  let candidates = null;
  if ((rowTexts[2] || '').indexOf(LIST_TITLE) >= 0) {
    // ShowVector／gnc 都是「先往下填滿一欄再換下一欄」⇒ 依起始欄、再依列排序。
    const found = [];
    for (let r = LIST_START_ROW; r < rows - 1; ++r) {
      const re = /\S+/g;
      let m;
      while ((m = re.exec(rowTexts[r] || ''))) found.push({ col: m.index, row: r, name: m[0] });
    }
    found.sort((a, b) => a.col - b.col || a.row - b.row);
    candidates = found.map((it) => it.name);
  }
  const more = (rowTexts[rows - 1] || '').indexOf(MORE_MSG) >= 0;
  return { field: field, candidates: candidates, more: more };
}

// 「查 text」這一趟的回應幀成立了沒（成立回 frame）。空字串＝只清空輸入欄。
// 非空時空白鍵一定會重畫清單（輸入欄永遠是合法前綴），而且每一項都以延伸後的
// 輸入欄開頭 —— 用它排掉還掛著上一趟清單的中間幀。
function judgeSyncFrame(text, facts) {
  const frame = parseBoardPromptFrame(facts || {});
  if (!frame) return false;
  if (!text) return frame.field === '' ? frame : false;
  if (!frame.candidates) return false;
  const f = frame.field.toLowerCase();
  return frame.candidates.every((c) => c.toLowerCase().indexOf(f) === 0) ? frame : false;
}

// 打進去的字有幾個被 PTT 收下：與輸入欄（大小寫不分）的共同前綴長度。
// 被拒的那個字之後的字可能又被收下（每個字各自判），但它們絕不會跟原字串對上
// （同前綴同字母會一樣被拒），所以共同前綴就是「第一個被拒的字」的位置。
export function acceptedPrefixLength(query, field) {
  const a = String(query || '').toLowerCase();
  const b = String(field || '').toLowerCase();
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) ++i;
  return i;
}

// 這次查詢的結論（給彈窗用）。rejected ＝ 這串開頭沒有看得到的看板。
export function boardQueryResult(query, frame) {
  const accepted = acceptedPrefixLength(query, frame.field);
  const rejected = accepted < query.length;
  return {
    query: query,
    accepted: accepted,
    rejected: rejected,
    // 空白鍵延伸後的字（共同前綴／唯一符合的完整板名）；被拒時沒有意義。
    completion: rejected ? query : frame.field,
    candidates: rejected ? [] : frame.candidates || [],
    more: !rejected && !!frame.more
  };
}

// 按 Enter 會進到哪個看板（name.c generalnamecomplete 收尾的同一條規則：唯一符合，
// 或完全相符）。判不出來回 ''。
export function resolvedBoardName(result, text) {
  if (!result || !text || result.rejected) return '';
  if (result.query.toLowerCase() !== String(text).toLowerCase()) return '';
  const list = result.candidates || [];
  if (list.length === 1 && !result.more) return list[0];
  // 清單依板名排序，完全相符的那個一定排第一（它是所有符合者的前綴）。
  if (list.length && list[0].toLowerCase() === result.query.toLowerCase()) return list[0];
  return '';
}

// 查詢還在飛時先顯示的清單：上一份收下的清單裡以目前輸入開頭的那些（大小寫不分）。
// 以 q 開頭的看板必定也以 q 的任何前綴開頭 ⇒ 上一份（較短前綴）篩下來不會多出錯的板；
// 上一份若被截斷（more）可能少列，回來的結果會補上 —— 只是過渡，不拿來判送出。
// 彈窗靠它讓清單在打字時不先清空再長回來（docs/article-search.md「彈窗版面」）。
export function interimCandidates(last, query) {
  if (!last || last.rejected || !query) return [];
  const q = query.toLowerCase();
  if (q.indexOf(last.query.toLowerCase()) !== 0 && last.query.toLowerCase().indexOf(q) !== 0) return [];
  return (last.candidates || []).filter((c) => c.toLowerCase().indexOf(q) === 0);
}

function noop() {}

// core：App（commandQueue、activeListSession、buf、searchInFlight）。
// onUpdate({ status, result })：status ∈ opening／ready／unavailable。
// opts.onCancel：{ onDone, onFail(reason) }，取消（彈窗關掉）的收尾回呼。onDone ＝ Ctrl-C
// 之後 prompt 已收掉；onFail('no-prompt') ＝ prompt 從沒開出來（原畫面沒動過），其他
// reason ＝ 收尾途中丟失（停在哪不確定）。送出過就不會再回報取消。
export function BoardSearchBridge(core, onUpdate, opts) {
  this._core = core;
  this._onUpdate = onUpdate || noop;
  this._cancelCb = (opts && opts.onCancel) || {};
  this._closed = false; // submit／cancel 已經叫過（收尾只有一次）
  this._opened = false; // prompt 已開出來
  this._dead = false; // prompt 沒開出來／被 flush／已收尾
  this._busy = false; // 有一條自己的命令在飛
  this._field = ''; // PTT 輸入欄目前的字（決定下一趟要退格幾次）
  this._desired = '';
  this._queried = ''; // 最近一趟送出去查的字（prompt 開出來時輸入欄是空的）
  this._result = null;
  this._final = null; // { type: 'submit'|'cancel', text, cb }
  // 閱讀紀錄（決策表 'board-search'）：prompt 一開，列表就切到原生鏡像；取消／開不
  // 出來時要把視野還回去，送出（換板）則不還原。
  this._bookmark = core ? recordFor(core).begin('board-search') : null;
  this._open();
}

BoardSearchBridge.prototype = {
  get status() {
    if (this._dead && !this._final) return 'unavailable';
    return this._opened ? 'ready' : 'opening';
  },

  get result() {
    return this._result;
  },

  query: function(text) {
    this._desired = sanitizeBoardQuery(text);
    this._pump();
  },

  // 回 false ＝ 橋接用不了（prompt 沒開出來／已收尾），呼叫端改走 submitSearch。
  submit: function(text, cb) {
    if (this._final || this._dead) return false;
    this._closed = true;
    this._final = { type: 'submit', text: sanitizeBoardQuery(text), cb: cb || {} };
    beginInFlight(this._core);
    this._pump();
    return true;
  },

  cancel: function() {
    if (this._closed) return;
    this._closed = true;
    const cb = this._cancelCb;
    if (this._dead) {
      // prompt 沒開出來（或已丟失）：沒有東西要收。
      if (cb.onFail) cb.onFail(this._opened ? 'lost' : 'no-prompt');
      return;
    }
    this._final = { type: 'cancel', cb: cb };
    beginInFlight(this._core);
    this._pump();
  },

  _emit: function() {
    this._onUpdate({ status: this.status, result: this._result });
  },

  _queue: function() {
    return this._core && this._core.commandQueue;
  },

  _open: function() {
    const self = this;
    const core = this._core;
    const step = {
      keys: 's',
      kind: 'search-board-open',
      expect: function(snapshot, facts) {
        return parseBoardPromptFrame(facts || {});
      },
      onDone: function(frame) {
        self._busy = false;
        self._opened = true;
        self._field = frame.field;
        self._emit();
        self._pump();
      },
      onFail: function() {
        self._lost();
      },
      onFlushed: function() {
        self._lost();
      }
    };
    this._busy = true;
    const owner =
      core && typeof core.activeListSession === 'function' ? core.activeListSession() : null;
    if (owner && typeof owner._beginPassthroughBytes === 'function') {
      // 同 submitSearch：序列化交易進行中（開文／凍結中的指令）時線路歸它。
      if (owner.state === 'opening' || (owner.state === 'functionMode' && owner._renderMode === 'frozen')) {
        this._busy = false;
        this._dead = true;
        return;
      }
      owner._beginPassthroughBytes([step], { kind: 'search-board', hint: null });
      return;
    }
    const queue = this._queue();
    if (!queue) {
      this._busy = false;
      this._dead = true;
      return;
    }
    queue.enqueue(Object.assign({ fullRepaint: true }, step));
  },

  // prompt 沒開出來，或命令被別的擁有者 flush 掉（離板、開文…）：此後不再送任何鍵。
  _lost: function() {
    this._busy = false;
    const wasOpened = this._opened;
    this._dead = true;
    const fin = this._final;
    this._final = null;
    this._endRecord('fail');
    if (fin) {
      endInFlight(this._core);
      // prompt 從沒開出來＝PTT 不接受 `s`（同 submitSearch 第一步的 onFail）；
      // 開出來之後才丟失＝送出途中被別的擁有者 flush。兩者都不重送。
      if (fin.cb.onFail) fin.cb.onFail(wasOpened ? 'lost' : 'no-prompt');
    }
    this._emit();
  },

  // 下一趟要退格幾次：優先量當下畫面（最可信），量不到才用上一幀記下來的。
  _clearKeys: function() {
    const frame = parseBoardPromptFrame(searchGateFacts(this._core));
    const n = frame ? frame.field.length : this._field.length;
    return '\b'.repeat(n);
  },

  _pump: function() {
    if (this._busy || !this._opened || this._dead) return;
    if (this._final) return this._runFinal();
    if (this._desired === this._queried) return;
    this._sync(this._desired);
  },

  _sync: function(text) {
    const self = this;
    const queue = this._queue();
    if (!queue) return this._lost();
    this._busy = true;
    this._queried = text;
    const cmd = {
      keys: '',
      kind: 'search-board-sync',
      // \f：被拒的字 PTT 只回一個 bell、不重畫 ⇒ 沒有 \f 就沒有 settle 可判。
      fullRepaint: true,
      onSend: function() {
        cmd.keys = self._clearKeys() + text + (text ? ' ' : '');
      },
      expect: function(snapshot, facts) {
        return judgeSyncFrame(text, facts);
      },
      onDone: function(frame) {
        self._busy = false;
        self._field = frame.field;
        self._result = text ? boardQueryResult(text, frame) : null;
        self._emit();
        self._pump();
      },
      onFail: function(reason, facts) {
        const now = facts || searchGateFacts(self._core) || {};
        const judged = judgeSyncFrame(text, now);
        // 只收「這串整個被收下」的幀：沒回應時畫面停在上一趟，上一趟的輸入欄比
        // 這次短，會被讀成「後面的字被拒」⇒ 彈窗把使用者打的字砍掉。
        if (judged && acceptedPrefixLength(text, judged.field) === text.length) return cmd.onDone(judged);
        self._busy = false;
        const frame = parseBoardPromptFrame(now);
        if (!frame) return self._lost();
        // prompt 還在，只是判不出結論（server 沒回、畫面被別的東西蓋掉）：記下輸入欄，
        // 結論標 unknown —— 彈窗不擋送出（Enter 交給 PTT 自己判），也不卡在「查詢中」。
        self._field = frame.field;
        self._result = text ? Object.assign(boardQueryResult(text, { field: text }), { unknown: true }) : null;
        self._emit();
        self._pump();
      },
      onFlushed: function() {
        self._lost();
      }
    };
    queue.enqueue(cmd);
  },

  _runFinal: function() {
    const self = this;
    const fin = this._final;
    const queue = this._queue();
    if (!queue) return this._lost();
    this._busy = true;
    const isSubmit = fin.type === 'submit';
    const cmd = {
      keys: '',
      kind: isSubmit ? 'search-board-submit' : 'search-board-cancel',
      // submit 同 submitSearch 的第二步：Enter 之後不加 \f（進板畫面自己會整幀重畫）。
      fullRepaint: !isSubmit,
      onSend: function() {
        cmd.keys = isSubmit ? self._clearKeys() + fin.text + '\r' : '\x03';
      },
      expect: function(snapshot, facts) {
        return !isSearchPromptFrame('board', facts || {});
      },
      onDone: function(result) {
        self._finish();
        self._endRecord(isSubmit ? 'done' : 'cancel');
        if (fin.cb.onDone) fin.cb.onDone(result);
      },
      onFail: function() {
        self._finish();
        self._endRecord('fail');
        if (fin.cb.onFail) fin.cb.onFail();
      },
      onFlushed: function() {
        self._finish();
        if (fin.cb.onFail) fin.cb.onFail('lost');
      }
    };
    queue.enqueue(cmd);
  },

  _finish: function() {
    this._busy = false;
    this._dead = true;
    this._final = null;
    endInFlight(this._core);
  },

  // 書籤只交回一次（_lost 與收尾命令的 onFail 可能都會走到）。
  _endRecord: function(outcome) {
    const bm = this._bookmark;
    if (!bm) return;
    this._bookmark = null;
    recordFor(this._core).end(bm, outcome);
  }
};
