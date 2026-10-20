// 水球／系統訊息收件匣（pref enableMessageInbox，預設開）：這次連線收到的水球與廣播
// 留在一份清單裡，鈴鐺（components/MessageInbox）打開來看。設計見 docs/message-inbox.md。
//
// - 收只看收到的資料、一個 byte 都不送；認不出的格式 ⇒ 不收（畫面照原生顯示）。唯一會
//   送的是使用者點「回覆」時的一下 Ctrl+R（見 reply）。
// - 只放記憶體、跟著連線走：斷線清空（App.onClose），不寫 localStorage、不上雲。
// - 解析：string_util.parseWaterball 的同一組格式（wmsg.c 的水球列、doupdate 的廣播列），
//   但收件匣**每個 chunk 都解析**（失焦通知那條只在 !appFocused 時跑）。WebSocket 會在
//   任意位元組切塊 ⇒ 一則水球可能跨兩包：沒收尾的開頭留到下一包再接（carry）。
// - 重畫去重：^L 重繪會把還在畫面上的水球列再送一次 ⇒ 跟最後一則一模一樣（同人同字）
//   且在 REPAINT_WINDOW_MS 內就當成重畫。
// - 新信提示：標題列中段的「你有新信件」由無變有時收一則（noteScreen，見 newMailOnScreen）。
import { b2u, WATERBALL_SCAN_RE, BROADCAST_SCAN_RE } from './string_util';
import { readEffectivePrefs } from './pref_storage';
import { parseBoardName, parseHeaderTitle } from './screen_titles';
import { NEW_MAIL_MARK } from './mobile_app_bar';
import { i18n } from './i18n';

export const MESSAGE_INBOX_ID = 'messageInbox';
export const INBOX_LIMIT = 100;
export const REPAINT_WINDOW_MS = 10 * 60 * 1000;
// 沒收尾的開頭最多留這麼長（一則水球列 < 80 格＋色碼）；超過就不是水球，丟掉。
export const CARRY_LIMIT = 400;

// 開頭標記只取 ASCII 的 ESC 序列（★ 在 Big5 線路上是兩個 byte，b2u 前後長得不一樣）：
// b2u 不會吃掉或生出 ESC ⇒ 同一個標記在 raw 與 text 都找得到。
const WATERBALL_STARTS = ['\x1b[1;33;46m', '\x1b[1;37;46m'];
const BROADCAST_START = '\x1b[24;';
const SGR_RESET = '\x1b[m';

function lastStart(text, from) {
  let best = -1;
  for (const m of WATERBALL_STARTS) best = Math.max(best, text.lastIndexOf(m));
  const b = text.lastIndexOf(BROADCAST_START);
  if (b > best) best = b;
  return best >= from ? best : -1;
}

// 掃一段資料（格子編碼，App.onData 收到的原樣）。`carry` 是上一包沒收尾的開頭。
// 回傳 { messages: [{ kind: 'waterball'|'broadcast', from, text }], carry }。
export function scanMessages(carry, data) {
  const raw = (carry || '') + (data || '');
  const text = b2u(raw);
  const found = [];
  const re = new RegExp(
    WATERBALL_SCAN_RE.source + '|' + BROADCAST_SCAN_RE.source,
    'g'
  );
  let m;
  let end = 0;
  while ((m = re.exec(text))) {
    if (m[1] != null) found.push({ index: m.index, kind: 'waterball', from: m[1], text: m[2] });
    else found.push({ index: m.index, kind: 'broadcast', from: '', text: m[3] });
    end = m.index + m[0].length;
  }
  found.sort((a, b) => a.index - b.index);
  const messages = found.map((f) => ({ kind: f.kind, from: f.from, text: f.text.trim() }))
    .filter((f) => f.text);
  // 最後一則之後有開頭、但還沒收尾（沒有 ESC[m）⇒ 留給下一包。開頭標記是 ASCII，
  // b2u 不會吃掉或生出 ESC ⇒ 「最後一個標記」在 raw 與 text 是同一個。
  let nextCarry = '';
  const at = lastStart(text, end);
  if (at >= 0 && text.indexOf(SGR_RESET, at) < 0) {
    const rawAt = lastStart(raw, 0);
    if (rawAt >= 0 && raw.length - rawAt <= CARRY_LIMIT) nextCarry = raw.slice(rawAt);
  }
  return { messages, carry: nextCarry };
}

// 重畫判定：跟最後一則同類、同人、同字，且在時間窗內。
export function isRepaint(last, msg, now) {
  return (
    !!last &&
    last.kind === msg.kind &&
    last.from === msg.from &&
    last.text === msg.text &&
    now - last.at < REPAINT_WINDOW_MS
  );
}

// 清單裡最新一則水球的寄件人（清單新的在前；廣播不算）。
export function latestSender(items) {
  for (const it of items || []) if (it.kind === 'waterball') return it.from;
  return null;
}

