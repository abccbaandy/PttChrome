// Debug 錄製模式 offline e2e：不連真實 PTT（stub WebSocket），驗
//   1) 設定→關於 開啟 Switch → 「⋯」浮動工具出現（非文章畫面也要有），面板裡有錄製鈕
//   2) 開始錄製 → 「⋯」標示錄製中 → feedRaw 餵 bytes → 停止 → 觸發下載，檔案 JSON
//      可解析、events 含 recv/send、cassette 為既有 schema（on/recv base64）
//   3) 錄製中關掉 Switch ⇒ 自動停止並下載、「⋯」消失
//   4) 重新整理 → Switch 回到關閉、按鈕消失（不記憶 / 不落地）
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { hoverFloatTools } = require('../helpers/real_input');
const {
  installReplay,
  waitConnected,
  feedRaw,
  findCassette,
  bootOffline,
  replayCassette,
  waitScreenSettled,
} = require('../helpers/replay');
const { waitPreviewsSettled, waitScrollStable } = require('../helpers/layout');

const article = findCassette('article');

const label = (page, key) => page.evaluate((k) => window.__i18n(k), key);

async function openAboutTab(page) {
  await feedRaw(page, '\x1b[2J\x1b[H  DEBUG RECORD TEST LINE  ');
  await waitScreenSettled(page);
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

    // 非文章畫面也出現「⋯」；錄製鈕收在面板裡 → 開始錄製
    const tools = page.locator('#floatTools');
    await expect(tools).toBeVisible();
    const btn = page.locator('#floatTools .floatTools__panel #debugRecordBtn');
    await expect(btn).toBeHidden();
    await hoverFloatTools(page);
    await btn.click();
    await expect(btn).toContainText(await label(page, 'debugRecord_stop'));
    await expect(tools).toHaveAttribute('data-recording', '');

    // 餵 server bytes（走真 App.onData → 被 recorder 記到）＋ 模擬 client 送鍵
    await feedRaw(page, '\x1b[2J\x1b[Hhello from server');
    await page.evaluate(() => window.__app.conn.send('\x1b[6~'));
    await feedRaw(page, 'page two bytes');

    // 停止 → 攔下載
    await hoverFloatTools(page);
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
    await expect(tools).not.toHaveAttribute('data-recording', '');

    // 警告訊息出現，且可用 X 關閉
    const warning = page.getByText(await label(page, 'debugRecord_downloaded_warning'));
    await expect(warning).toBeVisible();
    await page.locator('#debugRecordNotice [aria-label="Close"]').click();
    await expect(warning).toHaveCount(0);
    await feedRaw(page, 'after stop');

    // 錄製中關掉 debug 模式 ⇒ 自動停止並下載（不丟資料），「⋯」跟著消失
    await hoverFloatTools(page);
    await btn.click();
    await expect(tools).toHaveAttribute('data-recording', '');
    await openAboutTab(page);
    const [autoDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#pref-debug-mode').uncheck(),
    ]);
    expect(autoDownload.suggestedFilename()).toMatch(/^ptt-debug-.*\.json$/);
    await page.locator('.PrefModal [aria-label="Close"]').click();
    await expect(page.locator('.PrefModal')).toBeHidden();
    await expect(page.locator('#floatTools')).toHaveCount(0);
    expect(await page.evaluate(() => window.__app.debugRecorder)).toBe(null);

    // 重新整理：不記憶 → Switch 關閉、按鈕消失
    await page.reload();
    await waitConnected(page);
    await expect(page.locator('#debugRecordBtn')).toHaveCount(0);
    await openAboutTab(page);
    await expect(page.locator('#pref-debug-mode')).not.toBeChecked();
  });

  // 好讀長頁的捲動軌跡（main.wheel／main.scroll）：真滾輪捲過去，錄製檔要記到
  // 「輸入」與「實際位置」兩筆。listener 的掛拆（分支邏輯）在
  // tests/unit/debug_recorder.test.js；這裡守真瀏覽器下 wheel 真的到得了捲動容器
  //（原生 24 列模式下 window capture 的滾輪 handler 會 stopPropagation，到不了 ——
  // 所以這條必須在好讀裡跑）。
  test('錄製期間：好讀長頁的真滾輪與捲動位置寫進錄製檔', async ({ page }) => {
    test.skip(!article, '尚無 article cassette；先 yarn record:cassette');
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await openAboutTab(page);
    await page.locator('#pref-debug-mode').check();
    await page.locator('.PrefModal [aria-label="Close"]').click();
    await expect(page.locator('.PrefModal')).toBeHidden();
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await replayCassette(page, article, { easyReading: true });
    await waitPreviewsSettled(page);

    const btn = page.locator('#debugRecordBtn');
    await hoverFloatTools(page);
    await btn.click();
    await expect(btn).toContainText(await label(page, 'debugRecord_stop'));

    const main = await page.locator('.main').boundingBox();
    const topBefore = await page.evaluate(() => document.querySelector('.main').scrollTop);
    await page.mouse.move(main.x + main.width / 2, main.y + main.height / 2);
    await page.mouse.wheel(0, 300);
    await waitScrollStable(page, '.main');

    await hoverFloatTools(page);
    const [download] = await Promise.all([page.waitForEvent('download'), btn.click()]);
    const chunks = [];
    for await (const c of await download.createReadStream()) chunks.push(c);
    const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const logs = json.events.filter((e) => e.dir === 'log');
    const wheel = logs.find((e) => e.tag === 'main.wheel');
    expect(wheel, '錄製檔裡沒有 main.wheel').toBeTruthy();
    expect(wheel.info.dy).toBe(300);
    const scrolls = logs.filter((e) => e.tag === 'main.scroll');
    expect(scrolls.length).toBeGreaterThan(0);
    // wheel 那筆的 top 不能拿來比：passive listener 跑的時候合成器可能已經捲完了。
    expect(scrolls[scrolls.length - 1].info.top).toBeGreaterThan(topBefore);
  });
});
