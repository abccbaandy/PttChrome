// 文章列表好读模式 v4 —— 离线重放回归（stub WebSocket + cchat-list-* cassette，
// 真浏览器/真渲染，零网络）。CI gate：这里锁的是「进板即用」的最小闭环行为；
// 依赖特定文章/看板状态的部分留在 live e2e。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const {
  loadCassette,
  bootOffline,
  replayListCassette,
} = require('../helpers/replay');

const nav = loadCassette('cchat-list-nav');
const prompt = loadCassette('cchat-list-prompt');

async function dumpListState(page) {
  return await page.evaluate(() => {
    const app = window.__app;
    const ls = app.listSession;
    return {
      state: ls.state,
      renderMode: app.buf.listRenderMode,
      pageState: app.buf.pageState,
      listLen: (app.buf.listLines || []).length,
      nums: (app.buf.listLineNums || []).slice(),
      selectedNum: ls._selectedNum,
      queueIdle: app.commandQueue.idle,
      sentCount: (window.__replay && window.__replay.sent.length) || 0,
      cursorHidden: document.getElementById('cursor').style.display === 'none',
      domRows: document.querySelectorAll('#mainContainer [data-type="bbsline"]')
        .length
    };
  });
}

async function waitState(page, pred, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await dumpListState(page);
    if (pred(last)) return last;
    await page.waitForTimeout(200);
  }
  throw new Error('waitState 超时：' + JSON.stringify(last));
}

// 门控机制 smoke：不开 list 好读（pref 全预设 off），直接用键盘 / conn.send 触发
// 门控 map，验证 cassette 每个 step 都喂得进真 parser、终局画面回到看板列表。
// 这条守的是 replayListCassette + 录制器产物本身 —— v4 逻辑坏掉不影响它。
test.describe('replayListCassette 门控机制', () => {
  test.skip(!nav, '缺 cchat-list-nav cassette（yarn record:cassette 先录一次）');

  test('键盘/直送 bytes 依序喂完 nav 卷全部 step', async ({ page }) => {
    const logs = ptt.attachConsole(page);
    try {
      await bootOffline(page, ptt);
      await replayListCassette(page, nav);
      // start step 已喂：画面应是看板列表。
      await page.waitForFunction(() => window.__app.buf.pageState === 2);

      await page.locator('#t').focus();
      const sendJump = (num) =>
        page.evaluate((n) => window.__app.conn.send(String(n) + '\r'), num);
      const waitFed = async (n) =>
        page.waitForFunction((x) => window.__replay.fed >= x, n, {
          timeout: 5000,
        });
      // 依 cassette 顺序驱动：jump 直送「数字+\r」（CommandQueue 的送法，键盘
      // 逐字打不会匹配精确序号门控）；其余用真键盘。
      const jumps = nav.steps.filter((s) => s.num != null);
      await sendJump(jumps[0].num); // jump#1
      await waitFed(2);
      await page.keyboard.press('PageUp');
      await waitFed(3);
      await sendJump(jumps[1].num); // jump#2
      await waitFed(4);
      await page.keyboard.press('PageUp');
      await waitFed(5);
      await sendJump(jumps[2].num); // jump#3（开文目标）
      await waitFed(6);
      await page.keyboard.press('Enter'); // open
      await waitFed(7);
      await page.waitForFunction(() => window.__app.buf.pageState === 3); // 文章
      await page.keyboard.press('ArrowLeft'); // back
      await waitFed(8);
      await sendJump(jumps[3].num); // jumpsame
      await waitFed(9);
      await page.keyboard.press('PageUp'); // 最后一卷 pageup
      await page.waitForFunction(() => window.__replay && window.__replay.done);

      // 终局：最后 pageup 是列表页。
      await page.waitForFunction(() => window.__app.buf.pageState === 2);
      const fed = await page.evaluate(() => window.__replay.fed);
      expect(fed).toBe(nav.steps.length);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-20)) console.log(l);
      throw e;
    }
  });
});

// ---- v4 最小闭环（M6）＋预读（M7）＋开文交棒（M8） ----

