// 說明選單好讀（docs/help-menu.md）：PTT 2026-10 新版的 `h` 說明改成可點的游標選單
// （mbbsd/psb.c#cmd_show_help_layers_inner），分頁顯示、pageState 判不出（舊版是 pmore
// 文字檔，所以以前文章好讀會接手；新版不會）。好讀開著時改由彈窗（桌機）／bottom sheet
// （手機）一次列出**全部頁**的指令，點一下就執行。
//
// ---- pttbbs 事實（3rd_script/pttbbs main@908bb063，Big5；PTT 邏輯不准猜）----
// 1. 版型（cmd_show_help_layers_inner）：
//      row 0       vs_header(caption, "操作說明 (Help)")      ⇒ 「【<caption>】 … 操作說明 (Help)」
//      row 1       vbar(ANSI_REVERSE "  按鍵 / 標籤                   功能說明")
//      row 2..     每列一項 psb_help_print_row：prints("  %s%*s  %s\n", itembuf, pad, "", helpstr)，
//                  itembuf ＝ "(<keys>) <label>" 或 "(<keys>)"，pad ＝ 28 - 寬度
//      b_lines     footer：caption「操作說明」＋（多頁時）" [第 x/y 頁]"＋按鈕 " (k)名"…＋靠右的
//                  "(q/←)離開"；有小天使時多一顆 "(h)小天使"
//    每頁 rows ＝ t_lines - 3 項；起始 curr = 0（恆從第 1 頁開始）；游標＝cursor_key(2+curr-base, 0)
//    在 col 0 寫 `>`。
// 2. 分頁對齊：鍵盤路徑 `base = (curr / rows) * rows` ⇒ 頁永遠是 [0,rows) [rows,2rows) …。
//    唯一例外是 server 端滑鼠滾輪（base ± 1），只在 client 送 SGR 回報時發生（pref
//    mouseServerReport，預設關）。⇒ 合併時以項目身分去重，不只靠頁碼算索引。
// 3. 按鍵：↑/k/p/^P、↓/j/n/^N、PgUp/^B/P、PgDn/^F/N/空白（curr ± rows，夾在 [0,count-1]）、
//    Home/'0'（curr=0）、End/'$'、Enter/→ ＝回傳 items[curr].keys[0]（呼叫端 bbs_cmd_help 把它
//    當成使用者按的鍵重新派送）、h/H ＝小天使、q/Q/← ＝離開（回 0）。其餘鍵忽略。
//    ⇒ 執行第 t 項＝Home → PgDn×⌊t/rows⌋ → ↓×(t mod rows) → Enter，與當下游標在哪無關。
// 4. 同一個畫面在看板列表、文章列表、主功能表、閱讀文章（more.c）、編輯器（edit.c）都有，
//    caption 依呼叫端（「我的最愛」「文章閱讀」…）。
//
// 認不出 ⇒ 原生：指紋任一要素失配、任一項目列解析不了、第一張不是第 1 頁 ⇒ 不接管。
import { readValuesWithDefault } from './pref_storage';

export const HELP_TITLE = '操作說明 (Help)';
export const KEY_HOME = '\x1b[1~';
export const KEY_PGDN = '\x1b[6~';
export const KEY_DOWN = '\x1b[B';
export const KEY_ENTER = '\r';
export const KEY_QUIT = 'q';
export const KEY_ANGEL = 'h';

// 送了 PgDn 之後等下一頁的上限；逾時就只列已拿到的頁（不重送：PgDn 在最後一頁不會動）。
export const FETCH_TIMEOUT_MS = 3000;
// 送出執行／離開鍵之後，畫面還停在說明選單多久就放手（保持原生，不再彈出）。
export const LEAVE_TIMEOUT_MS = 4000;
// 佇列有別人的命令在途時，等多久再看一次。
const WIRE_RETRY_MS = 150;

const HEADER_RE = /^\s*按鍵 \/ 標籤\s+功能說明\s*$/;
const CAPTION_RE = /^\s*【\s*(.*?)\s*】/;
const PAGE_RE = /\[第\s*(\d+)\s*\/\s*(\d+)\s*頁\]/;
const ANGEL_RE = /\(h\)小天使/;
// "(<keys>) <label>" ＋ 兩格以上空白 ＋ helpstr；label／helpstr 都可能沒有。
const ITEM_RE = /^\((.+?)\)(?: (\S(?:.*?\S)?))?(?: {2,}(\S(?:.*\S)?))?\s*$/;

