// 文章實況模式（文章裡按 v，別人推文時 PTT 主動把那一列送上畫面）—— 真瀏覽器＋完整 boot 鏈＋好讀累積頁。
//
// 素材：upstream 原始碼產的畫面（tests/unit/fixtures/ptt_src_screens/live_*.json，tools/ptt-src-screens
// 的 live_* 場景；driver 模擬 IPC service 把推文送進來）。推文是伺服器主動送的，沒有對應的按鍵 ⇒ 以
// feedRaw 直接餵。
//
// 兩代實況：
//   - 3c7d9af 舊版（pmore 裡的實況，fixture 在 ptt_src_screens_legacy/）：狀態列「實況 第 x 頁」照 pmore
//     的頁接。單頁短文在原地長高（狀態列 1~E 的 E 加 1、lineno 不動）以前被當成「往後接」，每則推文都把
//     整個畫面再接一次 ⇒ term_view.accumulatePageLines 的 'regrow'。
//   - c6d35a8 起（官方推文實況，more.c#live_run）：狀態列「實況中 mm:ss [+N]」、文章最後一頁＋橫幅
//     「實 況 開 始」＋推文往下印、滿了上捲。好讀用 term_view._accumulateLive 把推文接在累積頁後面
//     （live_mode.js）；文章段對不上累積頁（還沒讀到底）⇒ 認不出 ⇒ 原生鏡像。844e8d0 版任何鍵都會
//     離開實況回列表，490ceaf 起只認 q ⇒ 兩版都守「一個鍵都不替使用者送」。
// 真 PTT 跑私有 commit，新舊並存。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootScenario, waitFed, waitScreenSettled, feedRaw } = require('../helpers/replay');
const { waitRectStable } = require('../helpers/layout');

const b64 = (s) => Buffer.from(s, 'latin1').toString('base64');
const PAGE_DOWN = '\x1b[6~';

function load(file, dir) {
  const fx = require(`../../unit/fixtures/${dir}/${file}.json`);
  const frame = (name) => fx.frames.find((f) => f.name === name).bytes;
  return { fx, frame };
}

// opts.pages：文章幀之後、v 之前，好讀自動翻頁會送幾次 PageDown（fixture 的 page-2…）。
function setup(file, dir = 'ptt_src_screens_legacy', opts = {}) {
  const { fx, frame } = load(file, dir);
  const pre = fx.frames
    .slice(0, fx.frames.findIndex((f) => f.name === 'article'))
    .map((f) => f.bytes)
    .join('');
  const steps = [
    { on: 'start', recv: b64(pre) },
    { on: 'raw', send: b64('\r'), recv: b64(frame('article')) },
  ];
  for (let i = 0; i < (opts.pages || 0); ++i)
    steps.push({ on: 'raw', send: b64(PAGE_DOWN), recv: b64(frame(`page-${i + 2}`)) });
  steps.push({ on: 'raw', send: b64('v'), recv: b64(frame('live-on')) });
  const cassette = { meta: { mode: 'scenario', scenario: file, prefs: {} }, cols: fx.cols, rows: fx.rows, steps };
  return { frame, cassette };
}

// 累積頁（好讀畫的就是它）每一列的文字，去掉行尾空白。格子存的是 Big5 位元組 ⇒ 只拿來比 ASCII。
const pageTexts = (page) =>
  page.evaluate(() =>
    window.__app.buf.pageLines.map((row) =>
      row
        .map((c) => c.ch || '')
        .join('')
        .replace(/\s+$/, '')
    )
  );
// 好讀畫面上（DOM）各列的文字。
const domTexts = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('#mainContainer [data-type="bbsline"]')).map((e) =>
      e.textContent.replace(/\s+$/, '')
    )
  );
const footerText = (page) =>
  page.evaluate(() => (document.getElementById('easyReadingLastRow') || {}).textContent || '');
