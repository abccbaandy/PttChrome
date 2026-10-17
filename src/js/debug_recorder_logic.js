// Debug 錄製：純邏輯層（無 DOM / app 依賴，unit 可測）。
// 錄製檔 schema：{ meta, events, cassette }
//   events = 唯一事實來源：[{t, dir:'send'|'recv'|'log', data:<base64 latin1>, state?, tag?, info?}]
//   cassette = 由 events 導出的既有離線重放格式 {meta, cols, rows, steps:[{on, recv, num?}]}
//     （tests/e2e/helpers/replay.js 可直接消費；meta.mode='debug-derived' 不會被
//     findCassettes('article'/'list') 誤撿，要用時人工改 meta.mode）。
import { scrub } from './redact';

// recv 錄的是 telnet 解碼後的格子編碼（app.onData 的輸入）。UTF-8 線路上 Big5 收不下的字
// 是 ≥ 0x100 的 Unicode 格（unicode_cells.js），btoa 會丟例外、整份錄製檔匯不出來。
// 錄製檔與所有重放工具（replay.js、debug-screens、triage）都假設 latin1 ⇒ 換成**等寬**佔位：
// 全形（Unicode 格＋WIDE_TRAIL）→ Big5「？」\xA1\x48、半形 → '?'。格線與游標不變，只少字形。
export function latin1Cells(data) {
  if (!/[^\x00-\xff]/.test(data)) return data;
  // 解碼器一次吐出「字＋右半格」，同一個 recv event 裡一定成對。
  return data.replace(/[^\x00-\xff]￿?/g, (m) => (m.length === 2 ? '\xa1\x48' : '?'));
}

// base64 ←→ latin1 bytes string（每 char = 1 byte）。node（jest）無 btoa 時退回 Buffer。
export function b64encode(latin1) {
  latin1 = latin1Cells(latin1);
  if (typeof btoa === 'function') return btoa(latin1);
  // eslint-disable-next-line no-undef
  return Buffer.from(latin1, 'latin1').toString('base64');
}
export function b64decode(b64) {
  if (typeof atob === 'function') return atob(b64);
  // eslint-disable-next-line no-undef
  return Buffer.from(b64, 'base64').toString('latin1');
}

// send bytes → cassette step 的 on 分類（replay.js PATTERNS 的反向映射）。
// 交易尾可能附 \f（Ctrl+L 確定性收尾，v5 protocol §6）——先剝掉再比對。
export function classifySend(bytes) {
  let d = bytes;
  if (d.charAt(d.length - 1) === '\x0c') d = d.slice(0, -1);
  if (d.indexOf('\x1b[6~') >= 0) return { on: 'pagedown' };
  if (d.indexOf('\x1b[5~') >= 0) return { on: 'pageup' };
  if (d.indexOf('\x1b[4~') >= 0) return { on: 'end' };
  if (d === '\x1b[A') return { on: 'up' };
  if (d.indexOf('\x1b[D') >= 0) return { on: 'back' };
  if (d === '/') return { on: 'slash' };
  if (d === '\r') return { on: 'open' };
  const m = /^(\d+)\r$/.exec(d);
  if (m) return { on: 'jump', num: parseInt(m[1], 10) };
  return { on: 'raw', send: b64encode(bytes) };
}

// telnet 協商 / NAWS（IAC 開頭）之類的機器 bytes：不影響畫面流，導出時略過。
function isTelnetNegotiation(bytes) {
  return bytes.charCodeAt(0) === 0xff;
}

// events → cassette steps。規則：
//  - 錄製起點到第一個「有意義 send」之間的 recv 合併為 on:'start'。
//  - 之後每個 send 開一個 step（on 由 classifySend 決定），其後連續 recv 併入該 step。
//  - 無 recv 回應的 send 不產生 step（如 anti-idle、協商）。
//  - log 事件不進 cassette。
// 傳入的 events data 為「原始 latin1 字串」（尚未 base64；序列化時才編碼）。
export function eventsToCassetteSteps(events) {
  const steps = [];
  let cur = { on: 'start', recv: '' };
  for (const ev of events) {
    if (ev.dir === 'recv') {
      cur.recv += ev.data;
    } else if (ev.dir === 'send') {
      if (isTelnetNegotiation(ev.data)) continue;
      if (cur.recv) steps.push(cur);
      cur = Object.assign({ recv: '' }, classifySend(ev.data));
    }
  }
  if (cur.recv) steps.push(cur);
  // base64 編碼 recv
  return steps.map((s) => Object.assign({}, s, { recv: b64encode(s.recv) }));
}

// 序列化整卷錄製 → JSON 字串（含 redact + base64 + cassette 導出）。
//   events: [{t, dir, data(latin1) | tag/info, state?}]
//   redact: { ids: [...], secrets: [...] }
// 遮蔽要對「串流」做，不能逐 event 做：WebSocket 封包可以把帳號／密碼切成兩半
// （「我是my」＋「user]」），兩半各自都不像帳號 ⇒ 逐 event 遮蔽時原樣留下，接起來
// 就是完整的帳號（2026-10 live 錄製的把關抓到）。同方向的 event 接成一條串流 scrub，
// 再依原長度切回 —— scrub 全部是等長替換，所以切點不變。回傳 Map(event → 遮蔽後 data)。
function scrubByStream(events, clean) {
  const out = new Map();
  for (const dir of ['recv', 'send']) {
    const evs = events.filter((ev) => ev.dir === dir);
    const cleaned = clean(evs.map((ev) => ev.data).join(''));
    let off = 0;
    for (const ev of evs) {
      out.set(ev, cleaned.slice(off, off + ev.data.length));
      off += ev.data.length;
    }
  }
  return out;
}

// log info 可能帶畫面上解出來的文字（article.context 的作者、appBar 標題）⇒ 逐字串遮。
function scrubInfo(v, ids, secrets) {
  if (typeof v === 'string') return scrub(v, ids, secrets);
  if (Array.isArray(v)) return v.map((x) => scrubInfo(x, ids, secrets));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = scrubInfo(v[k], ids, secrets);
    return o;
  }
  return v;
}

export function serializeRecording({ events, meta = {}, cols = 80, rows = 24, redact = {} }) {
  const ids = (redact.ids || []).filter(Boolean);
  const secrets = (redact.secrets || []).filter(Boolean);
  const cleaned = scrubByStream(events, (s) => scrub(s, ids, secrets));

  const outEvents = events.map((ev) => {
    if (ev.dir === 'log') {
      return { t: ev.t, dir: 'log', tag: ev.tag, info: scrubInfo(ev.info, ids, secrets) };
    }
    const o = { t: ev.t, dir: ev.dir, data: b64encode(cleaned.get(ev)) };
    if (ev.state) o.state = ev.state;
    return o;
  });

  const cassetteSteps = eventsToCassetteSteps(
    events
      .filter((ev) => ev.dir !== 'log')
      .map((ev) => Object.assign({}, ev, { data: cleaned.get(ev) }))
  );

  const out = {
    meta: Object.assign(
      {
        mode: 'debug',
        recordedAt: new Date().toISOString(),
        redacted: { ids: ids.length > 0, secrets: secrets.length > 0, ips: true },
        warning:
          'send 事件含使用者鍵入的所有按鍵；手動輸入的密碼無法自動偵測，分享前請自行檢查敏感資訊。',
      },
      meta
    ),
    events: outEvents,
    cassette: {
      meta: { mode: 'debug-derived', recordedAt: new Date().toISOString() },
      cols,
      rows,
      steps: cassetteSteps,
    },
  };
  return JSON.stringify(out);
}