test.describe('文章列表好读模式（离线）', () => {
  test.skip(!nav, '缺 cchat-list-nav cassette（yarn record:cassette 先录一次）');

  test('进板启用：buffer 渲染、预读累积、序号严格递增、置底文在尾、游标隐藏、●已补号', async ({ page }) => {
    test.setTimeout(60000);
    const logs = ptt.attachConsole(page);
    try {
      await bootOffline(page, ptt);
      await replayListCassette(page, nav);
      await page.waitForFunction(() => window.__app.buf.pageState === 2);

      // 开启 list 好读：evaluateNow 立即 seed，随后背景 fill（PgUp）逐页吃 cassette。
      await ptt.applyPrefs(page, {
        enableEasyReadingList: true,
        easyReadingListPrefetchCount: 200
      });
      let s = await waitState(page, (x) => x.state === 'active' && x.renderMode === 'buffer');
      expect(s.cursorHidden).toBe(true);

      // fill 消耗 pageup×2 后，第三个 PgUp 无素材可喂 → soft timeout → 视为到边（良性）。
      s = await waitState(page, (x) => x.listLen > 40 && x.queueIdle, 20000);
      console.log('accumulated:', s.listLen, 'state:', s.state);
      expect(s.state).toBe('active');

      // 序号（去掉置底 null）严格递增无重复；null 只在尾端。
      const firstNull = s.nums.indexOf(null);
      const numbered = firstNull === -1 ? s.nums : s.nums.slice(0, firstNull);
      const tail = firstNull === -1 ? [] : s.nums.slice(firstNull);
      expect(numbered.length).toBeGreaterThan(40);
      expect(numbered.every((n) => n != null)).toBe(true);
      expect(tail.every((n) => n == null)).toBe(true);
      for (let i = 1; i < numbered.length; i++) {
        expect(numbered[i]).toBeGreaterThan(numbered[i - 1]);
      }
      // 无黑名单时 DOM 列数 == listLen；游标列 ● 已用反推序号补回。
      expect(s.domRows).toBe(s.listLen);
      const hasBullet = await page.evaluate(() =>
        Array.from(
          document.querySelectorAll('#mainContainer [data-type="bbsline"]')
        ).some((el) => el.textContent.includes('●'))
      );
      expect(hasBullet).toBe(false);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  test('本地导航零网路：↑↓ 移动选取不送任何 bytes', async ({ page }) => {
    test.setTimeout(60000);
    const logs = ptt.attachConsole(page);
    try {
      await bootOffline(page, ptt);
      await replayListCassette(page, nav);
      await page.waitForFunction(() => window.__app.buf.pageState === 2);
      // 预读 0：seed 后不 fill，队列立即 idle，送出计数干净。
      await ptt.applyPrefs(page, {
        enableEasyReadingList: true,
        easyReadingListPrefetchCount: 0
      });
      const before = await waitState(page, (x) => x.state === 'active' && x.queueIdle);
      expect(before.selectedNum).not.toBeNull();

      await page.locator('#t').focus();
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press('ArrowUp');
        await page.waitForTimeout(100);
      }
      const after = await dumpListState(page);
      expect(after.selectedNum).toBeLessThan(before.selectedNum); // 往旧移动
      expect(after.sentCount).toBe(before.sentCount); // 零网路
      expect(after.state).toBe('active'); // 不掉 native
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  test('黑名单作者列从 DOM 真正移除（无空行）', async ({ page }) => {
    test.setTimeout(60000);
    const logs = ptt.attachConsole(page);
    try {
      await bootOffline(page, ptt);
      await replayListCassette(page, nav);
      await page.waitForFunction(() => window.__app.buf.pageState === 2);
      await ptt.applyPrefs(page, {
        enableEasyReadingList: true,
        easyReadingListPrefetchCount: 0
      });
      const before = await waitState(page, (x) => x.state === 'active' && x.queueIdle);

      // 从 DOM 抓一个作者当黑名单目标。
      const author = await page.evaluate(() => {
        const lines = Array.from(
          document.querySelectorAll('#mainContainer [data-type="bbsline"]')
        ).map((el) => el.textContent);
        for (const t of lines) {
          const m = t.match(
            /^\s*\d+\s+[+\-\dMm~ ]+\s*\d+\/\d+\s+([A-Za-z][0-9A-Za-z]+)\b/
          );
          if (m) return m[1].toLowerCase();
        }
        return null;
      });
      expect(author).toBeTruthy();

      await ptt.applyPrefs(page, { blacklist: author });
      await page.waitForTimeout(500);
      const res = await page.evaluate((a) => {
        const lines = Array.from(
          document.querySelectorAll('#mainContainer [data-type="bbsline"]')
        ).map((el) => el.textContent.toLowerCase());
        return {
          domRows: lines.length,
          hasAuthor: lines.some((t) => t.includes(a)),
          listLen: window.__app.buf.listLines.length
        };
      }, author);
      expect(res.hasAuthor).toBe(false);
      expect(res.domRows).toBeLessThan(res.listLen);
      expect(res.domRows).toBeLessThan(before.domRows);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  test('开文交棒＋返回还原＋restore 后深卷（M8 全闭环＋stabilize bug 3 红灯）', async ({ page }) => {
    test.setTimeout(90000);
    const logs = ptt.attachConsole(page);
    try {
      await bootOffline(page, ptt);
      await replayListCassette(page, nav);
      await page.waitForFunction(() => window.__app.buf.pageState === 2);
      // 预读 30：fill 只吃第一对 jump+pageup；其余 step 由 demand / 开文流程消耗。
      await ptt.applyPrefs(page, {
        enableEasyReadingList: true,
        easyReadingListPrefetchCount: 30
      });
      let s = await waitState(page, (x) => x.state === 'active' && x.listLen > 30 && x.queueIdle, 20000);

      await page.locator('#t').focus();
      // PageUp×2（本地翻页）把选取推到顶端 → demand-up 送「锚定 jump + PgUp」
      // 命令对，吃掉第二对 step（精确序号门控：锚点必须与录制一致才喂）。
      const fedBefore = await page.evaluate(() => window.__replay.fed);
      await page.keyboard.press('PageUp');
      await page.waitForTimeout(300);
      await page.keyboard.press('PageUp');
      await waitState(page, (x) => x.queueIdle && x.listLen > 50, 15000);
      const fedAfter = await page.evaluate(() => window.__replay.fed);
      expect(fedAfter).toBeGreaterThan(fedBefore); // demand 确实走了锚定对

      // 选取开文目标（录制的第三个 jump，也是缓冲最旧一篇）。
      const jumps = nav.steps.filter((st) => st.num != null);
      const openNum = jumps[2].num;
      await page.evaluate((n) => {
        const ls = window.__app.listSession;
        ls._selectedNum = n;
        ls._selectedPinnedKey = null;
        ls.applyHighlight(true);
      }, openNum);

      // Enter → opening(frozen) → 两段序列化命令 → 文章 → suspended。
      await page.keyboard.press('Enter');
      s = await waitState(page, (x) => x.state === 'suspended', 20000);
      expect(s.pageState).toBe(3);
      expect(s.renderMode).toBe('native');
      expect(s.cursorHidden).toBe(false);

      // ← 返回列表 → restore：maps 不重建（listLen 不缩水）、选回原文。
      await page.keyboard.press('ArrowLeft');
      s = await waitState(page, (x) => x.state === 'active', 20000);
      expect(s.renderMode).toBe('buffer');
      expect(s.listLen).toBeGreaterThan(50);
      expect(s.selectedNum).toBe(openNum);
      expect(s.cursorHidden).toBe(true);

      // stabilize bug 3 红灯：restore 后（真游标曾被开文流程移走）继续往旧深卷，
      // demand-up 必须先锚定回缓冲顶端再 PgUp —— 旧实作从游标现位盲翻，缓冲边缘
      // 不成长（卡住）。断言：缓冲最旧序号确实变小、选取列视口位置不跳动。
      const before = await page.evaluate(() => {
        const app = window.__app;
        const nums = app.buf.listLineNums.filter((n) => n != null);
        const ls = app.listSession;
        const idx = ls._resolveSelectedIndex();
        const el = document.querySelector('[data-row="' + idx + '"]');
        return { min: nums[0], selTop: el ? el.getBoundingClientRect().top : null };
      });
      await page.keyboard.press('PageUp'); // 选取已在顶端 → 触发 demand-up 锚定对
      s = await waitState(page, (x) => x.queueIdle && x.listLen > 70, 15000);
      const after = await page.evaluate(() => {
        const app = window.__app;
        const nums = app.buf.listLineNums.filter((n) => n != null);
        const ls = app.listSession;
        const idx = ls._resolveSelectedIndex();
        const el = document.querySelector('[data-row="' + idx + '"]');
        return { min: nums[0], selTop: el ? el.getBoundingClientRect().top : null };
      });
      console.log('deep-scroll:', JSON.stringify({ before, after }));
      expect(after.min).toBeLessThan(before.min); // 边缘真的往旧成长
      // prepend 锚定：选取列的视口位置不因上方插入而位移（容忍 2px 取整）。
      expect(before.selTop).not.toBeNull();
      expect(Math.abs(after.selTop - before.selTop)).toBeLessThanOrEqual(2);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });
});

test.describe('原生功能直通（离线，prompt 卷）', () => {
  test.skip(!prompt, '缺 cchat-list-prompt cassette');

  test('/ → functionMode 原生 LIVE（游标出现），取消 → 回 buffer', async ({ page }) => {
    test.setTimeout(60000);
    const logs = ptt.attachConsole(page);
    try {
      await bootOffline(page, ptt);
      await replayListCassette(page, prompt);
      await page.waitForFunction(() => window.__app.buf.pageState === 2);
      await ptt.applyPrefs(page, {
        enableEasyReadingList: true,
        easyReadingListPrefetchCount: 0
      });
      let s = await waitState(page, (x) => x.state === 'active' && x.queueIdle);
      expect(s.cursorHidden).toBe(true);

      // '/'：非导航键 → functionMode（键照送 → 门控喂 slash step → 原生 prompt）。
      await page.locator('#t').focus();
      await page.keyboard.press('/');
      s = await waitState(page, (x) => x.state === 'functionMode');
      expect(s.renderMode).toBe('native');
      expect(s.cursorHidden).toBe(false);
      // 等 server 回应画完 prompt（notify 30ms timer 跑完、isLeadByte 标好才能
      // b2u —— 立即读会拿到 Big5 单 byte 乱码）。
      await page.waitForFunction(
        () => {
          const buf = window.__app.buf;
          const t = buf.getRowText(buf.rows - 1, 0, buf.cols);
          return /搜尋|尋找|標題/.test(t);
        },
        null,
        { timeout: 5000 }
      );

      // 空 Enter 取消 → cancel step → clean-list settle → 内容判定 exit 回 active。
      await page.keyboard.press('Enter');
      s = await waitState(page, (x) => x.state === 'active');
      expect(s.renderMode).toBe('buffer');
      expect(s.cursorHidden).toBe(true);
      expect(s.listLen).toBeGreaterThan(15);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });
});