const count = (texts, s) => texts.filter((t) => t.includes(s)).length;
// 「live comment 1」也是「live comment 10」的子字串 ⇒ 比整個詞。
const countComment = (texts, n) =>
  texts.filter((t) => new RegExp(`live comment ${n}(?!\\d)`).test(t)).length;
const sent = (page) => page.evaluate(() => window.__replay.sent.slice());
const atBottom = (page) =>
  page.evaluate(() => {
    const el = window.__app.view.mainDisplay;
    return el.scrollTop + el.clientHeight >= el.scrollHeight - 2 * (window.__app.view.chh || 1);
  });

async function openLive(page, cassette, statusMark = '實況') {
  await bootScenario(page, ptt, cassette, { prefs: { enableEasyReading: true } });
  await ptt.sendKey(page, 'Enter');
  const n = cassette.steps.length;
  await waitFed(page, n - 1);
  await waitScreenSettled(page, { 23: '瀏覽' });
  await page.keyboard.press('v');
  await waitFed(page, n);
  await waitScreenSettled(page, { 23: statusMark });
}

async function pushComment(page, bytes, text) {
  await feedRaw(page, bytes);
  await waitScreenSettled(page, { 23: '實況' });
  await expect.poll(async () => count(await domTexts(page), text)).toBeGreaterThan(0);
}

test('單頁短文：實況推文接在原地，不重複整個畫面', async ({ page }) => {
  const { frame, cassette } = setup('live_short_3c7d9af');
  await openLive(page, cassette);
  const before = (await pageTexts(page)).length;

  await pushComment(page, frame('live-1'), 'first live comment');
  await pushComment(page, frame('live-2'), 'second live comment');

  const texts = await pageTexts(page);
  expect(texts.length).toBe(before);
  expect(count(texts, 'first live comment')).toBe(1);
  expect(count(texts, 'second live comment')).toBe(1);
  const dom = await domTexts(page);
  expect(count(dom, '實況短文')).toBe(1); // 標題列只有一份
  expect(count(dom, 'first live comment')).toBe(1);
  expect(count(dom, 'second live comment')).toBe(1);
  // 只送了使用者按的 ⏎ 與 v。
  expect(await sent(page)).toEqual(['\r', 'v']);
});

test('長文：實況推文照一般往後接，每則一列', async ({ page }) => {
  const { frame, cassette } = setup('live_long_3c7d9af');
  await openLive(page, cassette);
  const before = await pageTexts(page);

  await pushComment(page, frame('live-1'), 'first live comment');
  await pushComment(page, frame('live-2'), 'second live comment');

  const texts = await pageTexts(page);
  expect(texts.length).toBe(before.length + 2);
  expect(texts[texts.length - 2]).toContain('first live comment');
  expect(texts[texts.length - 1]).toContain('second live comment');
  const dom = await domTexts(page);
  expect(count(dom, '長文第 40 行')).toBe(1);
  expect(dom.slice(-3)[0]).toContain('長文第 40 行');
});

