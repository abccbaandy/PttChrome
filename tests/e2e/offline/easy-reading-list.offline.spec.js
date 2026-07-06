// 文章列表好读模式 —— 离线重放回归（stub WebSocket + cchat-list-* cassette，
// 真浏览器/真渲染，零网络）。CI gate：这里锁的是「进板即用」的最小闭环行为；
// 依赖特定文章/看板状态的部分留在 live e2e。
//
// v5 合约（docs/easy-reading-list.md）：外观近似原生（固定 24 行视窗、行首 ●
// 游标）、封闭互动、server 互动一律确定性交易。退文回列表 = re-seed（v5/M4）：
// server 落点权威（READ_REDRAW 全幅重绘的 getkeep 视窗与游标被直接采用，顺带
// 刷新推文数），不再逐行 parity 还原 —— 「退文画面不变」案锁的是 server 落点
// 与离开前一致这一 pttbbs 事实链，非 client 端保存的锚点。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const {
  loadCassette,
  bootOffline,
  replayListCassette,
} = require('../helpers/replay');

const nav = loadCassette('cchat-list-nav');
const prompt = loadCassette('cchat-list-prompt');
const pinned = loadCassette('cchat-list-pinned');

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
      topNum: ls._topNum,
      queueIdle: app.commandQueue.idle,
      sentCount: (window.__replay && window.__replay.sent.length) || 0,
      cursorHidden: document.getElementById('cursor').style.display === 'none',
      domRows: document.querySelectorAll('#mainContainer [data-type="bbsline"]')
        .length
    };
  });
}

// 24 行视窗的 DOM 文字（好读与原生同一渲染单轨，可直接互 diff）。
async function dumpScreenRows(page) {
  return await page.evaluate(() =>
    Array.from(
      document.querySelectorAll('#mainContainer [data-type="bbsline"]')
    ).map((el) => el.textContent)
  );
}

// 视窗游标列（含 ●）的 DOM row index；-1 = 没有游标列。
async function cursorRowIndex(page) {
  return await page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll('#mainContainer [data-type="bbsline"]')
    );
    return rows.findIndex((el) => el.textContent.includes('●'));
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
// 这条守的是 replayListCassette + 录制器产物本身 —— 视窗逻辑坏掉不影响它。
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

// ---- 原生视窗仿真闭环 ----