// 這個畫面看不看得出「有沒有新信」：mbbsd/menu.c#redraw_title 在 ISNEWMAIL 時把標題列中段
// 換成「你有新信件」（主選單、看板列表、文章列表共用這條標題列）。true／false 只在 row 0
// 認得出是標題列（【X】或看板標題）時給；文章、prompt、編輯器這類沒有標題列的畫面回 null
// ＝不知道（看不到不代表沒有新信）。
export function newMailOnScreen(row0, pageState) {
  if (pageState === 3) return null;
  const r = row0 || '';
  if (!parseHeaderTitle(r) && !parseBoardName(r)) return null;
  return r.indexOf(NEW_MAIL_MARK) >= 0;
}

function enabled() {
  return readEffectivePrefs().enableMessageInbox !== false;
}

export function MessageInbox(core, opts) {
  this._core = core;
  this._now = (opts && opts.now) || (() => Date.now());
  this._listeners = new Set();
  this._carry = '';
  this._seq = 0;
  this._mail = false;
  this._state = { items: [], unread: 0, open: false };
  const buf = core && core.buf;
  if (buf && buf.addEventListener) {
    const self = this;
    buf.addEventListener('screenSettled', function() {
      self.noteScreen(buf.getRowText(0), buf.pageState);
    });
  }
}

MessageInbox.prototype = {
  get state() {
    return this._state;
  },

  onChange: function(fn) {
    this._listeners.add(fn);
    fn(this._state);
    const set = this._listeners;
    return function() {
      set.delete(fn);
    };
  },

  _set: function(patch) {
    const next = Object.assign({}, this._state, patch);
    const keys = Object.keys(patch);
    if (keys.every((k) => next[k] === this._state[k])) return;
    this._state = next;
    this._listeners.forEach(function(fn) {
      fn(next);
    });
  },

  // App.onData：每個 chunk 都進來。回傳這包新收進的訊息（給測試／呼叫端看）。
  noteData: function(data) {
    if (!enabled()) {
      // 使用中途關掉：已收的一起收掉（鈴鐺跟著消失）。
      this._carry = '';
      if (this._state.items.length) this.clear();
      return [];
    }
    const r = scanMessages(this._carry, data);
    this._carry = r.carry;
    if (!r.messages.length) return [];
    const now = this._now();
    let items = this._state.items;
    const added = [];
    for (const msg of r.messages) {
      // 跟同類最新一則比（中間夾一則廣播不影響水球的重畫判定，反之亦然）。
      if (isRepaint(items.find((i) => i.kind === msg.kind), msg, now)) continue;
      const item = { id: ++this._seq, kind: msg.kind, from: msg.from, text: msg.text, at: now };
      items = [item].concat(items).slice(0, INBOX_LIMIT);
      added.push(item);
    }
    if (!added.length) return [];
    this._add(items, added.length);
    return added;
  },

  _add: function(items, count) {
    this._set({
      items,
      unread: this._state.open ? 0 : this._state.unread + count
    });
  },

  // screenSettled：標題列的新信提示由無變有 ⇒ 收一則（看得出沒有新信時才重新武裝，
  // 讀完信再來一封會再收一則）。認不出標題列的畫面不動狀態。回傳新收的那則或 null。
  noteScreen: function(row0, pageState) {
    if (!enabled()) return null;
    const mail = newMailOnScreen(row0, pageState);
    if (mail === null) return null;
    const was = this._mail;
    this._mail = mail;
    if (!mail || was) return null;
    const item = { id: ++this._seq, kind: 'mail', from: '', text: i18n('inbox_newMail'), at: this._now() };
    this._add([item].concat(this._state.items).slice(0, INBOX_LIMIT), 1);
    return item;
  },

  setOpen: function(open) {
    open = !!open;
    this._set(open ? { open: true, unread: 0 } : { open: false });
  },

  toggle: function() {
    this.setOpen(!this._state.open);
  },

  clear: function() {
    this._set({ items: [], unread: 0, open: false });
  },

  // 點一則水球直接回覆：送的就是使用者自己會按的 Ctrl+R（view.sendKeyAsUser，跟真鍵盤
  // 同一條、同一組序列化閘門），之後的回覆畫面全是 PTT 原生的。只有「最新一位寄件人」
  // 的水球能這樣回：pttbbs wmsg.c 兩種水球模式的第一下 ^R 都指向他（一般模式回最後一則
  // 的寄件人；一對一模式 ofo_my_write 預設選 swater[0]，swater_get_slot 每收一則就把寄件人
  // 提到 [0]）。要回別人得在原生畫面裡換人，鍵位依模式不同，認不出就不代按。
  // 回傳有沒有送出。
  canReply: function(item) {
    return !!item && item.kind === 'waterball' && item.from === latestSender(this._state.items);
  },

  reply: function(item) {
    if (!this.canReply(item)) return false;
    const view = this._core.view;
    if (!view || typeof view.sendKeyAsUser !== 'function') return false;
    this.setOpen(false);
    view.sendKeyAsUser('r', { ctrlKey: true });
    return true;
  },

  // App.onClose：收件匣跟著連線走。
  reset: function() {
    this._carry = '';
    this._mail = false;
    this.clear();
  }
};

export function isMessageInboxTarget(el) {
  return !!(el && typeof el.closest === 'function' && el.closest('#' + MESSAGE_INBOX_ID));
}

export default MessageInbox;