// 鍵名以 `/` 分隔（psb_help_format_keys）；`/` 鍵本身寫成 `(/)`，會切出空字串。
export function splitHelpKeys(keysText) {
  const parts = String(keysText).split('/');
  const out = [];
  for (let i = 0; i < parts.length; ++i) {
    if (parts[i] !== '') {
      out.push(parts[i]);
      continue;
    }
    // 兩個相鄰的空字串＝一個 `/` 鍵（"/"、"a//"、"//b"）。
    if (i + 1 < parts.length && parts[i + 1] === '') {
      out.push('/');
      ++i;
    }
  }
  return out.length ? out : [String(keysText)];
}

// 一列項目文字 → { keysText, keys, label, help, cursor }；不是項目列回 null。
export function parseHelpItemRow(text) {
  if (typeof text !== 'string') return null;
  const cursor = text.charAt(0) === '>';
  const body = text.replace(/^(?:>|●)?\s*/, '');
  const m = ITEM_RE.exec(body);
  if (!m) return null;
  return {
    keysText: m[1],
    keys: splitHelpKeys(m[1]),
    label: m[2] || '',
    help: m[3] || '',
    cursor: cursor
  };
}

// 這一幀是不是說明選單。rowTexts ＝ buf.getRowText 逐列。回：
//   { caption, page, totalPages, angel, items, cursorIndex }
// 認不出（任一要素失配、任一非空白項目列解析不了）回 null。
export function parseHelpMenuScreen(rowTexts) {
  const rows = rowTexts || [];
  const n = rows.length;
  if (n < 4) return null;
  const row0 = rows[0] || '';
  if (row0.indexOf(HELP_TITLE) < 0) return null;
  if (!HEADER_RE.test(rows[1] || '')) return null;
  const footer = (rows[n - 1] || '').trim();
  if (footer.indexOf('操作說明') !== 0) return null;
  const cap = CAPTION_RE.exec(row0);
  const pm = PAGE_RE.exec(footer);
  const page = pm ? Number(pm[1]) : 1;
  const totalPages = pm ? Number(pm[2]) : 1;
  if (!(page >= 1 && totalPages >= page)) return null;
  const items = [];
  let cursorIndex = -1;
  let ended = false;
  for (let r = 2; r < n - 1; ++r) {
    const text = rows[r] || '';
    if (!text.trim()) {
      ended = true;
      continue;
    }
    // 空白列之後又出現內容：不是這個版型。
    if (ended) return null;
    const item = parseHelpItemRow(text);
    if (!item) return null;
    if (item.cursor) cursorIndex = items.length;
    items.push({ keysText: item.keysText, keys: item.keys, label: item.label, help: item.help });
  }
  if (!items.length) return null;
  return {
    caption: cap ? cap[1] : '',
    page: page,
    totalPages: totalPages,
    angel: ANGEL_RE.test(footer),
    items: items,
    cursorIndex: cursorIndex
  };
}

export function helpItemId(item) {
  return item.keysText + '\t' + item.label;
}

// 第 index 項（0 起算）的執行鍵。pageSize ＝ 每頁項數（只有多頁時才用 PgDn 縮短）。
export function helpSelectKeys(index, pageSize, totalPages) {
  let t = Math.max(0, index | 0);
  let s = KEY_HOME;
  if (totalPages > 1 && pageSize > 0) {
    const k = Math.floor(t / pageSize);
    s += KEY_PGDN.repeat(k);
    t -= k * pageSize;
  }
  return s + KEY_DOWN.repeat(t) + KEY_ENTER;
}

// 各頁 → 依頁序串起來、以身分去重（滾輪錯位時相鄰頁會重疊）。
export function mergeHelpPages(pages, totalPages) {
  const out = [];
  const seen = new Set();
  for (let p = 1; p <= totalPages; ++p) {
    const items = pages.get(p);
    if (!items) break; // 中間缺頁：之後的索引不可信，只列到這裡
    for (const item of items) {
      const id = helpItemId(item);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(item);
    }
  }
  return out;
}