test.describe('文章列表好读模式（离线）', () => {
  test.skip(!nav, '缺 cchat-list-nav cassette（yarn record:cassette 先录一次）');

  // v5 退役中（M5 移除）：parity 合约已废弃（docs/easy-reading-list.md 核心原则 v5 版）。
  // 直接触发点：新录 cassette 首页含删除文 → 好读无条件隐藏（不变量 10）→ 逐行必不同，
  // 这正是「隐藏功能与 parity 本质冲突」的实例。
  test.skip('双模 engage 比对：开启好读瞬间 24 行画面与原生逐行相同（核心原则）', async ({ page }) => {
    test.setTimeout(60000);
    const logs = ptt.attachConsole(page);
    try {
      await bootOffline(page, ptt);
      await replayListCassette(page, nav);
      await page.waitForFunction(() => window.__app.buf.pageState === 2);
      await page.waitForTimeout(400); // 原生画面 settle/render flush

      const nativeRows = await dumpScreenRows(page);
      const nativeCursor = await cursorRowIndex(page);
      expect(nativeRows.length).toBe(24);
      expect(nativeCursor).toBeGreaterThanOrEqual(3);

      // 预读 0：engage 只 seed 当前页，无任何网络 —— 画面必须一模一样。
      await ptt.applyPrefs(page, {
        enableEasyReadingList: true,
        easyReadingListPrefetchCount: 0
      });
      await waitState(page, (x) => x.state === 'active' && x.renderMode === 'buffer');
      await page.waitForTimeout(300);

      const erRows = await dumpScreenRows(page);
      const erCursor = await cursorRowIndex(page);
      expect(erRows.length).toBe(24);
      for (let r = 0; r < 24; r++) {
        expect({ row: r, text: erRows[r] }).toEqual({ row: r, text: nativeRows[r] });
      }
      expect(erCursor).toBe(nativeCursor);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  test('进板启用：固定 24 行视窗、预读累积、序号严格递增、游标 ● 单一、实体游标隐藏', async ({ page }) => {
    test.setTimeout(60000);
    const logs = ptt.attachConsole(page);
    try {
      await bootOffline(page, ptt);
      await replayListCassette(page, nav);
      await page.waitForFunction(() => window.__app.buf.pageState === 2);

      // 开启 list 好读：evaluateNow 立即 seed，随后背景 fill 逐页吃 cassette。
      await ptt.applyPrefs(page, {
        enableEasyReadingList: true,
        easyReadingListPrefetchCount: 200
      });
      let s = await waitState(page, (x) => x.state === 'active' && x.renderMode === 'buffer');
      expect(s.cursorHidden).toBe(true);

      // fill 消耗两对锚定命令后，第三对的 PgUp 无素材可喂 → soft timeout → 良性到边。
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
      // 原生视窗仿真：DOM 固定 24 行（不随缓冲成长），fill prepend 不动视窗。
      expect(s.domRows).toBe(24);
      // 游标 = 恰好一列行首 ●（body 区内）。
      const rows = await dumpScreenRows(page);
      const bulletRows = rows
        .map((t, i) => (t.includes('●') ? i : -1))
        .filter((i) => i !== -1);
      expect(bulletRows.length).toBe(1);
      expect(bulletRows[0]).toBeGreaterThanOrEqual(3);
      expect(bulletRows[0]).toBeLessThanOrEqual(22);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  test('v5 封闭互动：未列键（z/i/b/y/s）no-op 吞键——零送键、不转态、不裸露原生', async ({ page }) => {
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

      await page.locator('#t').focus();
      // v、/ 已於 M3 交易化，不再屬未列鍵
      for (const k of ['z', 'i', 'b', 'y', 's']) {
        await page.keyboard.press(k);
        await page.waitForTimeout(60);
      }
      const after = await dumpListState(page);
      expect(after.state).toBe('active');
      expect(after.renderMode).toBe('buffer'); // 不裸露（原生鏡像會顯示黑名單/刪除文）
      expect(after.sentCount).toBe(before.sentCount); // 零送鍵（封閉互動）
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  test('本地导航即时：↑ 立即移动游标（不等 server），demand 背景补页', async ({ page }) => {
    test.setTimeout(60000);
    const logs = ptt.attachConsole(page);
    try {
      await bootOffline(page, ptt);
      await replayListCassette(page, nav);
      await page.waitForFunction(() => window.__app.buf.pageState === 2);
      // 预读 0：seed 后不 fill；↑ 的方向性 demand 会在背景补页，但游标移动
      // 本身零等待（这就是「到顶不卡一秒」的行为锁）。
      await ptt.applyPrefs(page, {
        enableEasyReadingList: true,
        easyReadingListPrefetchCount: 0
      });
      const before = await waitState(page, (x) => x.state === 'active' && x.queueIdle);
      expect(before.selectedNum).not.toBeNull();

      await page.locator('#t').focus();
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press('ArrowUp');
        await page.waitForTimeout(50);
      }
      // 游标已本地移动（即使 demand 还在途）。
      const after = await dumpListState(page);
      expect(after.selectedNum).toBe(before.selectedNum - 3);
      expect(after.state).toBe('active');
      expect(after.renderMode).toBe('buffer');
      // demand 背景补页最终成功（缓冲往旧成长）。
      const grown = await waitState(page, (x) => x.queueIdle && x.listLen > before.listLen, 15000);
      expect(Math.min(...grown.nums.filter((n) => n != null))).toBeLessThan(
        Math.min(...before.nums.filter((n) => n != null))
      );
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  test('黑名单作者列被隐藏、视窗由邻近列补满（仍 24 行、无空洞）', async ({ page }) => {
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
      await waitState(page, (x) => x.state === 'active' && x.queueIdle);

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
      expect(res.domRows).toBe(24); // 视窗不因隐藏而缺行（邻近列补满/尾端补空）
      expect(res.listLen).toBeGreaterThanOrEqual(20); // 缓冲仍保留隐藏列
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  test('PgUp 游标停新页顶＋开文返回画面不变（native parity 闭环）', async ({ page }) => {
    test.setTimeout(90000);
    const logs = ptt.attachConsole(page);
    try {
      await bootOffline(page, ptt);
      await replayListCassette(page, nav);
      await page.waitForFunction(() => window.__app.buf.pageState === 2);
      // 预读 30：fill 只吃第一对锚定命令；第二对留给 PgUp 的 demand。
      await ptt.applyPrefs(page, {
        enableEasyReadingList: true,
        easyReadingListPrefetchCount: 30
      });
      let s = await waitState(page, (x) => x.state === 'active' && x.listLen > 30 && x.queueIdle, 20000);

      await page.locator('#t').focus();
      // PgUp（本地翻页，read.c 语意：top-20、游标停新页顶）→ 视窗距缓冲顶
      // 不足一页 → demand-up 送「锚定 jump + PgUp」对（精确序号门控）。
      const fedBefore = await page.evaluate(() => window.__replay.fed);
      await page.keyboard.press('PageUp');
      await page.waitForTimeout(300);
      // 游标 = 视窗第一列（DOM row 3 = body 顶）。
      expect(await cursorRowIndex(page)).toBe(3);
      s = await waitState(page, (x) => x.queueIdle && x.listLen > 50, 15000);
      const fedAfter = await page.evaluate(() => window.__replay.fed);
      expect(fedAfter).toBeGreaterThan(fedBefore); // demand 确实走了锚定对
      // prepend 之后视窗以序号锚定 —— 游标仍在原列（新页没有把它往下挤）。
      expect(await cursorRowIndex(page)).toBe(3);

      // 选取开文目标（录制的第三个 jump，也是缓冲最旧一篇）。
      const jumps = nav.steps.filter((st) => st.num != null);
      const openNum = jumps[2].num;
      await page.evaluate((n) => {
        const ls = window.__app.listSession;
        ls._selectedNum = n;
        ls._selectedPinnedKey = null;
        ls._forceRedraw();
      }, openNum);
      await page.waitForTimeout(200);
      const rowsBeforeOpen = await dumpScreenRows(page);

      // Enter → opening(frozen) → 两段序列化命令 → 文章 → suspended。
      await page.keyboard.press('Enter');
      s = await waitState(page, (x) => x.state === 'suspended', 20000);
      expect(s.pageState).toBe(3);
      expect(s.renderMode).toBe('native');
      expect(s.cursorHidden).toBe(false);

      // ← 返回列表 → re-seed（v5/M4）：server 落点（游标停在刚读的文章）在
      // 缓冲内 → resume-buffer，maps 不重建（listLen 不缩水）、选取采落点，
      // 且 24 行画面与离开前完全相同（server getkeep 重绘同一页）。
      await page.keyboard.press('ArrowLeft');
      s = await waitState(page, (x) => x.state === 'active', 20000);
      expect(s.renderMode).toBe('buffer');
      expect(s.listLen).toBeGreaterThan(50);
      expect(s.selectedNum).toBe(openNum);
      expect(s.cursorHidden).toBe(true);
      await page.waitForTimeout(300);
      const rowsAfterRestore = await dumpScreenRows(page);
      // body + footer（rows 3..23）逐行严格相同。两处「原生也会变」的合法差异
      // 正规化掉：header 的「人氣」计数（开文期间 server 重画 header），与开文
      // 目标列的未读标记 +→空白（回列表时 server 重画该列为已读）。
      for (let r = 0; r < 24; r++) {
        const norm = (t) => {
          let x = r < 3 ? t.replace(/人氣:\d+/, '人氣:*') : t;
          // 开文列匹配：● 盖掉序号最高位（●53292 = 353292），两种形式都要认。
          const numStr = String(openNum);
          if (
            x.indexOf(numStr) !== -1 ||
            x.indexOf('●' + numStr.slice(1)) === 0
          ) {
            x = x.slice(0, 12).replace(/[+\-Mm~]/g, ' ') + x.slice(12);
          }
          return x;
        };
        expect({ row: r, text: norm(rowsAfterRestore[r]) }).toEqual({
          row: r,
          text: norm(rowsBeforeOpen[r])
        });
      }

      // restore 后继续往旧深卷：demand-up 锚定对（jumpsame + pageup）让缓冲
      // 最旧序号变小 —— 真游标曾被开文流程移走，锚定必须先跳回缓冲顶。
      // 前面 demand chain 的第三对（刪除文隱藏縮短 seq 觸發）其 PgUp 在
      // cassette 无素材 → soft timeout → 良性到边把 _edgeUp 锁住（真 server
      // 会有回应，不会锁）。清掉旗标模拟 evict 清边的情境，让 demand 重试。
      await page.evaluate(() => {
        window.__app.listSession._edgeUp = false;
      });
      const beforeMin = Math.min(...s.nums.filter((n) => n != null));
      await page.keyboard.press('PageUp');
      s = await waitState(page, (x) => x.queueIdle && x.listLen > 70, 15000);
      const afterMin = Math.min(...s.nums.filter((n) => n != null));
      expect(afterMin).toBeLessThan(beforeMin); // 边缘真的往旧成长
      // 舊文区往下读不会先看到置底文：视窗在旧区时画面不得出现 ★ 置底列。
      const rowsOld = await dumpScreenRows(page);
      const bodyOld = rowsOld.slice(3, 23);
      expect(bodyOld.some((t) => t.includes('★'))).toBe(false);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });
});

test.describe('置底文 Enter 开启（离线，pinned 卷）', () => {
  test.skip(!pinned, '缺 cchat-list-pinned cassette');

  test('选取置底列 Enter → End+↑×2 序列化开文 → 返回还原 pinned 选取', async ({ page }) => {
    test.setTimeout(60000);
    const logs = ptt.attachConsole(page);
    try {
      await bootOffline(page, ptt);
      await replayListCassette(page, pinned);
      await page.waitForFunction(() => window.__app.buf.pageState === 2);
      await ptt.applyPrefs(page, {
        enableEasyReadingList: true,
        easyReadingListPrefetchCount: 0
      });
      await waitState(page, (x) => x.state === 'active' && x.queueIdle);

      // 目标：pinned tail 倒数第 3 列（cassette 录的是 End 停驻列往上 2 列）。
      // flatten 保插入序 = 画面序，End 停在最后一列置底。seed 画面含 ★ →
      // _edgeDown 已确认 → pinned 列在可导航序列内。
      const targetKey = await page.evaluate(() => {
        const app = window.__app;
        const nums = app.buf.listLineNums;
        const pinnedIdx = [];
        for (let i = 0; i < nums.length; i++) if (nums[i] == null) pinnedIdx.push(i);
        if (pinnedIdx.length < 3) return null;
        const ls = app.listSession;
        const idx = pinnedIdx[pinnedIdx.length - 3];
        const key = ls._pinnedKeyAt(idx);
        ls._selectedNum = null;
        ls._selectedPinnedKey = key;
        ls._forceRedraw();
        return key;
      });
      expect(targetKey).toBeTruthy();

      // Enter → opening(frozen) → End + ↑×2（逐步 expect）→ Enter → 文章。
      await page.locator('#t').focus();
      await page.keyboard.press('Enter');
      let s = await waitState(page, (x) => x.state === 'suspended', 20000);
      expect(s.pageState).toBe(3);
      expect(s.renderMode).toBe('native');

      // ← 返回 → re-seed：pinned 落点 cursorRowNum=null → rebuild 路径，
      // _seedAnchors 从 server 游标列取 pinned key（与开文目标相同）。
      await page.keyboard.press('ArrowLeft');
      s = await waitState(page, (x) => x.state === 'active', 20000);
      expect(s.renderMode).toBe('buffer');
      expect(s.selectedNum).toBeNull();
      const restoredKey = await page.evaluate(
        () => window.__app.listSession._selectedPinnedKey
      );
      expect(restoredKey).toBe(targetKey);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });
});

// v5/M3：'/' 与 'v' 交易化（封闭互动——键不直通，走 CommandQueue 序列化＋
// overlay 收参；frozen 期间不裸露原生画面）。
test.describe('T2 交易（离线，search/mark 卷）', () => {
  const search = loadCassette('cchat-list-search');
  const mark = loadCassette('cchat-list-mark');

  test('/ 搜寻交易：prompt→输入框→提交→MODE_SELECT rebuild→← 退回主列表 rebuild', async ({ page }) => {
    test.skip(!search, '缺 cchat-list-search cassette');
    test.setTimeout(60000);
    const logs = ptt.attachConsole(page);
    try {
      await bootOffline(page, ptt);
      await replayListCassette(page, search);
      await page.waitForFunction(() => window.__app.buf.pageState === 2);
      await ptt.applyPrefs(page, {
        enableEasyReadingList: true,
        easyReadingListPrefetchCount: 0
      });
      let s = await waitState(page, (x) => x.state === 'active' && x.queueIdle);
      const mainNums = s.nums.filter((n) => n != null);

      // '/' → search-prompt 交易（frozen，不裸露）→ slash step 喂 prompt。
      await page.locator('#t').focus();
      await page.keyboard.press('/');
      await waitState(page, (x) => x.renderMode === 'frozen' || x.state === 'active');
      // 输入框出现 → 用「真实逐键」输入（不可用 fill 绕过键盘事件——回归：
      // 全域 keyup handler 每键把 focus 抢回 #t，输入框一个字都吃不到，且
      // keypress 泄漏进终端键盘）。收参等待期间「读取中」必须熄灭（交易并
      // 不在等 server）。
      const q = (search.steps.find((st) => st.on === 'query') || {}).query || 'Re';
      await page.waitForSelector('input[data-list-input]');
      const loadingWhilePrompt = await page.evaluate(() => {
        const el = window.__app.view._listLoadingEl;
        return !!el && el.style.display !== 'none';
      });
      expect(loadingWhilePrompt).toBe(false);
      await page.keyboard.type(q, { delay: 30 });
      await expect(page.locator('input[data-list-input]')).toHaveValue(q);
      await page.keyboard.press('Enter');

      // 提交完成 → MODE_SELECT 清单 rebuild（序号空间独立、缓冲重建）。
      s = await waitState(page, (x) => x.state === 'active' && x.queueIdle, 15000);
      expect(s.renderMode).toBe('buffer');
      const selNums = s.nums.filter((n) => n != null);
      expect(selNums.length).toBeGreaterThan(0);
      // 搜寻清单序号空间独立（远小于主列表 35 万级序号）。
      expect(Math.max(...selNums)).toBeLessThan(Math.min(...mainNums));

      // ← 退出 select → back step 喂主列表 → rebuild 回主序号空间。
      await page.keyboard.press('ArrowLeft');
      s = await waitState(
        page,
        (x) =>
          x.state === 'active' &&
          x.queueIdle &&
          x.nums.some((n) => n != null && n >= Math.min(...mainNums)),
        15000
      );
      expect(s.renderMode).toBe('buffer');
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  test('v 已读设定交易：v→prompt→overlay→Esc 取消（送 \\r 收 getdata）→FULLUPDATE resume', async ({ page }) => {
    test.skip(!mark, '缺 cchat-list-mark cassette');
    test.setTimeout(60000);
    const logs = ptt.attachConsole(page);
    try {
      await bootOffline(page, ptt);
      await replayListCassette(page, mark);
      await page.waitForFunction(() => window.__app.buf.pageState === 2);
      await ptt.applyPrefs(page, {
        enableEasyReadingList: true,
        easyReadingListPrefetchCount: 0
      });
      let s = await waitState(page, (x) => x.state === 'active' && x.queueIdle);
      const before = s.listLen;

      // 选取设为卷内 jump 目标：runtime 的 mark-sync-jump（先同步 server 游标
      // 到选取，W 分界＝游标文章）序号必须与录制 jump step 一致，门控才会喂。
      const markJumpNum = (mark.steps.find((st) => st.on === 'jump') || {}).num;
      expect(markJumpNum).toBeTruthy();
      await page.evaluate((n) => {
        const ls = window.__app.listSession;
        ls._selectedNum = n;
        ls._selectedPinnedKey = null;
        ls._forceRedraw();
      }, markJumpNum);

      // 'v' → mark-sync-jump（jump step）→ mark-prompt（mark step 喂 prompt
      // 画面）→ overlay 出现。
      await page.locator('#t').focus();
      await page.keyboard.press('v');
      // 等 prompt 交易完成、overlay 收参就绪（paramMode 设定）再操作——过早按键
      // 会被 frozen 吞掉（序列化保护，符合设计）。
      await page.waitForFunction(
        () => window.__app.listSession._paramMode && window.__app.listSession._paramMode.type === 'mark'
      );
      // frozen 快照期间：画面仍是 24 行列表视窗（不显示 server 的 prompt 画面）。
      const rows = await dumpScreenRows(page);
      expect(rows.some((t) => t.includes('文章選讀'))).toBe(true);

      // Esc 取消 → mark-commit '\r'（cancel step 喂 FULLUPDATE）→ resume buffer。
      await page.keyboard.press('Escape');
      s = await waitState(page, (x) => x.state === 'active' && x.queueIdle, 15000);
      expect(s.renderMode).toBe('buffer');
      expect(s.listLen).toBeGreaterThanOrEqual(before);
      expect(s.cursorHidden).toBe(true);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });
});
