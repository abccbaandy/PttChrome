// 增强功能 —— 离线版（重放 cassette，不连真实 PTT）。
// 永久化 tests/e2e/enhance.spec.js 里依赖真实文章/列表的守门：楼层编号、黑名单、
// pusher 高亮（遍历所有 article cassette）、看板列表黑名单（list cassette）。
// 没对应 cassette 就 skip（先 yarn record:cassette）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassettes, findCassette, bootOffline, replayCassette } = require('../helpers/replay');
// 量座標前一律先等版面停（helpers/layout.js 是判準的單一來源）。
const { waitPreviewsSettled } = require('../helpers/layout');

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
      // mergeSameAuthorComments:false —— 本测锁「逐列楼号连增」旧行为；
      // 合并（预设开）的行为守护在 comment_merge.offline.spec.js。
      await ptt.applyPrefs(page, {
        enableEasyReading: true,
        showFloorNumbers: true,
        mergeSameAuthorComments: false,
      });
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

    // 幾何守護（jsdom 量不到，必須真瀏覽器）：樓層徽章以「作者 id 起始欄」為右邊界
    // 向左生長。舊版是向右溢出，100 樓以上（3 位數）會壓住 id 第一個字 → 樓號與作者
    // 名都看不清。同時守「零寬盒不位移等寬格線」。
    test(`樓層徽章不侵入作者 id 欄、且不位移格線 ${tag}`, async ({ page }) => {
      test.setTimeout(90000);
      await bootOffline(page, ptt);
      await ptt.applyPrefs(page, {
        enableEasyReading: true,
        showFloorNumbers: true,
        mergeSameAuthorComments: false,
      });
      await replayCassette(page, article, { easyReading: true });

      // 量「數字實際佔的框」= .floorBadgeNum（帶 transform，rect 反映真實位置）；
      // 外層 .floorBadge 是零寬盒，量它會恆真、測不到東西。
      // mutateTo：把第一個徽章的數字改寫成指定字串（純 DOM 操作，不觸發 redraw）
      // → cassette 未必有 100+ 樓，用它驗高位數。
      const measure = (mutateTo) =>
        page.evaluate((mutateTo) => {
          // 取 bbsline 內第 index 個字元的 rect（跳過徽章自身的文字節點）。
          const charRect = (line, index) => {
            const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
            let n;
            let seen = 0;
            while ((n = walker.nextNode())) {
              if (n.parentElement && n.parentElement.closest('[data-floor]')) continue;
              const len = n.nodeValue.length;
              if (seen + len > index) {
                const r = document.createRange();
                r.setStart(n, index - seen);
                r.setEnd(n, index - seen + 1);
                return r.getBoundingClientRect();
              }
              seen += len;
            }
            return null;
          };
          if (mutateTo) {
            const first = document.querySelector('#mainContainer .floorBadgeNum');
            if (first) {
              first.textContent = mutateTo;
              first.parentElement.classList.add('floorBadge--wide');
            }
          }
          const out = [];
          for (const line of document.querySelectorAll('#mainContainer [data-type="bbsline"]')) {
            // 推文列：marker（1 個 JS 字元、佔 2 欄）+ 空格 → 作者 id 首字 = index 2
            const id = charRect(line, 2);
            if (!id) continue;
            const num = line.querySelector('.floorBadgeNum');
            const numRect = num ? num.getBoundingClientRect() : null;
            out.push({
              row: line.getAttribute('data-row'),
              idLeft: id.left,
              seq: num ? num.textContent : null,
              numRight: numRect ? numRect.right : null,
              numWidth: numRect ? numRect.width : null,
            });
          }
          return out;
        }, mutateTo);

      await waitPreviewsSettled(page);
      const withFloors = await measure(null);
      const badged = withFloors.filter((m) => m.seq !== null);
      expect(badged.length).toBeGreaterThan(0);
      for (const m of badged) {
        expect(m.numWidth).toBeGreaterThan(0); // 真的畫出來（非 0 寬）
        expect(m.numRight).toBeLessThanOrEqual(m.idLeft + 1); // 不越過 id 起始欄（1px 容差）
      }

      // 高位數（4 位）同樣不越界 —— 這正是舊版會壓到 id 的情境。
      const wide = await measure('1234');
      const mutated = wide.filter((m) => m.seq === '1234');
      expect(mutated.length).toBe(1);
      expect(mutated[0].numWidth).toBeGreaterThan(0);
      expect(mutated[0].numRight).toBeLessThanOrEqual(mutated[0].idLeft + 1);

      // 格線零位移：關掉樓號後，同一列的作者 id 首字 x 座標必須完全相同。
      await ptt.applyPrefs(page, { showFloorNumbers: false });
      // 關樓號會走全量重建（annotationsKey 變了）⇒ 佔位盒整批 disposeNode 重做。
      // 固定 500ms 在圖回得慢時只量到中間態；等版面終局才是「格線零位移」的量測點。
      await waitPreviewsSettled(page);
      const off = await measure(null);
      expect(off.every((m) => m.seq === null)).toBe(true); // 徽章確實消失
      const offByRow = new Map(off.map((m) => [m.row, m.idLeft]));
      let compared = 0;
      for (const m of badged) {
        const x = offByRow.get(m.row);
        if (x === undefined) continue;
        expect(Math.abs(x - m.idLeft)).toBeLessThan(0.5);
        compared++;
      }
      expect(compared).toBeGreaterThan(0);
    });

    test(`黑名单：好读移除该 pusher 推文且不留空行 ${tag}`, async ({ page }) => {
      test.setTimeout(90000);
      const target = article.meta.firstCommentAuthor;
      test.skip(!target, 'cassette 无 firstCommentAuthor');

      await bootOffline(page, ptt);
      // 关合并：本测逐列比对 pusher 与列文字（合并块会包一层 div，行结构不同；合并行为另测）。
      await ptt.applyPrefs(page, {
        enableEasyReading: true,
        showFloorNumbers: false,
        mergeSameAuthorComments: false,
      });
      await replayCassette(page, article, { easyReading: true });

      // 逐列快照：pusher 读 data-pusher 属性（楼号徽章数字会混进 textContent）。
      const readRows = () =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll('#mainContainer span[type="bbsrow"]')).map((el) => ({
            pusher: el.getAttribute('data-pusher'),
            text: el.textContent,
          }))
        );

      const before = await readRows();
      expect(before.some((r) => r.pusher === target)).toBe(true);

      await ptt.applyPrefs(page, { blacklist: target }); // runtime 套用 → redraw
      await page.waitForTimeout(800);

      const after = await readRows();
      expect(after.some((r) => r.pusher === target)).toBe(false); // 该 pusher 消失
      // cassette 是固定 bytes、同一页 redraw ⇒ 内容可**完全等值**比对：after 必须逐列等于
      // before 滤掉 target 推文列。这才是严格的「不留空行」守护（列数比较太弱，且 live
      // 那边因为文章会长根本不能比，见 enhance.spec.js 黑名单案的注解）。
      expect(after.map((r) => r.text)).toEqual(
        before.filter((r) => r.pusher !== target).map((r) => r.text)
      );
    });

    test(`pusher 高亮：togglePusherHighlight 只高亮该 pusher 的列 ${tag}`, async ({ page }) => {
      test.setTimeout(90000);
      const target = article.meta.firstCommentAuthor;
      test.skip(!target, 'cassette 无 firstCommentAuthor');

      await bootOffline(page, ptt);
      // 关合并：selector 是 #mainContainer 直系子层 bbsrow，合并块包在 div 内会漏计。
      await ptt.applyPrefs(page, {
        enableEasyReading: true,
        showFloorNumbers: false,
        mergeSameAuthorComments: false,
      });
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
