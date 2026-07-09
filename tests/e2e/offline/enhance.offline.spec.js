// 增强功能 —— 离线版（重放 cassette，不连真实 PTT）。
// 永久化 tests/e2e/enhance.spec.js 里依赖真实文章/列表的守门：楼层编号、黑名单、
// pusher 高亮（遍历所有 article cassette）、看板列表黑名单（list cassette）。
// 没对应 cassette 就 skip（先 yarn record:cassette）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassettes, findCassette, bootOffline, replayCassette } = require('../helpers/replay');

const articles = findCassettes('article');
const list = findCassette('list');

// ---------- article cassette：楼层 / 黑名单 / pusher（逐卷） ----------
test.describe('增强 · 文章（离线重放）', () => {
  if (!articles.length) {
    test.skip('尚无 article cassette；先 yarn record:cassette', () => {});
  }

  for (const article of articles) {
    const tag = `[${article.__file}]`;

    test(`楼层编号：好读推文出现从 1 递增的序号 ${tag}`, async ({ page }) => {
      test.setTimeout(90000);
      await bootOffline(page, ptt);
      await ptt.applyPrefs(page, { enableEasyReading: true, showFloorNumbers: true });
      await replayCassette(page, article, { easyReading: true });

      // 与 live enhance.spec.js 同写法：读徽章 textContent（楼号），过滤 NaN。
      const floors = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#mainContainer [data-floor]'))
          .map((el) => parseInt(el.textContent, 10))
          .filter((n) => !Number.isNaN(n))
      );
      expect(floors.length).toBeGreaterThan(0);
      expect(floors[0]).toBe(1); // 第一楼从 1 起
      for (let i = 1; i < floors.length; i++) {
        expect(floors[i]).toBe(floors[i - 1] + 1); // 连续递增、不跳号
      }

      // 每个楼层徽章都必须落在「真推文列」（结尾有 MM/DD HH:MM）——守护偵测太松的回归。
      const badgeRows = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#mainContainer [data-floor]')).map((el) => {
          const row = el.closest('[data-type="bbsline"]') || el.closest('[type="bbsrow"]');
          return row ? row.textContent : '';
        })
      );
      badgeRows.forEach((t) => expect(t).toMatch(/\d{1,2}\/\d{2}\s+\d{2}:\d{2}/));
    });

    test(`黑名单：好读移除该 pusher 推文且不留空行 ${tag}`, async ({ page }) => {
      test.setTimeout(90000);
      const target = article.meta.firstCommentAuthor;
      test.skip(!target, 'cassette 无 firstCommentAuthor');

      await bootOffline(page, ptt);
      await ptt.applyPrefs(page, { enableEasyReading: true, showFloorNumbers: false });
      await replayCassette(page, article, { easyReading: true });

      const pushersOf = () =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll('#mainContainer [data-type="bbsline"]')).map((el) => {
            const m = el.textContent.match(/^(推|噓|→)\d*\s+([0-9A-Za-z]+)\s*:/);
            return m ? m[2].toLowerCase() : null;
          })
        );

      const before = await pushersOf();
      const c1 = before.filter(Boolean).length;
      expect(before.includes(target)).toBe(true);

      await ptt.applyPrefs(page, { blacklist: target }); // runtime 套用 → redraw
      await page.waitForTimeout(800);

      const after = await pushersOf();
      const c2 = after.filter(Boolean).length;
      expect(after.includes(target)).toBe(false); // 该 pusher 消失
      expect(c2).toBeLessThan(c1); // 列数下降（无空行残留由「整列移除」保证）
    });

    test(`pusher 高亮：togglePusherHighlight 只高亮该 pusher 的列 ${tag}`, async ({ page }) => {
      test.setTimeout(90000);
      const target = article.meta.firstCommentAuthor;
      test.skip(!target, 'cassette 无 firstCommentAuthor');

      await bootOffline(page, ptt);
      await ptt.applyPrefs(page, { enableEasyReading: true, showFloorNumbers: false });
      await replayCassette(page, article, { easyReading: true });

      await page.evaluate((t) => window.__app.view.togglePusherHighlight(t), target);
      await page.waitForTimeout(500);

      const highlighted = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#mainContainer > span[type="bbsrow"].pusherHighlight')).map(
          (el) => el.getAttribute('data-pusher')
        )
      );
      expect(highlighted.length).toBeGreaterThan(0);
      expect(highlighted.every((p) => p === target)).toBe(true);

      // 再 toggle 回去应清空高亮（重绘不重复 append）。
      await page.evaluate((t) => window.__app.view.togglePusherHighlight(t), target);
      await page.waitForTimeout(500);
      const cleared = await page.evaluate(
        () => document.querySelectorAll('#mainContainer > span[type="bbsrow"].pusherHighlight').length
      );
      expect(cleared).toBe(0);
    });
  }
});

// ---------- list cassette：看板列表黑名单 ----------
test.describe('增强 · 看板列表（离线重放）', () => {
  test.skip(!list, '尚无 list cassette；先 yarn record:cassette（RECORD_MODE=list）');

  // 原生模式（easyReading:false）：黑名单列不隐藏、不反黑，改渲染成被删除样式的
  // 「(本文已被黑名单) <作者>」通知列（2026-07 使用者定案）。好读模式才全部隐藏。
  test('列表黑名单：黑名单作者的列 → 原生显示「(本文已被黑名单)」通知列（不隐藏）', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await replayCassette(page, list, { easyReading: false });
    await page.waitForTimeout(500);

    // 从渲染出的列表抓一个作者（cols 17-28），把它列入黑名单。
    const target = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#mainContainer > span[type="bbsrow"]'));
      for (const el of rows) {
        const a = el.textContent.substring(17, 29).trim();
        if (/^[0-9A-Za-z]+$/.test(a)) return a.toLowerCase();
      }
      return null;
    });
    test.skip(!target, '列表没抓到可辨识作者栏');

    const counts = () =>
      page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#mainContainer > span[type="bbsrow"]'));
        return {
          hidden: rows.filter((el) => el.style && el.style.visibility === 'hidden').length,
          notice: rows.filter((el) => (el.textContent || '').includes("（本文已被黑名單）")).length
        };
      });

    const before = await counts();
    await ptt.applyPrefs(page, { blacklist: target });
    await page.waitForTimeout(800);
    const after = await counts();
    expect(after.notice).toBeGreaterThan(before.notice); // 至少多一列通知
    expect(after.hidden).toBe(before.hidden); // 原生模式不隐藏
  });

  test('标题黑名单：标题含关键字的列 → 通知列（不隐藏）', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await replayCassette(page, list, { easyReading: false });
    await page.waitForTimeout(500);

    // 从渲染出的列表抓一列标题（col 29 起），取其中一个中文/英数字片段当关键字。
    const keyword = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#mainContainer > span[type="bbsrow"]'));
      for (const el of rows) {
        const title = el.textContent.substring(29).trim();
        const m = title.match(/[0-9A-Za-z一-鿿]{2,}/);
        if (m) return m[0].toLowerCase();
      }
      return null;
    });
    test.skip(!keyword, '列表没抓到可用标题关键字');

    const noticeCnt = () =>
      page.evaluate(
        () =>
          Array.from(document.querySelectorAll('#mainContainer > span[type="bbsrow"]')).filter(
            (el) => (el.textContent || '').includes("（本文已被黑名單）")
          ).length
      );

    const before = await noticeCnt();
    await ptt.applyPrefs(page, { titleBlacklist: keyword });
    await page.waitForTimeout(800);
    const after = await noticeCnt();
    expect(after).toBeGreaterThan(before); // 至少多一列通知
  });
});
