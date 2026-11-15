// 手機好讀文章折行後的懸掛縮排（P86，js/hang_indent.js、docs/mobile.md「折行時保留縮排」）。
// 只在 offline-mobile project 跑（Pixel 7 模擬）。素材 stock-end：盤後閒聊的內文用行首空白
// 排名單，手機上一列折成好幾行。
// 症狀：續行一律回到最左邊，夾在兩行縮排之間像另一行字。
// 鎖：真 boot、真字型與 fixedResize 的格寬下，續行左緣對齊第一行的第一個字；關掉開關回到原狀。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassettes, bootOffline, replayCassette } = require('../helpers/replay');
const { scrollIntoViewStable } = require('../helpers/layout');

const cassette = findCassettes('article').find((a) => a.__file === 'stock-end.json');

// 行首有空白、而且真的被折成多行的內文列（沒有預覽盒）的 srow。
const wrappedIndentedRows = (page) =>
  page.evaluate(() => {
    const chh = window.__app.view.chh;
    return Array.from(document.querySelectorAll('#mainContainer span[type="bbsrow"]'))
      .filter((el) => {
        if (el.querySelector('.inlinePreviewSlot, img, video, iframe')) return false;
        if (el.hasAttribute('data-pusher')) return false;
        const t = el.textContent;
        if (!/^[ 　]+\S/.test(t)) return false;
        return el.getBoundingClientRect().height > chh * 1.5;
      })
      .map((el) => el.getAttribute('srow'));
  });

// 每一行（line box）第一個字的 x，以及第一個非空白字的 x（相對列節點左緣）。
const lineStarts = (page, srow) =>
  page.evaluate((srow) => {
    const node = document.querySelector(`#mainContainer span[type="bbsrow"][srow="${srow}"]`);
    const left = node.getBoundingClientRect().left;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const starts = [];
    let lastTop = null;
    let firstText = null;
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      for (let i = 0; i < t.length; ++i) {
        const r = document.createRange();
        r.setStart(t, i);
        r.setEnd(t, i + 1);
        const rect = r.getClientRects()[0];
        if (!rect || !rect.width) continue;
        if (lastTop === null || rect.top > lastTop + 5) {
          starts.push(rect.left - left);
          lastTop = rect.top;
        }
        if (firstText === null && t.data[i].trim()) firstText = rect.left - left;
      }
    }
    return { starts, firstText, hang: node.classList.contains('hangIndent') };
  }, srow);

test.describe('手機折行保留縮排（P86，離線重放 stock-end）', () => {
  test.skip(!cassette, '缺 stock-end cassette');

  for (const on of [true, false]) {
    test(on ? '開：續行對齊第一行的第一個字' : '關：續行回到最左邊、不加 class', async ({ page }) => {
      test.setTimeout(90000);
      await bootOffline(page, ptt);
      await ptt.applyPrefs(page, { enableEasyReading: true, mobileHangIndent: on });
      await replayCassette(page, cassette, { easyReading: true });
      await expect.poll(() => page.evaluate(() => window.__app.view.reflow)).toBe(true);

      const rows = await wrappedIndentedRows(page);
      expect(rows.length).toBeGreaterThan(0);
      const srow = rows[0];
      await scrollIntoViewStable(page, `#mainContainer span[type="bbsrow"][srow="${srow}"]`);
      const { starts, firstText, hang } = await lineStarts(page, srow);
      expect(hang).toBe(on);
      expect(starts.length).toBeGreaterThan(1);
      expect(firstText).toBeGreaterThan(4);
      // 第一行照舊從 0 起（行首空白自己佔住縮排）。
      expect(starts[0]).toBeLessThan(1);
      for (const s of starts.slice(1)) {
        if (on) expect(Math.abs(s - firstText)).toBeLessThan(1.5);
        else expect(s).toBeLessThan(1);
      }
      // 不能把版面撐出水平捲軸。
      const overflow = await page.evaluate(() => {
        const main = document.querySelector('.main');
        return main.scrollWidth - main.clientWidth;
      });
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});
