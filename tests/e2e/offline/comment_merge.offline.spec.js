// 好讀「連續同作者推文合併」（預設開）—— 離線重放守門。
// 核心不變量：渲染後相鄰的推文列不得同 pusher（同作者連續列必已合併）。
// 指名素材 stock-end（rz2x 連續 7 則）：七則合成一塊、樓層範圍徽章、內容零遺失、
// 關開關即還原逐列。pusher 一律讀 data-pusher 屬性（樓層徽章「N-M」會混進
// textContent，正則解析會誤判）。
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassettes, bootOffline, replayCassette } = require('../helpers/replay');

const articles = findCassettes('article');

// DOM 順序的 bbsrow 快照：data-pusher（推文列才有）+ 是否在合併塊內。
const readRows = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('#mainContainer span[type="bbsrow"]')).map((el) => ({
      pusher: el.getAttribute('data-pusher'),
      merged: !!el.closest('.mergedCommentBlock'),
      text: el.textContent,
    }))
  );

test.describe('推文合併 · 相鄰不同 pusher 不變量（逐卷）', () => {
  if (!articles.length) {
    test.skip('尚無 article cassette；先 yarn record:cassette', () => {});
  }

  for (const article of articles) {
    test(`相鄰推文列不得同 pusher [${article.__file}]`, async ({ page }) => {
      test.setTimeout(90000);
      await bootOffline(page, ptt);
      // 不顯式傳 mergeSameAuthorComments —— 驗「預設即開」。
      await ptt.applyPrefs(page, { enableEasyReading: true, showFloorNumbers: true });
      await replayCassette(page, article, { easyReading: true });

      const rows = await readRows(page);
      expect(rows.length).toBeGreaterThan(0);
      for (let i = 1; i < rows.length; i++) {
        if (rows[i].pusher && rows[i - 1].pusher) {
          expect(rows[i].pusher).not.toBe(rows[i - 1].pusher);
        }
      }
    });
  }
});

test.describe('推文合併 · stock-end 指名斷言（rz2x×7）', () => {
  const cassette = articles.find((a) => a.__file === 'stock-end.json');
  const fixturePath = path.join(__dirname, '../../unit/fixtures/replay/stock-end.page.json');
  test.skip(!cassette || !fs.existsSync(fixturePath), '缺 stock-end cassette/fixture');

  test('七則合成一塊：樓層範圍徽章、內容零遺失、時間範圍', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true, showFloorNumbers: true });
    await replayCassette(page, cassette, { easyReading: true });

    // rz2x 只剩一列（7 → 1），且在合併塊內。
    const rows = await readRows(page);
    const rz = rows.filter((r) => r.pusher === 'rz2x');
    expect(rz.length).toBe(1);
    expect(rz[0].merged).toBe(true);

    // 樓層範圍徽章「N-M」＋時間範圍標籤。
    const block = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('.mergedCommentBlock')).find((b) => {
        const row = b.querySelector('span[type="bbsrow"]');
        return row && row.getAttribute('data-pusher') === 'rz2x';
      });
      if (!el) return null;
      const floor = el.querySelector('[data-floor]');
      const time = el.querySelector('.mergedCommentTime');
      return {
        text: el.textContent,
        floor: floor ? floor.textContent : null,
        time: time ? time.textContent : null,
      };
    });
    expect(block).not.toBeNull();
    expect(block.floor).toMatch(/^\d+-\d+$/);
    expect(block.time).toMatch(/\d{1,2}\/\d{2} \d{2}:\d{2}/);

    // 內容零遺失：golden 七則 rz2x 的內容子字串皆須在塊內。
    const golden = JSON.parse(fs.readFileSync(fixturePath, 'utf8')).golden;
    const contents = golden.comments
      .filter((s) => /^(推|噓|→)\s+rz2x\s*:/i.test(s))
      .map((s) =>
        s
          .replace(/^(推|噓|→)\s+[0-9A-Za-z]+\s*:\s*/, '')
          .replace(/\s*\d{1,2}\/\d{2}\s+\d{2}:\d{2}\s*$/, '')
          .trim()
      )
      .filter(Boolean);
    expect(contents.length).toBe(7);
    for (const c of contents) {
      expect(block.text).toContain(c);
    }
  });

  test('關開關（runtime applyPrefs）→ 還原逐列', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true, showFloorNumbers: false });
    await replayCassette(page, cassette, { easyReading: true });

    expect((await readRows(page)).filter((r) => r.pusher === 'rz2x').length).toBe(1);

    await ptt.applyPrefs(page, { mergeSameAuthorComments: false }); // onPrefChange → redraw
    await page.waitForTimeout(800);

    const rows = await readRows(page);
    expect(rows.filter((r) => r.pusher === 'rz2x').length).toBe(7);
    expect(rows.some((r) => r.merged)).toBe(false);
  });
});