// 官方推文實況（more.c）。好讀接管（easy）＝文章段接得上累積頁：單頁短文一開文就讀完了。
// 長文 fixture 只有第 1 頁、好讀的 PageDown 沒有回應 ⇒ 中間沒讀到 ⇒ 認不出 ⇒ 原生鏡像（native）。
for (const [file, dir, offName, offKey, offBytes, mode] of [
  ['live_short_844e8d0', 'ptt_src_screens_legacy', 'live-off', 'v', 'v', 'easy'],
  ['live_long_844e8d0', 'ptt_src_screens_legacy', 'live-off-up', 'ArrowUp', '\x1b[A', 'native'],
  ['live_short', 'ptt_src_screens', 'live-off', 'q', 'q', 'easy'],
  ['live_long', 'ptt_src_screens', 'live-off', 'q', 'q', 'native'],
]) {
  test(`官方實況（more.c，${file}）：${mode === 'easy' ? '好讀把推文接在文章後面' : '文章段接不上 ⇒ 原生鏡像'}，一個鍵都不替使用者送；按鍵離開回列表`, async ({ page }) => {
    const { frame, cassette } = setup(file, dir);
    cassette.steps.push({ on: 'raw', send: b64(offBytes), recv: b64(frame(offName)) });
    await bootScenario(page, ptt, cassette, { prefs: { enableEasyReading: true } });
    await ptt.sendKey(page, 'Enter');
    await waitFed(page, 2);
    await waitScreenSettled(page, { 23: '瀏覽' });
    await page.keyboard.press('v');
    await waitFed(page, 3);
    await waitScreenSettled(page, { 23: '實況中' });
    // 進實況前好讀可能已經替長文送過翻頁（累積頁，正常）；進實況之後就一個都不准多。
    const atLive = await sent(page);
    expect(atLive[atLive.length - 1]).toBe('v');
    for (const [name, text] of [
      ['live-1', 'first live comment'],
      ['live-2', 'second live comment'],
    ]) {
      await feedRaw(page, frame(name));
      await waitScreenSettled(page, { 23: '實況中' });
      await expect.poll(async () => count(await domTexts(page), text)).toBe(1);
    }
    const dom = await domTexts(page);
    expect(count(dom, '實 況 開 始')).toBe(1);
    if (mode === 'easy') {
      // 狀態列在底部 footer 鏡像，不在累積頁裡；文章只有一份。
      expect(count(dom, '實況中')).toBe(0);
      expect(await footerText(page)).toContain('實況中');
      expect(count(dom, '實況短文')).toBe(1);
      expect(await page.evaluate(() => window.__app.view.isLiveReading())).toBe(true);
    } else {
      expect(count(dom, '實況中')).toBe(1);
      expect(await page.evaluate(() => window.__app.view.isLiveReading())).toBe(false);
    }
    // 844e8d0 版任何鍵都會離開實況回列表 ⇒ 推文送到、好讀看到新畫面，都不可以替使用者送任何東西。
    expect(await sent(page)).toEqual(atLive);

    await page.keyboard.press(offKey);
    await waitFed(page, 4);
    await waitScreenSettled(page, { 2: '編號' });
    await expect.poll(() => page.evaluate(() => window.__app.buf.pageState)).toBe(2);
    expect(await sent(page)).toEqual([...atLive, offBytes]);
  });
}

