// UTF-8 線路（pref connectionEncoding: 'utf8'）—— 離線守門（真瀏覽器 / 真開機鏈 / 零網路）。
//
// 為什麼一定要上 e2e：unit（tests/unit/unicode_cells*.test.js、wire_charset.test.js）各自掛
// 解碼器、TermBuf、單列渲染，驗不到「開站讀 pref → telnet 設線路 → WebSocket 收包解碼 →
// 整頁渲染 → 鍵盤打字送出」這整條在真 boot 下接起來沒有（例：pref 沒讀到、u2b 的格式
// 開關沒跟著線路切）。位元組一律從 stub WebSocket 的 message 進來，走真的 websocket.js →
// telnet.js 解碼，不直呼 app.onData。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, waitScreenSettled } = require('../helpers/replay');
const { imeCommit } = require('../helpers/real_input');
const { screenSanity, expectScreenSane } = require('../helpers/screen_sanity');

// 開站即 connect，線路編碼在 _attachConn 讀一次 ⇒ pref 必須在 goto 之前就位。
async function bootUtf8(page) {
  await page.addInitScript((KEY) => {
    const cur = JSON.parse(window.localStorage.getItem(KEY) || '{}');
    const values = Object.assign({}, cur.values, {
      connectionEncoding: 'utf8',
      enableEasyReading: false,
      enableEasyReadingList: false,
    });
    window.localStorage.setItem(KEY, JSON.stringify({ values }));
  }, ptt.PREF_KEY);
  await bootOffline(page, ptt);
  await page.evaluate(() => {
    window.__sent = [];
    window.__stubWSSent = (s) => window.__sent.push(s);
  });
}

// 線路位元組（latin1 字串，一字元一 byte）從 stub WebSocket 收進來。
async function recvBytes(page, latin1) {
  await page.evaluate((s) => {
    const bytes = Uint8Array.from(s, (c) => c.charCodeAt(0));
    window.__stubWS._emit('message', { data: bytes.buffer });
  }, latin1);
}

const utf8 = (text) => String.fromCharCode(...new TextEncoder().encode(text));
const sentText = (page) => page.evaluate(() => window.__sent.join(''));

test.describe('UTF-8 線路（離線）', () => {
  test('logind 的編碼探針：回報 col 2，server 才會切 UTF-8', async ({ page }) => {
    await bootUtf8(page);
    // 逐位元組照抄 daemon/logind/logind.c#login_ctx_activate
    await recvBytes(page, '\r\xc4\xa1\x1b[6n');
    await expect.poll(() => sentText(page)).toContain('\x1b[1;2R');
  });

  test('Big5 收不下的字照原字畫出、格線不歪；打字送出原字的 UTF-8', async ({ page }) => {
    await bootUtf8(page);
    const row0 = '한국어 简体字 ġ 中文 ok';
    await recvBytes(page, utf8('\x1b[2J\x1b[1;1H' + row0 + '\x1b[2;1H★✓ end\x1b[24;1H'));
    await waitScreenSettled(page, { 0: 'ok', 1: 'end' });

    const rowText = await page.evaluate(() => window.__app.buf.getRowText(0, 0, 80).trimEnd());
    expect(rowText).toBe(row0);
    // 「ok」落在 server 算的欄位：한국어(6)＋空白＋简体字(6)＋空白＋ġ(1)＋空白＋中文(4)＋空白
    const okCol = await page.evaluate(() =>
      window.__app.buf.lines[0].findIndex((c, i, l) => c.ch === 'o' && l[i + 1].ch === 'k')
    );
    expect(okCol).toBe(6 + 1 + 6 + 1 + 1 + 1 + 4 + 1);
    // DOM＝buf、格線、無水平溢出（screen_sanity 與 live 核心同一套）
    expectScreenSane(await screenSanity(page), 'utf8');

    await page.locator('#t').focus();
    await imeCommit(page, '한글');
    await expect.poll(() => sentText(page)).toContain(utf8('한글'));
    expect(await sentText(page)).not.toContain('?');
  });
});
