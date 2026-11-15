// P91 列表連推：90 秒內再按 X（或推自己的文），PTT 不給類型選單、直接給「→ id:」輸入列，倒數第二列
// 「時間太近, 使用 → 加註方式」（bbs.c#comment）。這時一樣出推文列，類型只剩 →。
//
// 素材：upstream 原始碼產的連推流程（tests/unit/fixtures/ptt_src_screens/push_again.json：列表 → 推一則
// → 回列表 → 再按 X 得到 too-close → world⏎ 確認列）。開場直接餵到「推完回列表」那一幀。
//
// 守的是：①推文列只有 → 一顆、旁邊寫著 PTT 那一行原話、焦點在輸入框；②送出不送類型鍵，
// 線上只有內容⏎ 與 y⏎；③✕ ＝替你取消（Ctrl-C 放棄），一個字都不寫。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootScenario, waitFed, waitScreenSettled } = require('../helpers/replay');
const fx = require('../../unit/fixtures/ptt_src_screens/push_again.json');

const b64 = (s) => Buffer.from(s, 'latin1').toString('base64');
const doneAt = fx.frames.findIndex((f) => f.name === 'done');
const upToDone = fx.frames.slice(0, doneAt + 1).map((f) => f.bytes).join('');
const frame = (name) => fx.frames.find((f) => f.name === name).bytes;
const bar = (page) => page.locator('#commentBar[data-comment-mode="list"]');
const input = (page) => page.locator('#commentBar [name="commentBarText"]');

async function openArrow(page, steps) {
  await bootScenario(
    page,
    ptt,
    {
      meta: { mode: 'scenario', scenario: 'list-push-arrow', prefs: {} },
      cols: fx.cols,
      rows: fx.rows,
      steps: [{ on: 'start', recv: b64(upToDone) }, { on: 'raw', send: b64('X'), recv: b64(frame('too-close')) }, ...steps],
    },
    { commentBar: true, prefs: { enableEasyReading: true, pushKeyOpensLongPush: true } },
  );
  await page.evaluate(() => window.__app.setInputAreaFocus());
  await page.keyboard.press('Shift+X');
  await waitFed(page, 2);
  await waitScreenSettled(page, { 22: '時間太近' });
}

test('90 秒內再按 X ⇒ 推文列只有 →、提示照 PTT 原話；送出只送 內容⏎→y⏎', async ({ page }) => {
  await openArrow(page, [
    { on: 'raw', send: b64('world\r'), recv: b64(frame('confirm')) },
    { on: 'raw', send: b64('y\r'), recv: b64(frame('done')) },
  ]);
  await expect(bar(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  await expect(page.locator('#commentBar [data-comment-type]')).toHaveCount(1);
  await expect(page.locator('#commentBar [data-comment-type="arrow"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#commentBar [data-comment-notice]')).toHaveText('時間太近, 使用 → 加註方式');

  await page.keyboard.type('world');
  expect(await page.evaluate(() => window.__replay.sent.slice())).toEqual(['X']);
  await page.keyboard.press('Enter');
  await waitFed(page, 4);
  await expect.poll(() => page.evaluate(() => window.__app.longPush.active)).toBe(false);
  expect(await page.evaluate(() => window.__replay.sent.slice())).toEqual(['X', 'world\r', 'y\r']);
  await expect(page.locator('#commentBar')).toHaveCount(0);
  await expect(page.locator('.mantine-Modal-content')).toHaveCount(0);
});

test('✕ ⇒ 替你取消（Ctrl-C 放棄），不寫任何字', async ({ page }) => {
  await openArrow(page, [{ on: 'raw', send: b64('\x03'), recv: b64(frame('done')) }]);
  await expect(bar(page)).toBeVisible();
  await page.locator('#commentBar [data-comment-cancel]').click();
  await waitFed(page, 3);
  await expect.poll(() => page.evaluate(() => window.__app.longPush.active)).toBe(false);
  expect(await page.evaluate(() => window.__replay.sent.slice())).toEqual(['X', '\x03']);
  await expect(page.locator('#commentBar')).toHaveCount(0);
});