// 好讀的常態：自動翻頁讀完整篇（PageDown 到 100%）再按 v。推文多到「實 況 開 始」橫幅捲出畫面，
// 之後每則都只靠「上捲幾列」對齊（live_mode.mergeLiveWindow）。
test('官方實況：長文讀完整篇再進實況，好讀把每則推文接在文末各一列；橫幅捲走後照樣對齊、跟著到底', async ({ page }) => {
  const { frame, cassette } = setup('live_long_read', 'ptt_src_screens', { pages: 2 });
  cassette.steps.push({ on: 'raw', send: b64('q'), recv: b64(frame('live-off')) });
  await bootScenario(page, ptt, cassette, { prefs: { enableEasyReading: true } });
  await ptt.sendKey(page, 'Enter');
  await waitFed(page, 4); // 開文＋好讀自動翻兩頁
  await waitScreenSettled(page, { 23: '100%' });
  await page.keyboard.press('v');
  await waitFed(page, 5);
  await waitScreenSettled(page, { 23: '實況中' });
  await expect.poll(() => page.evaluate(() => window.__app.view.isLiveReading())).toBe(true);
  const atLive = await sent(page);
  expect(atLive).toEqual(['\r', PAGE_DOWN, PAGE_DOWN, 'v']);

  for (let n = 1; n <= 26; ++n) {
    await feedRaw(page, frame(`live-${n}`));
    await waitScreenSettled(page, { 23: `[+${n}]` });
    await expect.poll(async () => countComment(await domTexts(page), n)).toBe(1);
  }
  const dom = await domTexts(page);
  // 文章一份、橫幅一份、每則推文各一份，順序是文章 → 橫幅 → 推文。
  expect(count(dom, '長文第 1 行')).toBe(1);
  expect(count(dom, '長文第 40 行')).toBe(1);
  expect(count(dom, '實 況 開 始')).toBe(1);
  for (let n = 1; n <= 26; ++n) expect(countComment(dom, n)).toBe(1);
  const iBanner = dom.findIndex((t) => t.includes('實 況 開 始'));
  expect(dom.findIndex((t) => t.includes('長文第 40 行'))).toBeLessThan(iBanner);
  expect(dom.findIndex((t) => /live comment 1(?!\d)/.test(t))).toBe(iBanner + 1);
  expect(dom[dom.length - 1]).toContain('live comment 26');
  expect(count(dom, '實況中')).toBe(0);
  expect(await footerText(page)).toContain('[+26]');
  // 進實況就到底，之後一路跟著。
  await expect.poll(() => atBottom(page)).toBe(true);
  expect(await sent(page)).toEqual(atLive);
  // 最後一則推文不可以被底部 footer（實況狀態列鏡像）蓋住：footer 正上方那一點底下的列就是它。
  // （實況分支漏了累積頁的底部 padding 時，最後一列整個藏在 footer 後面。）
  // （同作者推文會合併成一個區塊，最後一則畫在區塊裡 ⇒ 量「最後一個看得到的列」的下緣。）
  const footer = await waitRectStable(page, '#easyReadingLastRow');
  const lastBottom = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#mainContainer [data-type="bbsline"]'))
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.height > 0);
    return rows[rows.length - 1].bottom;
  });
  expect(lastBottom).toBeLessThanOrEqual(footer.top + 1);

  // 捲動鍵只捲好讀長頁、不送任何 byte（live_run 不認；844e8d0 版甚至會離開實況）。
  for (const k of ['PageUp', 'ArrowUp', 'Home', 'ArrowDown', 'PageDown', 'End']) await ptt.sendKey(page, k);
  // 鈴聲（B）照送，畫面留在好讀。
  await ptt.sendKey(page, 'b');
  expect(await sent(page)).toEqual([...atLive, 'b']);
  expect(await page.evaluate(() => window.__app.view.isLiveReading())).toBe(true);
  expect(count(await domTexts(page), '長文第 1 行')).toBe(1);

  // ← ＝離開：live_run 不認 ←，改送 q；回到文章列表。
  await ptt.sendKey(page, 'ArrowLeft');
  await waitFed(page, 6);
  await waitScreenSettled(page, { 2: '編號' });
  await expect.poll(() => page.evaluate(() => window.__app.buf.pageState)).toBe(2);
  expect(await sent(page)).toEqual([...atLive, 'b', 'q']);
});

