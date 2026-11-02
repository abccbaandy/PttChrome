// PTT 站方的登入封鎖畫面（src/js/login_block.js）——真瀏覽器＋完整 boot 鏈＋真的斷線路徑。
//
// 畫面寫明「無任何登入行為之後最多 12 小時後會恢復」「暫停期間若持續嘗試登入…將無限期延長」
// 「部份 App 需要關閉自動登入」⇒ 斷線提示要講清楚，本頁的自動登入要停手（重新連線也不再代打）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootScenario, waitScreenSettled } = require('../helpers/replay');
const fx = require('../fixtures/login_block_screen.json');

const b64 = (s) => Buffer.from(s, 'latin1').toString('base64');

test('登入途中被 PTT 封鎖 ⇒ 斷線提示寫明規則、本頁自動登入停手', async ({ page }) => {
  const cassette = {
    meta: { mode: 'scenario', scenario: 'login-block', prefs: {} },
    cols: 80,
    rows: 24,
    steps: [{ on: 'start', recv: b64(fx.bytes) }],
  };
  await bootScenario(page, ptt, cassette);
  await waitScreenSettled(page, { 1: '已被暫時禁止登入' });
  await page.evaluate(() => window.__stubWS.close());

  const text = await page.evaluate(() => window.__i18n('alert_connectionLoginBlocked'));
  const alert = page.locator('.PageTopAlert');
  await expect(alert).toContainText(text);
  expect(await page.evaluate(() => window.__app.autoLogin.isSuspended())).toBe(true);
  // 不跑連線診斷（連得上，是 PTT 不讓登入）。
  await expect(alert).not.toContainText(await page.evaluate(() => window.__i18n('alert_connectionChecking')));
});

test('登入後（到過主功能表）斷線，畫面上剛好有那段字 ⇒ 不當成封鎖', async ({ page }) => {
  const cassette = {
    meta: { mode: 'scenario', scenario: 'login-block-after-menu', prefs: {} },
    cols: 80,
    rows: 24,
    steps: [{ on: 'start', recv: b64(fx.menu) }],
  };
  await bootScenario(page, ptt, cassette);
  await waitScreenSettled(page, { 0: '主功能表' });
  await page.evaluate((bytes) => window.__app.onData(bytes), fx.bytes);
  await waitScreenSettled(page, { 1: '已被暫時禁止登入' });
  await page.evaluate(() => window.__stubWS.close());
  await expect(page.locator('.PageTopAlert')).toContainText(
    await page.evaluate(() => window.__i18n('alert_connectionText'))
  );
  await expect(page.locator('.PageTopAlert')).not.toContainText(
    await page.evaluate(() => window.__i18n('alert_connectionLoginBlocked'))
  );
  expect(await page.evaluate(() => window.__app.autoLogin.isSuspended())).toBe(false);
});
