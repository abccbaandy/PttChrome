// Debug 錄製：純邏輯層（無 DOM / app 依賴，unit 可測）。
// 錄製檔 schema：{ meta, events, cassette }
//   events = 唯一事實來源：[{t, dir:'send'|'recv'|'log', data:<base64 latin1>, state?, tag?, info?}]
//   cassette = 由 events 導出的既有離線重放格式 {meta, cols, rows, steps:[{on, recv, num?}]}
//     （tests/e2e/helpers/replay.js 可直接消費；meta.mode='debug-derived' 不會被
//     findCassettes('article'/'list') 誤撿，要用時人工改 meta.mode）。
import { scrub } from './redact';

// base64 ←→ latin1 bytes string（每 char = 1 byte）。node（jest）無 btoa 時退回 Buffer。
export function b64encode(latin1) {
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
export function serializeRecording({ events, meta = {}, cols = 80, rows = 24, redact = {} }) {
  const ids = (redact.ids || []).filter(Boolean);
  const secrets = (redact.secrets || []).filter(Boolean);
  const clean = (s) => scrub(s, ids, secrets);

  const outEvents = events.map((ev) => {
    if (ev.dir === 'log') {
      return { t: ev.t, dir: 'log', tag: ev.tag, info: ev.info };
    }
    const o = { t: ev.t, dir: ev.dir, data: b64encode(clean(ev.data)) };
    if (ev.state) o.state = ev.state;
    return o;
  });

  const cassetteSteps = eventsToCassetteSteps(
    events
      .filter((ev) => ev.dir !== 'log')
      .map((ev) => Object.assign({}, ev, { data: clean(ev.data) }))
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
