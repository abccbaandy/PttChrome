// 文章實況模式（upstream pttbbs 3c7d9af：文章裡按 v，別人推文時 PTT 主動把那一列送上畫面）
// —— 真瀏覽器＋完整 boot 鏈＋好讀累積頁。
//
// 素材：upstream 原始碼產的畫面（tests/unit/fixtures/ptt_src_screens/live_short.json、
// live_long.json，tools/ptt-src-screens 的 live_* 場景；driver 模擬 IPC service 把推文送進來）。
// 推文是伺服器主動送的，沒有對應的按鍵 ⇒ 以 feedRaw 直接餵。
//
// 守的是 term_view.accumulatePageLines：單頁短文在原地長高（狀態列 1~E 的 E 加 1、lineno 不動）
// 以前被當成「往後接」，累積頁是第一幀整個畫面（含空白填充列）、行號只到 E ⇒ 每則推文都把
// 整個畫面再接一次，推文埋在一堆空白列後面看不到。長文（畫面已滿、上捲一列）照一般往後接。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootScenario, waitFed, waitScreenSettled, feedRaw } = require('../helpers/replay');

const b64 = (s) => Buffer.from(s, 'latin1').toString('base64');

function setup(file) {
  const fx = require(`../../unit/fixtures/ptt_src_screens/${file}.json`);
  const frame = (name) => fx.frames.find((f) => f.name === name).bytes;
  const pre = fx.frames
    .slice(0, fx.frames.findIndex((f) => f.name === 'article'))
    .map((f) => f.bytes)
    .join('');
  const cassette = {
    meta: { mode: 'scenario', scenario: file, prefs: {} },
    cols: fx.cols,
    rows: fx.rows,
    steps: [
      { on: 'start', recv: b64(pre) },
      { on: 'raw', send: b64('\r'), recv: b64(frame('article')) },
      { on: 'raw', send: b64('v'), recv: b64(frame('live-on')) },
    ],
  };
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
const count = (texts, s) => texts.filter((t) => t.includes(s)).length;

async function openLive(page, cassette) {
  await bootScenario(page, ptt, cassette, { prefs: { enableEasyReading: true } });
  await ptt.sendKey(page, 'Enter');
  await waitFed(page, 2);
  await waitScreenSettled(page, { 23: '瀏覽' });
  await page.keyboard.press('v');
  await waitFed(page, 3);
  await waitScreenSettled(page, { 23: '實況' });
}

async function pushComment(page, bytes, text) {
  await feedRaw(page, bytes);
  await waitScreenSettled(page, { 23: '實況' });
  await expect.poll(async () => count(await domTexts(page), text)).toBeGreaterThan(0);
}

test('單頁短文：實況推文接在原地，不重複整個畫面', async ({ page }) => {
  const { frame, cassette } = setup('live_short');
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
  expect(await page.evaluate(() => window.__replay.sent.slice())).toEqual(['\r', 'v']);
});

test('長文：實況推文照一般往後接，每則一列', async ({ page }) => {
  const { frame, cassette } = setup('live_long');
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
