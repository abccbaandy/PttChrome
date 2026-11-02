// 同一篇連開 10 次後的實況提問（upstream pttbbs f1a32e2，more.c#live_check_repeat）——真瀏覽器＋完整 boot 鏈。
//
// 素材：upstream 原始碼產的畫面（tests/unit/fixtures/ptt_src_screens/live_repeat_prompt.json，
// tools/ptt-src-screens 的 live_repeat_prompt 場景：同一篇 ⏎／q 十次，第 11 次 ⏎ 換來底列的
// 「要直接進入實況模式看新推文嗎？ [Y/n]:」輸入欄，答 n⏎ 才開文）。cassette 從第 11 次開始。
//
// 守的是：①提問畫在畫面上、使用者看得到（不被好讀蓋掉）；②我們一個鍵都不替使用者答
// （Y 是預設，任何答案＋⏎ 都會進實況）；③使用者自己答 n⏎ 之後照常開文、好讀照常接手。
// 列表好讀／重新整理開文時的「馬上停手交給使用者答」由 unit 守（list_session／aid_navigation 的 bail）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootScenario, waitFed, waitScreenSettled } = require('../helpers/replay');
const fx = require('../../unit/fixtures/ptt_src_screens/live_repeat_prompt.json');

const b64 = (s) => Buffer.from(s, 'latin1').toString('base64');
const frame = (name) => fx.frames.find((f) => f.name === name).bytes;

test('第 11 次開同一篇 ⇒ 實況提問照原生畫出來、不替使用者答；答 n 照常開文', async ({ page }) => {
  const cassette = {
    meta: { mode: 'scenario', scenario: 'live-repeat-prompt', prefs: {} },
    cols: fx.cols,
    rows: fx.rows,
    steps: [
      { on: 'start', recv: b64(frame('list')) },
      { on: 'raw', send: b64('\r'), recv: b64(frame('live-prompt')) },
      { on: 'raw', send: b64('n'), recv: b64(frame('live-prompt-n')) },
      { on: 'raw', send: b64('\r'), recv: b64(frame('article')) },
    ],
  };
  await bootScenario(page, ptt, cassette, { prefs: { enableEasyReading: true } });
  await ptt.sendKey(page, 'Enter');
  await waitFed(page, 2);
  await waitScreenSettled(page, { 23: '實況模式' });
  await expect(page.locator('#mainContainer [data-type="bbsline"]').filter({ hasText: '要直接進入實況模式看新推文嗎？' })).toHaveCount(1);
  expect(await page.evaluate(() => window.__app.buf.isPromptPending())).toBe(true);
  expect(await page.evaluate(() => window.__replay.sent.slice())).toEqual(['\r']);

  await page.keyboard.press('n');
  await waitFed(page, 3);
  await page.keyboard.press('Enter');
  await waitFed(page, 4);
  await waitScreenSettled(page, { 23: '瀏覽' });
  await expect.poll(() => page.evaluate(() => window.__app.buf.pageState)).toBe(3);
  const sent = await page.evaluate(() => window.__replay.sent.slice());
  expect(sent.slice(0, 3)).toEqual(['\r', 'n', '\r']);
  // 之後只會是好讀自己的翻頁（累積長文），不會有替使用者回答的鍵。
  expect(sent.slice(3).every((d) => d === '\x1b[6~')).toBe(true);
  await expect(page.locator('#mainContainer [data-type="bbsline"]').filter({ hasText: '實況長文' }).first()).toBeVisible();
});
