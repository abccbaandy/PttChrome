// 守護「送給 PTT 的唯一出口」（src/js/wire_send.js，架構 review A2 步驟 a，docs/wire-send.md）。
//   1. 靜態：傳輸層（telnet.js／websocket.js／ssh/）與 wire_send.js 以外，沒有任何地方直接叫連線物件的
//      送出方法。新增送鍵入口時漏了這層會在這裡紅，而不是等判斷邏輯 review 抓到。
//   2. 每支函式就是原本那一行 conn 呼叫（行為不變），身分不認得就丟。
//   3. 每個身分都真的有人用（新增入口時順手登記，不留空殼）。
import fs from 'node:fs';
import path from 'node:path';
import {
  WIRE_SOURCE,
  sendBytes,
  sendText,
  sendUserKey,
  sendUserText,
  sendWindowSize,
  sendKeepAliveProbe,
} from '../../src/js/wire_send.js';

const SRC = path.join(process.cwd(), 'src');
const FILES = fs
  .readdirSync(SRC, { recursive: true })
  .filter((f) => /\.jsx?$/.test(f))
  .map((f) => f.split(path.sep).join('/'))
  .map((f) => ({
    name: f,
    // 去掉行註解：方法名在說明文字裡大量出現。
    code: fs.readFileSync(path.join(SRC, f), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
  }));

// 傳輸層自己（定義這些方法、或轉手給 socket）與出口本身。
const TRANSPORT = new Set(['js/wire_send.js', 'js/telnet.js', 'js/websocket.js']);
const isTransport = (name) => TRANSPORT.has(name) || name === 'js/ssh/ssh_transport.js';

const SEND_METHODS = 'send|convSend|sendUserKey|convSendUserKey|sendNaws|sendWillNaws|sendTimingMark';
// 收件者叫 conn／_conn（this.conn、pttchrome.conn、core.conn、captured conn 都算），含 `?.`。
// regex 的盲點（別名 `const c = this.conn`、`conn['send']`、解構、`.call`）目前 src 都沒有；
// 寫成那樣等於繞過出口，review 時當違規看。
const DIRECT_CALL = new RegExp(`\\b_?conn\\s*\\??\\.\\s*(?:${SEND_METHODS})\\s*\\(`);

describe('送出只有 wire_send 一個出口', () => {
  test('傳輸層以外沒有人直接叫 conn 的送出方法', () => {
    const offenders = FILES.filter((f) => !isTransport(f.name) && DIRECT_CALL.test(f.code)).map((f) => {
      const line = f.code.split('\n').find((l) => DIRECT_CALL.test(l));
      return `${f.name}: ${line.trim()}`;
    });
    expect(offenders).toEqual([]);
  });

  test('_sendRaw 只有傳輸層與 debug 錄製（包一層記錄）碰', () => {
    const offenders = FILES.filter(
      (f) => !isTransport(f.name) && f.name !== 'js/debug_recorder.js' && /_sendRaw\b/.test(f.code),
    ).map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  test('守護本身認得出違規（不是永遠綠）', () => {
    for (const bad of [
      'this.conn.send("x")',
      'pttchrome.conn.convSend(v)',
      'conn.sendNaws(1, 2)',
      'this.conn.sendUserKey(d)',
      'core.conn . sendTimingMark()',
      'this.conn?.send(x)',
      'pttchrome.conn?.convSend(v)',
    ])
      expect(DIRECT_CALL.test(bad), bad).toBe(true);
    for (const ok of ['wire.sendBytes(WIRE_SOURCE.QUEUE, this.conn, d)', 'this.conn.isConnected', 'conn.abort()'])
      expect(DIRECT_CALL.test(ok), ok).toBe(false);
  });

  test('呼叫點寫的每個 WIRE_SOURCE.X 都存在（拼錯不會等到送鍵才爆）', () => {
    const used = new Set();
    for (const f of FILES) for (const m of f.code.matchAll(/WIRE_SOURCE\.(\w+)/g)) used.add(m[1]);
    expect([...used].filter((k) => !(k in WIRE_SOURCE))).toEqual([]);
  });

  test('每個身分都有呼叫點在用', () => {
    const all = FILES.filter((f) => f.name !== 'js/wire_send.js')
      .map((f) => f.code)
      .join('\n');
    const unused = Object.keys(WIRE_SOURCE).filter((k) => !new RegExp(`WIRE_SOURCE\\.${k}\\b`).test(all));
    expect(unused).toEqual([]);
  });
});

function fakeConn() {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  return {
    calls,
    send: rec('send'),
    convSend: rec('convSend'),
    sendUserKey: rec('sendUserKey'),
    convSendUserKey: rec('convSendUserKey'),
    sendNaws: rec('sendNaws'),
    sendWillNaws: rec('sendWillNaws'),
    sendTimingMark: rec('sendTimingMark'),
  };
}

describe('每支出口就是原本那一行 conn 呼叫', () => {
  test('機器 byte／文字走 send／convSend（會化解懸空 ESC 的那一邊）', () => {
    const c = fakeConn();
    sendBytes(WIRE_SOURCE.QUEUE, c, '\x1b[B');
    sendText(WIRE_SOURCE.APP_TEXT, c, '推');
    expect(c.calls).toEqual([
      ['send', '\x1b[B'],
      ['convSend', '推'],
    ]);
  });

  test('真鍵盤／IME 走 userKey 變體', () => {
    const c = fakeConn();
    sendUserKey(c, '\x1bL');
    sendUserText(c, '中');
    expect(c.calls).toEqual([
      ['sendUserKey', '\x1bL'],
      ['convSendUserKey', '中'],
    ]);
  });

  test('NAWS：回應 DO NAWS 時先 WILL 再報大小；改大小只報大小', () => {
    const c = fakeConn();
    sendWindowSize(c, 80, 24, { will: true });
    sendWindowSize(c, 100, 30);
    expect(c.calls).toEqual([['sendWillNaws'], ['sendNaws', 80, 24], ['sendNaws', 100, 30]]);
  });

  test('連線保持探針走 TIMING-MARK', () => {
    const c = fakeConn();
    sendKeepAliveProbe(c);
    expect(c.calls).toEqual([['sendTimingMark']]);
  });

  test('身分不認得就丟、什麼都不送', () => {
    const c = fakeConn();
    expect(() => sendBytes('mystery', c, 'x')).toThrow(/unknown source/);
    expect(() => sendText(undefined, c, 'x')).toThrow(/unknown source/);
    expect(c.calls).toEqual([]);
    expect(Object.isFrozen(WIRE_SOURCE)).toBe(true);
  });

  test('沒有連線時跟原本一樣直接丟（呼叫端自己先檢查，出口不默默吞掉）', () => {
    expect(() => sendBytes(WIRE_SOURCE.MACHINE, undefined, 'x')).toThrow(TypeError);
  });
});
