// 手機讀信「更多」的上一封／下一封（P104，mobile_toolbar.mailNav）：真觸控 tap ⇒ 只送 PTT 讀信時的
// b／f 一個鍵（mbbsd/more.c#more_list_nav_cmds，mail.c#mail_read 掛這層）。只在 offline-mobile 跑。
//
// 素材：upstream pttbbs 原始碼產的讀信畫面（tests/unit/fixtures/ptt_src_screens/mail_read.json），
// 組法同 mail_read.offline.spec.js。unit（mobile_toolbar.test.js／.jsx、ptt_src_screens.test.js）守判定與
// 元件；這裡守完整 boot 鏈下「讀信畫面真的出現、點下去真的送出」。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootScenario, waitFed, waitScreenSettled } = require('../helpers/replay');
const { waitDialogSettled } = require('../helpers/layout');
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
  ],
};

const byKey = (page, k) => page.locator(`[data-key="${k}"]`);
const sent = (page) => page.evaluate(() => window.__replay.sent.slice());

async function openMail(page, prefs = {}) {
  await bootScenario(page, ptt, cassette, { prefs: { enableEasyReading: true, ...prefs } });
  await ptt.sendKey(page, 'Enter');
  await waitFed(page, 2);
  await waitScreenSettled(page);
  await expect.poll(() => page.evaluate(() => window.__app.buf.pageState)).toBe(3);
}

test('讀信：更多最上面是上一封／下一封，tap 下一封只送 f、上一封只送 b', async ({ page }) => {
  await openMail(page);
  await byKey(page, '__more').tap();
  const nav = byKey(page, '__mailNav');
  await expect(nav).toBeVisible();
  await expect(byKey(page, '__threadNav')).toHaveCount(0);
  await waitDialogSettled(page, '[data-key="__mailNav"]');
  await byKey(page, 'f').tap();
  await expect.poll(() => sent(page)).toEqual(['\r', 'f']);
  await expect(nav).toHaveCount(0); // sheet 收起
  await byKey(page, '__more').tap();
  await waitDialogSettled(page, '[data-key="__mailNav"]');
  await byKey(page, 'b').tap();
  await expect.poll(() => sent(page)).toEqual(['\r', 'f', 'b']);
});

test('設定關掉 ⇒ 讀信的更多裡沒有上一封／下一封', async ({ page }) => {
  await openMail(page, { mobileMailNav: false });
  await byKey(page, '__more').tap();
  await expect(byKey(page, '__settings')).toBeVisible();
  await expect(byKey(page, '__mailNav')).toHaveCount(0);
  expect(await sent(page)).toEqual(['\r']);
});