// Live 文小幫手（js/live_helper.js）：從真的右鍵選單打開面板，按鈕替使用者按 v／B／q，
// 好讀全程開著（舊版要先關好讀、自己每 N 秒裸送 ←→End）。
test('Live 文小幫手：面板「開始實況」送 v、好讀接推文；「鈴聲」送 B；「離開實況」送 q 回列表', async ({ page }) => {
  const { frame, cassette } = setup('live_long_read', 'ptt_src_screens', { pages: 2 });
  // 面板的 v 不是使用者鍵盤按的：setup 已排好 v → live-on，這裡再接 q → live-off。
  cassette.steps.push({ on: 'raw', send: b64('q'), recv: b64(frame('live-off')) });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await bootScenario(page, ptt, cassette, {
    prefs: { enableEasyReading: true, enableLiveArticleHelper: true },
  });
  await ptt.sendKey(page, 'Enter');
  await waitFed(page, 4);
  await waitScreenSettled(page, { 23: '100%' });

  const label = (k) => page.evaluate((key) => window.__i18n(key), k);
  await page.locator('#BBSWindow').click({ button: 'right', position: { x: 300, y: 200 } });
  const menu = page.locator('.DropdownMenu').first();
  await expect(menu).toBeVisible();
  await menu.getByText(await label('cmenu_showLiveArticleHelper'), { exact: true }).click();
  const panel = page.locator('.LiveHelperModal');
  await expect(panel).toBeVisible();
  // 面板不是 modal：終端機照收鍵盤。
  expect(await page.evaluate(() => window.__app.modalShown)).toBe(false);

  await panel.getByRole('button', { name: await label('liveHelperStart') }).click();
  await waitFed(page, 5);
  await waitScreenSettled(page, { 23: '實況中' });
  await expect.poll(() => page.evaluate(() => window.__app.view.isLiveReading())).toBe(true);
  expect(await sent(page)).toEqual(['\r', PAGE_DOWN, PAGE_DOWN, 'v']);
  // 好讀沒被關：文章從第 1 行起都還在，橫幅接在文末。
  const dom = await domTexts(page);
  expect(count(dom, '長文第 1 行')).toBe(1);
  expect(count(dom, '實 況 開 始')).toBe(1);
  await expect(panel.getByRole('button', { name: await label('liveHelperLeave') })).toBeVisible();

  await feedRaw(page, frame('live-1'));
  await waitScreenSettled(page, { 23: '[+1]' });
  await expect(panel).toContainText(String(await label('liveHelperReceived')).replace('%d', '1'));
  expect(countComment(await domTexts(page), 1)).toBe(1);

  await panel.getByRole('button', { name: await label('liveHelperBellOff') }).click();
  expect(await sent(page)).toEqual(['\r', PAGE_DOWN, PAGE_DOWN, 'v', 'B']);

  await panel.getByRole('button', { name: await label('liveHelperLeave') }).click();
  await waitFed(page, 6);
  await waitScreenSettled(page, { 2: '編號' });
  await expect.poll(() => page.evaluate(() => window.__app.buf.pageState)).toBe(2);
  expect(await sent(page)).toEqual(['\r', PAGE_DOWN, PAGE_DOWN, 'v', 'B', 'q']);
  // 回到列表：開始鈕停用，說明要先進文章。
  await expect(panel.getByRole('button', { name: await label('liveHelperStart') })).toBeDisabled();
  await expect(panel).toContainText(await label('liveHelperNeedArticle'));
  expect(errors).toEqual([]);
});

test('Live 文小幫手：面板開著時，文章裡按 End ＝開始實況（好讀不先把 End 吃掉）', async ({ page }) => {
  const { cassette } = setup('live_long_read', 'ptt_src_screens', { pages: 2 });
  await bootScenario(page, ptt, cassette, {
    prefs: { enableEasyReading: true, enableLiveArticleHelper: true, endTurnsOnLiveUpdate: true },
  });
  await ptt.sendKey(page, 'Enter');
  await waitFed(page, 4);
  await waitScreenSettled(page, { 23: '100%' });
  // 面板沒開：End 是好讀的「捲到文末」，不送 v。
  await ptt.sendKey(page, 'End');
  expect(await sent(page)).toEqual(['\r', PAGE_DOWN, PAGE_DOWN]);

  const label = (k) => page.evaluate((key) => window.__i18n(key), k);
  await page.locator('#BBSWindow').click({ button: 'right', position: { x: 300, y: 200 } });
  await page
    .locator('.DropdownMenu')
    .first()
    .getByText(await label('cmenu_showLiveArticleHelper'), { exact: true })
    .click();
  await expect(page.locator('.LiveHelperModal')).toBeVisible();
  await ptt.sendKey(page, 'End');
  await waitFed(page, 5);
  await waitScreenSettled(page, { 23: '實況中' });
  expect(await sent(page)).toEqual(['\r', PAGE_DOWN, PAGE_DOWN, 'v']);
  await expect.poll(() => page.evaluate(() => window.__app.view.isLiveReading())).toBe(true);
});
