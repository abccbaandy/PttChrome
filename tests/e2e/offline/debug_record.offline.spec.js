// Debug 錄製模式 offline e2e：不連真實 PTT（stub WebSocket），驗
//   1) 設定→關於 開啟 Switch → 主畫面出現錄製按鈕
//   2) 開始錄製 → feedRaw 餵 bytes → 停止 → 觸發下載，檔案 JSON 可解析、
//      events 含 recv/send、cassette 為既有 schema（on/recv base64）
//   3) 重新整理 → Switch 回到關閉、按鈕消失（不記憶 / 不落地）
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { installReplay, waitConnected, feedRaw } = require('../helpers/replay');

const label = (page, key) => page.evaluate((k) => window.__i18n(k), key);

async function openAboutTab(page) {
  await feedRaw(page, '\x1b[2J\x1b[H  DEBUG RECORD TEST LINE  ');
  await page.waitForTimeout(200);
  await page.locator('#BBSWindow').click({ button: 'right', position: { x: 40, y: 20 } });
  const menu = page.locator('.DropdownMenu').first();
  await expect(menu).toBeVisible();
  await menu.getByText(await label(page, 'cmenu_settings'), { exact: true }).click();
  await expect(page.locator('.PrefModal')).toBeVisible();
  await page
    .locator('.PrefModal__Grid__Col--left')
    .getByText(await label(page, 'options_about'), { exact: true })
    .click();
  await expect(page.locator('#pref-debug-mode')).toBeAttached();
}

async function boot(page) {
  await installReplay(page);
  await page.goto('/');
  await waitConnected(page);
}

test.describe('Debug 錄製模式（offline）', () => {
  test('開啟 Switch → 錄製 → 停止下載 JSON → 重整後重設', async ({ page }) => {
    await boot(page);

    // 預設關閉：無錄製按鈕
    await expect(page.locator('#debugRecordBtn')).toHaveCount(0);

    await openAboutTab(page);
    await page.locator('#pref-debug-mode').check();
    // 關掉設定 modal（Mantine close button）
    await page.locator('.PrefModal [aria-label="Close"]').click();
    await expect(page.locator('.PrefModal')).toBeHidden();

    // 按鈕出現 → 開始錄製
    const btn = page.locator('#debugRecordBtn');
    await expect(btn).toBeVisible();
    await btn.click();
    await expect(btn).toContainText(await label(page, 'debugRecord_stop'));

    // 餵 server bytes（走真 App.onData → 被 recorder 記到）＋ 模擬 client 送鍵
    await feedRaw(page, '\x1b[2J\x1b[Hhello from server');
    await page.evaluate(() => window.__app.conn.send('\x1b[6~'));
    await feedRaw(page, 'page two bytes');

    // 停止 → 攔下載
    const [download] = await Promise.all([page.waitForEvent('download'), btn.click()]);
    expect(download.suggestedFilename()).toMatch(/^ptt-debug-.*\.json$/);
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));

    expect(json.meta.mode).toBe('debug');
    expect(json.meta.warning).toBeTruthy();
    const dirs = json.events.map((e) => e.dir);
    expect(dirs).toContain('recv');
    expect(dirs).toContain('send');
    // recv 內容 round-trip（base64 latin1）
    const recvAll = json.events
      .filter((e) => e.dir === 'recv')
      .map((e) => Buffer.from(e.data, 'base64').toString('latin1'))
      .join('');
    expect(recvAll).toContain('hello from server');
    // cassette 為既有 schema：steps[].on/recv，且 pagedown 分界成立
    expect(json.cassette.meta.mode).toBe('debug-derived');
    expect(json.cassette.steps.map((s) => s.on)).toContain('pagedown');
    for (const s of json.cassette.steps) {
      expect(typeof s.on).toBe('string');
      expect(() => Buffer.from(s.recv, 'base64')).not.toThrow();
    }

    // 停止後按鈕回到「錄製」且 patch 已還原（再餵 bytes 不會炸）
    await expect(btn).toContainText(await label(page, 'debugRecord_start'));

    // 警告訊息出現，且可用 X 關閉
    const warning = page.getByText(await label(page, 'debugRecord_downloaded_warning'));
    await expect(warning).toBeVisible();
    await warning.locator('..').locator('[aria-label="Close"]').click();
    await expect(warning).toHaveCount(0);
    await feedRaw(page, 'after stop');

    // 重新整理：不記憶 → Switch 關閉、按鈕消失
    await page.reload();
    await waitConnected(page);
    await expect(page.locator('#debugRecordBtn')).toHaveCount(0);
    await openAboutTab(page);
    await expect(page.locator('#pref-debug-mode')).not.toBeChecked();
  });
});
