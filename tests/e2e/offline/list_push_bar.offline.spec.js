// P90 列表按推文改出推文列（src/js/list_push.js、comment_bar.js 的 list 模式、
// long_push_session.startFromList）——真瀏覽器＋完整 boot 鏈。
//
// 素材：upstream 原始碼產的推文流程（tests/unit/fixtures/ptt_src_screens/push_flow.json：
// 列表 → X 類型選單 → 1 內容列 → hello⏎ 確認列 → y⏎ 回列表）。
//
// 守的是：①使用者自己在列表按 X、類型選單一出來，底部就是推文列而且焦點在輸入框（打字不漏給 PTT）；
// ②按送出才替使用者按「類型鍵 → 內容 → y」，線上就是這三筆、之後不按 Enter 開文；
// ③✕ ＝替使用者取消：PTT 原生的取消（Ctrl-C 進內容列、再 Ctrl-C 放棄），一個字都不寫。
// 分段、第二則重按 X 前的同篇確認（作者＋主題＋日期）在 unit（list_push_flow.test.js）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootScenario, waitFed, waitScreenSettled } = require('../helpers/replay');
const fx = require('../../unit/fixtures/ptt_src_screens/push_flow.json');

const b64 = (s) => Buffer.from(s, 'latin1').toString('base64');
const frame = (name) => fx.frames.find((f) => f.name === name).bytes;
const bar = (page) => page.locator('#commentBar[data-comment-mode="list"]');
const input = (page) => page.locator('#commentBar [name="commentBarText"]');

function cassette(steps) {
  return {
    meta: { mode: 'scenario', scenario: 'list-push-bar', prefs: {} },
    cols: fx.cols,
    rows: fx.rows,
    steps: [{ on: 'start', recv: b64(frame('list')) }, { on: 'raw', send: b64('X'), recv: b64(frame('menu')) }, ...steps],
  };
}

async function openMenu(page, steps) {
  await bootScenario(page, ptt, cassette(steps), {
    commentBar: true,
    prefs: { enableEasyReading: true, pushKeyOpensLongPush: true },
  });
  await page.evaluate(() => window.__app.setInputAreaFocus());
  await page.keyboard.press('Shift+X');
  await waitFed(page, 2);
  await waitScreenSettled(page, { 23: '您覺得這篇文章' });
}

test('列表按 X ⇒ 底部出推文列、焦點在輸入框；送出才替你按 類型鍵→內容→y，停在列表', async ({ page }) => {
  await openMenu(page, [
    { on: 'raw', send: b64('1'), recv: b64(frame('input')) },
    { on: 'raw', send: b64('hello\r'), recv: b64(frame('confirm')) },
    { on: 'raw', send: b64('y\r'), recv: b64(frame('done')) },
  ]);
  await expect(bar(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  // 一般板：推／噓／→ 都在。
  await expect(page.locator('#commentBar [data-comment-type]')).toHaveCount(3);

  await page.keyboard.type('hello');
  expect(await page.evaluate(() => window.__replay.sent.slice())).toEqual(['X']);

  await page.keyboard.press('Enter');
  await waitFed(page, 5);
  await expect.poll(() => page.evaluate(() => window.__app.longPush.active)).toBe(false);
  const sent = await page.evaluate(() => window.__replay.sent.slice());
  expect(sent).toEqual(['X', '1', 'hello\r', 'y\r']);
  await expect(page.locator('#commentBar')).toHaveCount(0);
  // 錯誤框沒出來（整段送完）。
  await expect(page.locator('.mantine-Modal-content')).toHaveCount(0);
});

test('✕ ⇒ 替你取消（PTT 原生：Ctrl-C 進內容列、再 Ctrl-C 放棄），不寫任何字', async ({ page }) => {
  await openMenu(page, [
    { on: 'raw', send: b64('\x03'), recv: b64(frame('input')) },
    { on: 'raw', send: b64('\x03'), recv: b64(frame('list')) },
  ]);
  await expect(bar(page)).toBeVisible();
  await page.locator('#commentBar [data-comment-cancel]').click();
  await waitFed(page, 4);
  await expect.poll(() => page.evaluate(() => window.__app.longPush.active)).toBe(false);
  expect(await page.evaluate(() => window.__replay.sent.slice())).toEqual(['X', '\x03', '\x03']);
  await expect(page.locator('#commentBar')).toHaveCount(0);
  await expect(page.locator('.mantine-Modal-content')).toHaveCount(0);
});

test('「按推文鍵開長推文」關掉 ⇒ 照舊原生類型選單，不出推文列', async ({ page }) => {
  await bootScenario(page, ptt, cassette([]), {
    commentBar: true,
    prefs: { enableEasyReading: true, pushKeyOpensLongPush: false },
  });
  await page.evaluate(() => window.__app.setInputAreaFocus());
  await page.keyboard.press('Shift+X');
  await waitFed(page, 2);
  await waitScreenSettled(page, { 23: '您覺得這篇文章' });
  await expect(page.locator('#commentBar')).toHaveCount(0);
  await expect(page.locator('#mainContainer [data-type="bbsline"]').filter({ hasText: '您覺得這篇文章' })).toHaveCount(1);
});