// ---- 控制器 ----
// phase：
//   idle     沒有說明選單
//   open     彈窗開著（背景可能還在 PgDn 補頁）
//   leaving  送出執行／離開鍵了，等畫面離開說明選單（期間的說明幀一律不理）
//   native   這一次說明選單交給原生（使用者選了「原生畫面」、好讀關著、認不出起點…），
//            直到畫面離開說明選單
export function HelpMenuController(core, termBuf, opts) {
  this._core = core;
  this._termBuf = termBuf;
  const o = opts || {};
  this._send = o.send || ((bytes) => core && core.view && core.view._send(bytes));
  this._enabled = o.enabled || (() => !!readValuesWithDefault().enableEasyReading);
  this._now = o.now || (() => Date.now());
  this._setTimeout = o.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  this._clearTimeout = o.clearTimeout || ((t) => clearTimeout(t));
  // React 端（components/HelpMenu）訂閱：每次狀態變動呼叫一次，參數＝snapshot()。
  this.onChange = null;
  this._reset();
  if (termBuf && termBuf.addEventListener)
    termBuf.addEventListener('screenSettled', this._onScreenSettled.bind(this));
}

HelpMenuController.prototype = {
  _reset: function() {
    this.phase = 'idle';
    this._caption = '';
    this._totalPages = 1;
    this._pageSize = 0;
    this._pages = new Map();
    this._angel = false;
    this._fetchPage = 0;
    this._lastPage = 0;
    this._incomplete = false;
    this._leavingAt = 0;
    this._clearTimers();
  },

  _clearTimers: function() {
    if (this._fetchTimer) this._clearTimeout(this._fetchTimer);
    if (this._retryTimer) this._clearTimeout(this._retryTimer);
    this._fetchTimer = null;
    this._retryTimer = null;
  },

  get open() {
    return this.phase === 'open';
  },

  snapshot: function() {
    return {
      open: this.phase === 'open',
      caption: this._caption,
      angel: this._angel,
      items: mergeHelpPages(this._pages, this._totalPages),
      loading: this.phase === 'open' && !this._incomplete && this._pages.size < this._totalPages
    };
  },

  _emit: function() {
    if (typeof this.onChange === 'function') this.onChange(this.snapshot());
  },

  _log: function(name, info) {
    const rec = this._core && this._core.debugRecorder;
    if (rec) rec.log('helpMenu.' + name, info);
  },

  _rowTexts: function() {
    const buf = this._termBuf;
    const rows = [];
    for (let r = 0; r < buf.rows; ++r) rows.push(buf.getRowText(r, 0, buf.cols));
    return rows;
  },

  // 線路上有別人的序列（AID 跳文、長推文、列表佇列的命令…）就先不送。
  _wireBusy: function() {
    const c = this._core || {};
    if (c.commandQueue && c.commandQueue.inFlightKind) return true;
    return !!(
      (c.aidNavigation && c.aidNavigation.active) ||
      (c.longPush && c.longPush.active) ||
      (c.logout && c.logout.active)
    );
  },

  _onScreenSettled: function() {
    const snap = this._termBuf.settleSnapshot;
    // 純本地重繪（沒有 server 寫入、游標也沒動）不是新畫面。
    if (snap && snap.changedRows && snap.changedRows.size === 0 && !snap.cursorMoved) return;
    this.noteScreen(parseHelpMenuScreen(this._rowTexts()));
  },

  // 一張靜止畫面的解析結果（null ＝不是說明選單）。unit 直接呼叫。
  noteScreen: function(parsed) {
    if (!parsed) {
      if (this.phase !== 'idle') {
        const wasOpen = this.phase === 'open';
        this._log('end', { phase: this.phase });
        this._reset();
        if (wasOpen) this._emit();
      }
      return;
    }
    if (this.phase === 'native') return;
    if (this.phase === 'leaving') {
      if (this._now() - this._leavingAt > LEAVE_TIMEOUT_MS) {
        this._log('leaveStuck', {});
        this.phase = 'native';
      }
      return;
    }
    if (this.phase === 'idle') {
      // 起點必須是第 1 頁（server 恆從 curr=0 開始）；中途才看到的不接管。
      if (!this._enabled() || parsed.page !== 1) {
        this.phase = 'native';
        this._log('native', { reason: parsed.page !== 1 ? 'mid-page' : 'disabled' });
        return;
      }
      this.phase = 'open';
      this._caption = parsed.caption;
      this._totalPages = parsed.totalPages;
      this._angel = parsed.angel;
      this._pageSize = parsed.totalPages > 1 ? parsed.items.length : 0;
      this._log('open', { caption: parsed.caption, totalPages: parsed.totalPages, items: parsed.items.length });
    }
    // 頁數變了（終端機列數改變 ⇒ server 重算 rows）：已收的頁與執行鍵的頁大小都不對了
    // ⇒ 這一次交還原生（罕見，不值得重抓）。
    if (parsed.totalPages !== this._totalPages) {
      this._log('native', { reason: 'resized' });
      this._clearTimers();
      this._fetchPage = 0;
      this.phase = 'native';
      this._emit();
      return;
    }
    this._lastPage = parsed.page;
    if (!this._pages.has(parsed.page)) this._pages.set(parsed.page, parsed.items);
    if (this._fetchPage && parsed.page >= this._fetchPage) {
      this._fetchPage = 0;
      if (this._fetchTimer) this._clearTimeout(this._fetchTimer);
      this._fetchTimer = null;
    }
    this._maybeFetch(parsed.page);
    this._emit();
  },

  // 還缺頁就往下翻一頁（一次只一個在途：pttbbs typeahead 會吞掉中間幀）。
  _maybeFetch: function(currentPage) {
    if (this.phase !== 'open' || this._fetchPage || this._incomplete) return;
    if (this._pages.size >= this._totalPages) return;
    // 只能從已收的最後一頁往下接，否則索引會斷。
    if (currentPage == null || !this._pages.has(currentPage) || this._pages.has(currentPage + 1)) {
      this._incomplete = true;
      return;
    }
    if (this._wireBusy()) {
      if (!this._retryTimer) {
        this._retryTimer = this._setTimeout(() => {
          this._retryTimer = null;
          this._maybeFetch(currentPage);
        }, WIRE_RETRY_MS);
      }
      return;
    }
    this._fetchPage = currentPage + 1;
    this._fetchTimer = this._setTimeout(() => {
      this._fetchTimer = null;
      if (!this._fetchPage) return;
      this._log('fetchTimeout', { page: this._fetchPage });
      this._fetchPage = 0;
      this._incomplete = true;
      this._emit();
    }, FETCH_TIMEOUT_MS);
    this._log('fetch', { page: this._fetchPage });
    this._send(KEY_PGDN);
  },

  _leave: function(bytes, reason) {
    if (this.phase !== 'open') return false;
    this._clearTimers();
    this._fetchPage = 0;
    this.phase = 'leaving';
    this._leavingAt = this._now();
    this._log('leave', { reason: reason });
    this._send(bytes);
    this._emit();
    return true;
  },

  // 執行合併清單的第 index 項。
  select: function(index) {
    const items = mergeHelpPages(this._pages, this._totalPages);
    if (!(index >= 0 && index < items.length)) return false;
    return this._leave(helpSelectKeys(index, this._pageSize, this._totalPages), 'select');
  },

  // 離開說明選單（＝原生的 q）。
  close: function() {
    return this._leave(KEY_QUIT, 'close');
  },

  // 呼叫小天使（＝原生的 h，只在 footer 有這顆時）。
  callAngel: function() {
    if (!this._angel) return false;
    return this._leave(KEY_ANGEL, 'angel');
  },

  // 這一次改看原生畫面：彈窗收起、畫面留在 PTT 的說明選單。補頁把游標移到後面幾頁了
  // ⇒ 送 Home 回第 1 頁（使用者按 h 看到的本來就是第 1 頁）。
  showNative: function() {
    if (this.phase !== 'open') return false;
    const moved = this._fetchPage > 0 || this._lastPage > 1;
    this._clearTimers();
    this._fetchPage = 0;
    this.phase = 'native';
    this._log('native', { reason: 'user' });
    if (moved) this._send(KEY_HOME);
    this._emit();
    return true;
  },

  // 斷線：什麼都不留。
  reset: function() {
    const wasOpen = this.phase === 'open';
    this._reset();
    if (wasOpen) this._emit();
  }
};
