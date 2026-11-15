// P90 列表按推文改出推文列：手機（APK 同一份網頁）。桌機版的送出序列與取消在
// list_push_bar.offline.spec.js；這裡守手機才有的：收合模式（mobileCommentBarFold）下也直接展開、
// 點輸入框打字＋點「送出」（觸控，不是 Enter）送出同一串鍵；系統返回＝取消。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootScenario, waitFed, waitScreenSettled } = require('../helpers/replay');
const fx = require('../../unit/fixtures/ptt_src_screens/push_flow.json');

const b64 = (s) => Buffer.from(s, 'latin1').toString('base64');
const frame = (name) => fx.frames.find((f) => f.name === name).bytes;

async function openMenu(page, steps) {
  await bootScenario(
    page,
    ptt,
    {
      meta: { mode: 'scenario', scenario: 'list-push-bar-mobile', prefs: {} },
      cols: fx.cols,
      rows: fx.rows,
      steps: [{ on: 'start', recv: b64(frame('list')) }, { on: 'raw', send: b64('X'), recv: b64(frame('menu')) }, ...steps],
    },
    { commentBar: true, commentBarFold: true, prefs: { enableEasyReading: true, pushKeyOpensLongPush: true } },
  );
  await page.evaluate(() => window.__app.setInputAreaFocus());
  await page.keyboard.press('Shift+X');
  await waitFed(page, 2);
  await waitScreenSettled(page, { 23: '您覺得這篇文章' });
}

test('手機：收合模式下類型選單一出來就展開推文列；點送出 ⇒ 類型鍵→內容→y', async ({ page }) => {
  await openMenu(page, [
    { on: 'raw', send: b64('1'), recv: b64(frame('input')) },
    { on: 'raw', send: b64('hello\r'), recv: b64(frame('confirm')) },
    { on: 'raw', send: b64('y\r'), recv: b64(frame('done')) },
  ]);
  const bar = page.locator('#commentBar[data-comment-mode="list"]');
  await expect(bar).toBeVisible();
  await page.locator('#commentBar [name="commentBarText"]').tap();
  await page.keyboard.insertText('hello');
  await page.locator('#commentBar [data-comment-send]').tap();
  await waitFed(page, 5);
  await expect.poll(() => page.evaluate(() => window.__app.longPush.active)).toBe(false);
  expect(await page.evaluate(() => window.__replay.sent.slice())).toEqual(['X', '1', 'hello\r', 'y\r']);
  await expect(page.locator('#commentBar')).toHaveCount(0);
});

test('手機：系統返回（popstate）⇒ 替你取消（Ctrl-C ×2），列收起、不送 ←', async ({ page }) => {
  await openMenu(page, [
    { on: 'raw', send: b64('\x03'), recv: b64(frame('input')) },
    { on: 'raw', send: b64('\x03'), recv: b64(frame('list')) },
  ]);
  await expect(page.locator('#commentBar[data-comment-mode="list"]')).toBeVisible();
  // 點一下輸入框＝user activation ⇒ 返回守門的 sentinel 疊上（同 mobile_comment_bar_fold）。
  await page.locator('#commentBar [name="commentBarText"]').tap();
  await page.waitForFunction(() => !!(window.history.state && window.history.state.pttchromeBackGuard));
  await page.goBack();
  await waitFed(page, 4);
  await expect.poll(() => page.evaluate(() => window.__app.longPush.active)).toBe(false);
  expect(await page.evaluate(() => window.__replay.sent.slice())).toEqual(['X', '\x03', '\x03']);
  await expect(page.locator('#commentBar')).toHaveCount(0);
});
