// 信件列表 ⏎ 讀信 → ← 回信件列表 —— 真瀏覽器＋完整 boot 鏈＋真滑鼠。
//
// 素材：upstream pttbbs 原始碼產的畫面（tests/unit/fixtures/ptt_src_screens/mail_read.json，
// tools/ptt-src-screens 的 mail_read 場景），在這裡組成 scenario 卷。
//
// 守的是 term_buf.setPageState 的信件列表分支：以前 pageState 沿用上一幀，讀完一封信回來
// 黏在 3（文章）⇒ 點信件沒反應。unit（ptt_src_screens.test.js）蓋掉判定與滑鼠區域；這裡驗
// 真的點下去送出「移游標＋⏎」，以及點空白列一個鍵都不送（不會打開最後一封信）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootScenario, waitFed, waitScreenSettled } = require('../helpers/replay');
const { nextFrames, waitClickSettled } = require('../helpers/real_input');
const fx = require('../../unit/fixtures/ptt_src_screens/mail_read.json');

const b64 = (s) => Buffer.from(s, 'latin1').toString('base64');
const frame = (name) => fx.frames.find((f) => f.name === name).bytes;
const cassette = {
  meta: { mode: 'scenario', scenario: 'mail-read', prefs: {} },
  cols: fx.cols,
  rows: fx.rows,
  steps: [
    { on: 'start', recv: b64(frame('menu') + frame('mail')) },
    { on: 'raw', send: b64('\r'), recv: b64(frame('read')) },
    { on: 'raw', send: b64('\x1b[D'), recv: b64(frame('back')) },
  ],
};

// 終端機第 (col, row) 格的畫面中心。
const cellPoint = (page, col, row) =>
  page.evaluate(
    ([c, r]) => {
      const v = window.__app.view;
      return {
        x: parseFloat(v.firstGridOffset.left) + v.chw * (c + 0.5),
        y: parseFloat(v.firstGridOffset.top) + v.chh * (r + 0.5),
      };
    },
    [col, row]
  );

async function clickCell(page, col, row) {
  const p = await cellPoint(page, col, row);
  await page.mouse.move(p.x, p.y);
  await nextFrames(page); // hover → mouseAction 更新
  await page.mouse.down();
  await page.mouse.up();
  await waitClickSettled(page);
}

const sent = (page) => page.evaluate(() => window.__replay.sent.slice());

test('讀完信 ← 回信件列表：點信件照樣打開，點空白列不送鍵', async ({ page }) => {
  await bootScenario(page, ptt, cassette, {
    prefs: { enableEasyReading: true, useMouseBrowsing: true, mouseLeftClick: true, mouseEdgePaging: false },
  });
  await ptt.sendKey(page, 'Enter');
  await waitFed(page, 2);
  await waitScreenSettled(page, { 23: '瀏覽' });
  expect(await page.evaluate(() => window.__app.buf.pageState)).toBe(3);

  await ptt.sendKey(page, 'ArrowLeft');
  await waitFed(page, 3);
  await waitScreenSettled(page, { 23: '信件列表' });
  expect(await page.evaluate(() => window.__app.buf.pageState)).toBe(1);
  expect(await sent(page)).toEqual(['\r', '\x1b[D']);

  // 游標在第 3 封（row 5）。點空白列（row 12）與欄位標題列（row 2）：read.c 的 ↓ 夾在最後一封、
  // 第一封 ↑ 繞到最後一封 ⇒ 以前會送「移游標＋⏎」打開最後一封信。
  await clickCell(page, 40, 12);
  await clickCell(page, 40, 2);
  expect(await sent(page)).toEqual(['\r', '\x1b[D']);

  // 點第 1 封（row 3）：往上兩格＋⏎。
  await clickCell(page, 40, 3);
  await expect.poll(() => sent(page)).toEqual(['\r', '\x1b[D', '\x1b[A\x1b[A\r']);
});
