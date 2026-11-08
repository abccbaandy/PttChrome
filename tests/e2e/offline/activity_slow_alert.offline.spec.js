// PTT 的限速通知（upstream pttbbs f369626a，contentcheck.c#activity_slow_alert）——真瀏覽器＋完整 boot 鏈。
//
// 素材：upstream 原始碼產的畫面（tests/unit/fixtures/ptt_src_screens/activity_slow.json，
// tools/ptt-src-screens 的 activity_slow 場景：activity.svc 說帳號限速中時，開文前先畫
// 「使用限制 限速中」＋理由＋pressanykey，按任意鍵後照常開文）。
//
// 守的是：①通知照原生畫出來、使用者看得到（不被好讀蓋掉）；②我們一個鍵都不替使用者按
// （它是站方要使用者本人看的通知）；③使用者自己按一鍵之後照常開文、好讀照常接手。
// 跳過進板畫面／AID 跳文進板／重新整理／列表好讀開文的「看到就停手」由 unit 守（ptt_src_screens.test.js）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootScenario, waitFed, waitScreenSettled } = require('../helpers/replay');
const fx = require('../../unit/fixtures/ptt_src_screens/activity_slow.json');

const b64 = (s) => Buffer.from(s, 'latin1').toString('base64');
const frame = (name) => fx.frames.find((f) => f.name === name).bytes;

test('開文前的限速通知照原生畫出來、不替使用者按掉；按一鍵照常開文', async ({ page }) => {
  const cassette = {
    meta: { mode: 'scenario', scenario: 'activity-slow', prefs: {} },
    cols: fx.cols,
    rows: fx.rows,
    steps: [
      { on: 'start', recv: b64(frame('board-slow') + frame('list')) },
      { on: 'raw', send: b64('\r'), recv: b64(frame('read-slow')) },
      { on: 'raw', send: b64(' '), recv: b64(frame('article')) },
    ],
  };
  await bootScenario(page, ptt, cassette, { prefs: { enableEasyReading: true } });
  await ptt.sendKey(page, 'Enter');
  await waitFed(page, 2);
  await waitScreenSettled(page, { 0: '限速中' });
  const lines = page.locator('#mainContainer [data-type="bbsline"]');
  await expect(lines.filter({ hasText: 'placeholder slow reason from activity.svc' })).toHaveCount(1);
  await expect(lines.filter({ hasText: '請按任意鍵繼續' })).toHaveCount(1);
  expect(await page.evaluate(() => window.__replay.sent.slice())).toEqual(['\r']);

  await page.keyboard.press('Space');
  await waitFed(page, 3);
  await waitScreenSettled(page, { 23: '瀏覽' });
  await expect.poll(() => page.evaluate(() => window.__app.buf.pageState)).toBe(3);
  const sent = await page.evaluate(() => window.__replay.sent.slice());
  expect(sent.slice(0, 2)).toEqual(['\r', ' ']);
  // 之後只會是好讀自己的翻頁，不會有替使用者按的鍵。
  expect(sent.slice(2).every((d) => d === '\x1b[6~')).toBe(true);
  await expect(lines.filter({ hasText: '第二篇文摘' }).first()).toBeVisible();
});
