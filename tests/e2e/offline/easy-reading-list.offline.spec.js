// 文章列表好读模式 —— 离线重放回归（stub WebSocket + cchat-list-* cassette，
// 真浏览器/真渲染，零网络）。CI gate：这里锁的是「进板即用」的最小闭环行为；
// 依赖特定文章/看板状态的部分留在 live e2e。
//
// v5 合约（docs/easy-reading-list.md）：外观近似原生（固定 24 行视窗、行首 '>'
// 游标，比照 pttbbs STR_CURSOR）、封闭互动、server 互动一律确定性交易。
// **注意 cassette 是旧 server（全形 ● 游标）录的 raw bytes**：解析 server 画面的
// parser 双支援两代游标，我们自己画的假游标则一律 '>'。
// 退文回列表 = re-seed（v5/M4）：
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
// 舊 server（全形 ● 游標，pttbbs b9a5029f 之前）錄的同一支腳本。主測試已改跑新
// 素材，這卷專門守護「解析 server 畫面的 parser 對兩代游標都要認得」——只留一條
// 核心閉環，不整包跑兩遍。
const navWide = loadCassette('cchat-list-nav-wide');

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
      selectedPinnedKey: ls._selectedPinnedKey,
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

// 视窗游标列（行首 '>'）的 DOM row index；-1 = 没有游标列。
// 游标自 pttbbs b9a5029f「Always do CURSOR_ASCII」起是半形 '>'（STR_CURSOR），
// 我们画的假游标比照办理。**必须比对行首**——'>' 也可能出现在标题文字里。
async function cursorRowIndex(page) {
  return await page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll('#mainContainer [data-type="bbsline"]')
    );
    return rows.findIndex((el) => el.textContent.startsWith('>'));
  });
}

// 視窗頂端在「過濾後序列」裡的位置（0 = 已在 buffer 最上方）。滾輪平滑捲動的
// 斷言需要知道上方還剩多少可捲距離。
async function windowTopPos(page) {
  return await page.evaluate(() => {
    const ls = window.__app.listSession;
    const nums = window.__app.buf.listLineNums || [];
    const abs = nums.indexOf(ls._topNum);
    return abs === -1 ? -1 : ls._sequence().indexOf(abs);
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

  // 双模 engage 逐行比对案已退役（v5/M5）：parity 合约废弃，隐藏功能（黑名单/
  // 删除文）与逐行相同本质冲突（docs/easy-reading-list.md 核心原则 v5 版）。

  test('进板启用：固定 24 行视窗、预读累积、序号严格递增、游标 > 单一、实体游标隐藏', async ({ page }) => {
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
      // 游标 = 恰好一列行首 '>'（body 区内）。行首比对：'>' 可能出现在标题里。
      const rows = await dumpScreenRows(page);
      const cursorRows = rows
        .map((t, i) => (t.startsWith('>') ? i : -1))
        .filter((i) => i !== -1);
      expect(cursorRows.length).toBe(1);
      expect(cursorRows[0]).toBeGreaterThanOrEqual(3);
      expect(cursorRows[0]).toBeLessThanOrEqual(22);
      // 半形游标只盖 %7d 的前导空格 ⇒ 序号完整可见（旧全形 ● 会吃掉最高位）。
      expect(rows[cursorRows[0]]).toMatch(/^>\d{5,7}\s/);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  // 兩代游標相容（pttbbs b9a5029f「Always do CURSOR_ASCII」把 STR_CURSOR2 ● 換成
  // STR_CURSOR >）。舊素材必須照樣 engage、序號照樣讀得到：● 蓋掉 %7d 的前導空格
  // ＋最高位數字，靠 pageArticleNums 從鄰居回推；'>' 則直接可讀。任何一邊的 parser
  // 退化都會讓 facts.cursorRowNum 變 null → 交易 expect 餓死 → 卡住。
  // 我們**畫**的游標與素材世代無關，一律 '>'（labelListCursor）。
  test('舊 ● 游標素材仍能 engage：序號從鄰居回推、視窗照樣成形（雙支援）', async ({ page }) => {
    test.setTimeout(60000);
    const logs = ptt.attachConsole(page);
    try {
      await bootOffline(page, ptt);
      await replayListCassette(page, navWide);
      await page.waitForFunction(() => window.__app.buf.pageState === 2);
      await ptt.applyPrefs(page, {
        enableEasyReadingList: true,
        easyReadingListPrefetchCount: 200
      });
      let s = await waitState(page, (x) => x.state === 'active' && x.renderMode === 'buffer');
      expect(s.cursorHidden).toBe(true);
      s = await waitState(page, (x) => x.listLen > 40 && x.queueIdle, 20000);
      expect(s.state).toBe('active');

      // 序號嚴格遞增＝● 蓋掉的最高位真的被回推正確（回推錯會亂序/重複）。
      const firstNull = s.nums.indexOf(null);
      const numbered = firstNull === -1 ? s.nums : s.nums.slice(0, firstNull);
      expect(numbered.length).toBeGreaterThan(40);
      for (let i = 1; i < numbered.length; i++) {
        expect(numbered[i]).toBeGreaterThan(numbered[i - 1]);
      }
      expect(s.domRows).toBe(24);

      // 渲染出來的游標仍是我們畫的 '>'（素材是 ● 世代，但畫面不該出現 ●）。
      const rows = await dumpScreenRows(page);
      const cursorRows = rows
        .map((t, i) => (t.startsWith('>') ? i : -1))
        .filter((i) => i !== -1);
      expect(cursorRows.length).toBe(1);
      expect(rows[cursorRows[0]]).toMatch(/^>\d{5,7}\s/);
      // ● 不得漏進視窗任何一列的行首（relabel/blank 還原沒做好就會殘留）。
      expect(rows.filter((t) => t.startsWith('●')).length).toBe(0);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  test('未列键单按切原生（2026-07-10 passthrough）：z → 切原生＋代送、frozen 期间吞键有提示', async ({ page }) => {
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
      // seed 落点 server 游标=选取 → 免 sync 腿：单按 z 直接切原生＋代送。
      await page.keyboard.press('z');
      const after = await waitState(
        page,
        (x) => x.state === 'functionMode' && x.renderMode === 'native',
        10000
      );
      expect(after.state).toBe('functionMode');
      // 代送恰好一键（z 一个 byte；cassette 无对应 step，server 无回应＝良性）。
      expect(after.sentCount).toBe(before.sentCount + 1);
      const sent = await page.evaluate(() => window.__replay.sent.slice(-1)[0]);
      expect(sent).toBe('z');
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  test('实体键/空白键不再误切原生（2026-08「按 Caps Lock/F2/空白键画面跑掉」回归）', async ({ page }) => {
    // 旧码：CapsLock/F2 落 passthrough 的 bytes==null 分支 → 跳过 cursor sync 腿
    // 直接切原生镜像（server 完全没动，画面换成 prefetch 落点那页＝「跑掉」）；
    // 空白键有 bytes 故走完整 sync→切原生→代送，使用者只想翻页却被丢去原生。
    // pttbbs read.c:877 明载 ' ' ＝ KEY_PGDN，属本地导航白名单。
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
      // ① CapsLock / F2：完全无作用（不切原生、不送 byte、不动选取）。
      for (const k of ['CapsLock', 'F2']) {
        await page.keyboard.press(k);
        await page.waitForTimeout(200);
      }
      const dead = await dumpListState(page);
      expect(dead.state).toBe('active');
      expect(dead.renderMode).toBe('buffer'); // 画面仍是好读视窗，不是 server 镜像
      expect(dead.sentCount).toBe(before.sentCount);
      expect(dead.selectedNum).toBe(before.selectedNum);
      expect(dead.cursorHidden).toBe(true); // 实体游标没露出＝没走 _enterFunctionMode

      // ② 空白键＝本地翻页（read.c:877 ' ' ＝ KEY_PGDN）。先 PgUp 离开底端，
      // 空白键要能把选取推回下方；逐格等价由 unit（list_keys.test.js）锁死，
      // 这里锁的是「真浏览器里它是本地导航，不是切原生」。
      await page.keyboard.press('PageUp');
      const up = await waitState(
        page,
        (x) => x.queueIdle && x.selectedNum < before.selectedNum
      );
      const sel = (x) => JSON.stringify([x.selectedNum, x.selectedPinnedKey]);
      await page.keyboard.press('Space');
      await page.waitForTimeout(300);
      const down = await dumpListState(page);
      expect(sel(down)).not.toBe(sel(up)); // 确实翻了（选取往下走）
      expect(down.state).toBe('active');
      expect(down.renderMode).toBe('buffer'); // 仍是好读视窗
      expect(down.cursorHidden).toBe(true);
      // 不得把空白键裸送给 server（那是 passthrough 代送的症状）。
      const sentAll = await page.evaluate(() => window.__replay.sent.slice());
      expect(sentAll).not.toContain(' ');
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  test('贴上原生指令一次生效：Shift+Insert 不被吞、paste 走 native-paste 只送一次', async ({ page }) => {
    // 回归（2026-08「AID 文章码要贴两次」）：Shift+Insert 曾落 passthrough →
    // preventDefault 取消浏览器贴上 → #t 收不到 paste 事件，PTT 只收到 \x1b[2~。
    // 这里锁两件事：① 该按键本身不送任何 byte、不切原生；② 真正的 paste 事件
    // 经 App.onPasteDone → ListSession.onPaste，整串一次送出并切原生镜像。
    test.setTimeout(60000);
    const logs = ptt.attachConsole(page);
    const AID = '#1gTTD8RU';
    try {
      await bootOffline(page, ptt);
      await replayListCassette(page, nav);
      await page.waitForFunction(() => window.__app.buf.pageState === 2);
      await ptt.applyPrefs(page, {
        enableEasyReadingList: true,
        easyReadingListPrefetchCount: 0
      });
      const before = await waitState(page, (x) => x.state === 'active' && x.queueIdle);

      // ① Shift+Insert 本身：不送 byte、不转态（旧码会送 \x1b[2~ 并切原生）。
      await page.locator('#t').focus();
      await page.keyboard.press('Shift+Insert');
      await page.waitForTimeout(300);
      const afterKey = await dumpListState(page);
      expect(afterKey.sentCount).toBe(before.sentCount);
      expect(afterKey.state).toBe('active');
      expect(afterKey.renderMode).toBe('buffer');

      // ② 真 paste 事件（浏览器在贴上成功时会发的那个）。seed 落点 server 游标
      // ＝选取 → 免 sync 腿，整串直接进 native-paste。
      await page.evaluate((text) => {
        const dt = new DataTransfer();
        dt.setData('text', text);
        document.getElementById('t').dispatchEvent(
          new ClipboardEvent('paste', {
            clipboardData: dt,
            bubbles: true,
            cancelable: true
          })
        );
      }, AID);

      const after = await waitState(
        page,
        (x) => x.state === 'functionMode' && x.renderMode === 'native',
        10000
      );
      // 恰好一次送出、内容完整（不得拆成逐字或漏字）。
      expect(after.sentCount).toBe(before.sentCount + 1);
      const sent = await page.evaluate(() => window.__replay.sent.slice(-1)[0]);
      expect(sent).toBe(AID);
      // 没有多余的 Insert 跳脱序列混进去。
      const all = await page.evaluate(() => window.__replay.sent.join(''));
      expect(all).not.toContain('\x1b[2~');
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

  test('滾輪平滑捲動：捲的距離就是滾輪的距離、畫面停得住半列；關掉設定回到一次一頁', async ({ page }) => {
    test.setTimeout(60000);
    const logs = ptt.attachConsole(page);
    try {
      await bootOffline(page, ptt);
      await replayListCassette(page, nav);
      await page.waitForFunction(() => window.__app.buf.pageState === 2);
      await ptt.applyPrefs(page, {
        enableEasyReadingList: true,
        easyReadingListPrefetchCount: 200
      });
      // fill 往舊文方向長 ⇒ 視窗上方會累積夠多列可捲。
      await waitState(
        page,
        (x) => x.state === 'active' && x.listLen > 40 && x.queueIdle,
        20000
      );

      // 未縮放的列高（次列位移與 scrollTop 用的座標系）。滾輪給的是**螢幕**像素，
      // 而視窗較矮時整個終端機被 scaleY 縮放過 ⇒ 換算成內容像素才是這裡的單位
      // （產品端同樣除以 scaleY，見 App.mouse_scroll）。
      const { lineH, scaleY } = await page.evaluate(() => ({
        lineH: window.__app.view.chh,
        scaleY: window.__app.view.scaleY || 1
      }));
      expect(lineH).toBeGreaterThan(0);
      const topPos0 = await windowTopPos(page);
      expect(topPos0).toBeGreaterThan(3); // 上方要有捲得動的空間

      // 滾輪事件直接派給 window（handler 掛在 window 的 capture 階段，與指標位置
      // 無關）。刻意不用 page.mouse.wheel：那會讓這支 spec 同時「量座標＋動指標」，
      // 撞上 tests/unit/e2e_layout_settle.test.js 的版面穩定契約，而這裡的捲動根本
      // 不依賴任何量出來的座標。同 wheel_stuck_button.offline.spec.js 的作法。
      const wheel = (deltaY) =>
        page.evaluate((dy) => {
          window.dispatchEvent(
            new WheelEvent('wheel', { deltaY: dy, deltaMode: 0, cancelable: true })
          );
        }, deltaY);
      // 動畫跑完（緩動器把距離吃光）為止。
      const settleScroll = async () => {
        await page.waitForFunction(() => {
          const ls = window.__app.listSession;
          return !ls._scroller || ls._scroller.pending() === 0;
        }, null, { timeout: 5000 });
        await page.waitForTimeout(80);
      };

      // 先離開底端：進板落點通常就貼在板尾，那裡「最後一列貼齊視口底部」的規則會
      // 把次列偏移吸成 0（一次性的對齊，不是捲動距離不準），量測要避開它。
      await wheel(-lineH * 5);
      await settleScroll();
      const pos0 = await page.evaluate(() => {
        const ls = window.__app.listSession;
        const nums = window.__app.buf.listLineNums || [];
        const abs = nums.indexOf(ls._topNum);
        return {
          top: abs === -1 ? -1 : ls._sequence().indexOf(abs),
          frac: ls.scrollFrac()
        };
      });
      expect(pos0.top).toBeGreaterThan(3); // 上方還要有捲得動的空間

      // 刻意選一個「不是列高整數倍」的距離：捲完必定停在半列上。
      const dist = lineH * 2 + 7;
      await wheel(-dist);
      await settleScroll();

      const after = await page.evaluate(() => ({
        frac: window.__app.listSession.scrollFrac(),
        viewTop: (() => {
          const v = document.querySelector('#mainContainer .listBodyView');
          return v ? v.scrollTop : null;
        })(),
        rows: document.querySelectorAll('#mainContainer [data-type="bbsline"]').length
      }));
      const topPos1 = await windowTopPos(page);

      // 1) 捲掉的距離＝滾輪給的距離（像素級，不是「取整到列」）。
      //    位置一律用像素座標：topPos * 列高 + 次列偏移；螢幕像素 ÷ scaleY。
      const px0 = pos0.top * lineH + pos0.frac;
      const px1 = topPos1 * lineH + after.frac;
      expect(px0 - px1).toBeCloseTo(dist / scaleY, 0);
      // 2) 真的停在半列上（這就是「像網頁」與「一階一階跳」的差別）。
      expect(after.frac).toBeGreaterThan(0);
      expect(after.frac).toBeLessThan(lineH);
      // 3) 畫面上確實位移了：body 視口的 scrollTop 就是次列偏移。
      expect(after.viewTop).toBeCloseTo(after.frac, 0);
      // 4) 露出的那一小條由 overscan 列補滿（24 → 25 列）。
      expect(after.rows).toBe(25);

      // 逃生門：關掉設定立刻回到一次一頁（不必重整）。
      await ptt.applyPrefs(page, { mouseWheelSmoothScroll: false });
      const topPos2 = await windowTopPos(page);
      await wheel(-100);
      await page.waitForTimeout(150);
      const topPos3 = await windowTopPos(page);
      expect(topPos2 - topPos3).toBe(Math.min(20, topPos2));
      // 翻頁會回到整列對齊（不留半列）。
      expect(await page.evaluate(() => window.__app.listSession.scrollFrac())).toBe(0);
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
          // 开文列匹配：半形游标 '>' 不盖数字（">353292"），序号照样完整。
          const numStr = String(openNum);
          if (x.indexOf(numStr) !== -1) {
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

  // 游標底色的另一半：原生模式的鍵盤操作（不開任何好讀）也要上色，且上的是
  // server 的真游標列 buf.cur_y。舊版底色只綁滑鼠 hover，鍵盤使用者完全沒有。
  test('原生列表：鍵盤游標底色上在真游標列，顏色照 pref（不需開滑鼠瀏覽）', async ({ page }) => {
    test.setTimeout(60000);
    const logs = ptt.attachConsole(page);
    try {
      await bootOffline(page, ptt);
      await replayListCassette(page, nav);
      await page.waitForFunction(() => window.__app.buf.pageState === 2);
      await ptt.applyPrefs(page, {
        enableEasyReadingList: false,
        useMouseBrowsing: false, // 純鍵盤：標示不該再依賴滑鼠瀏覽
        keyboardCursorHighlight: true,
        // 樣式層：這條驗的是「哪一列 + 什麼顏色」⇒ 要明確開底色樣式
        // （預設樣式已改成無底色的 cursorRowBrighten，見 pref_storage.js）。
        cursorRowBackground: true,
        mouseBrowsingHighlightColor: 9
      });
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => {
        const rows = Array.from(
          document.querySelectorAll('#mainContainer [data-type="bbsline"]')
        );
        return {
          curY: window.__app.buf.cur_y,
          painted: rows
            .map((el, i) => (el.classList.contains('b9') ? i : -1))
            .filter((i) => i !== -1)
        };
      });
      expect(r.painted).toEqual([r.curY]);

      // 關掉鍵盤底色 → 立即消失（不必等下一次畫面更新）。
      await ptt.applyPrefs(page, { keyboardCursorHighlight: false });
      await page.waitForTimeout(200);
      const after = await page.evaluate(
        () =>
          document.querySelectorAll('#mainContainer [data-type="bbsline"].b9')
            .length
      );
      expect(after).toBe(0);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  // 滑鼠瀏覽在列表好讀模式曾經半殘：hover 有光棒、點下去完全沒反應
  //（App.mouse_click 對 buffer/frozen 直接 preventDefault + return）。這條鎖住
  // 「單擊＝移到那一列並開文」的閉環，以及游標底色會真的照 pref 的顏色上色。
  test('滑鼠單擊列表某一列 → 選取移過去並開文；游標底色用 pref 指定的顏色', async ({ page }) => {
    test.setTimeout(90000);
    const logs = ptt.attachConsole(page);
    try {
      await bootOffline(page, ptt);
      await replayListCassette(page, nav);
      await page.waitForFunction(() => window.__app.buf.pageState === 2);
      await ptt.applyPrefs(page, {
        enableEasyReadingList: true,
        easyReadingListPrefetchCount: 30,
        useMouseBrowsing: true,
        mouseBrowsingHighlight: true,
        keyboardCursorHighlight: true,
        // 樣式層：底色預設已關（預設是無底色的 cursorRowBrighten），這條驗的是
        // 顏色 pref 有沒有生效 ⇒ 明確開起來。
        cursorRowBackground: true,
        // 刻意不是預設綠 b2：顏色 pref 曾是死設定（畫面永遠 #008000）。
        mouseBrowsingHighlightColor: 6
      });
      let s = await waitState(page, (x) => x.state === 'active' && x.listLen > 30 && x.queueIdle, 20000);

      // 鍵盤游標底色：'>' 那一列（且只有那一列）帶著 pref 指定的 b6。
      // 防誤觸模式（預設開）下底色只蓋標題欄 ⇒ class 掛在列內的包裝 span 上，
      // 不在 block 級的 bbsline 上（掛上去就是滿版）。
      const litRows = () =>
        page.evaluate(() =>
          Array.from(
            document.querySelectorAll('#mainContainer [data-type="bbsline"]')
          )
            .map((el, i) =>
              // bN 同時也是 ANSI 背景色的 class（狀態列就有 b6）⇒ 光棒要靠
              // .cursorHighlight 這個標記認，不能只看顏色。
              el.classList.contains('b6') || el.querySelector('.cursorHighlight.b6')
                ? i
                : -1
            )
            .filter((i) => i !== -1)
        );
      expect(await litRows()).toEqual([await cursorRowIndex(page)]);

      // 底色左緣＝可點區左緣（標題欄 col 30）：使用者 2026-08 定案「點擊區域＝
      // 底色區域」，那條光棒本身就是「這裡點得下去」的提示。
      const tintLeft = await page.evaluate(() => {
        const el = document.querySelector(
          '#mainContainer [data-type="bbsline"] .cursorHighlight.b6'
        );
        const v = window.__app.view;
        return {
          x: el.getBoundingClientRect().left,
          want: parseFloat(v.firstGridOffset.left) + v.chw * 30,
        };
      });
      expect(Math.abs(tintLeft.x - tintLeft.want)).toBeLessThan(2);

      // 關掉防誤觸 ⇒ 整列可點、整列上底色（class 回到 bbsline 本身）。
      await ptt.applyPrefs(page, { mouseMisclickGuard: false });
      await page.waitForTimeout(200);
      const wholeRow = await page.evaluate(() =>
        Array.from(
          document.querySelectorAll('#mainContainer [data-type="bbsline"]')
        )
          .map((el, i) => (el.classList.contains('b6') ? i : -1))
          .filter((i) => i !== -1)
      );
      expect(wholeRow).toEqual([await cursorRowIndex(page)]);
      await ptt.applyPrefs(page, { mouseMisclickGuard: true });
      await page.waitForTimeout(200);
      expect(await litRows()).toEqual([await cursorRowIndex(page)]);

      // 開文目標＝錄製的第三個 jump（cassette 只對這個序號有開文素材）。先把視窗
      // 帶到它附近（純視窗定位，不是本案要測的東西），再用 ↓ 把選取移開兩列 ——
      // 這樣「點擊把選取移過去」與「點擊開文」兩件事才會同時被驗到。
      const jumps = nav.steps.filter((st) => st.num != null);
      const openNum = jumps[2].num;
      // openNum 是緩衝最舊的一篇：先 PgUp 讓 demand 把它讀進來（同上一條測試）。
      await page.locator('#t').focus();
      await page.keyboard.press('PageUp');
      s = await waitState(page, (x) => x.queueIdle && x.listLen > 50, 15000);
      await page.evaluate((n) => {
        const ls = window.__app.listSession;
        ls._selectedNum = n;
        ls._selectedPinnedKey = null;
        ls._forceRedraw();
      }, openNum);
      await page.waitForTimeout(200);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(300);
      const beforeClick = await dumpListState(page);
      expect(beforeClick.selectedNum).not.toBe(openNum);

      const rows = await dumpScreenRows(page);
      const targetRow = rows.findIndex(
        (t, i) => i >= 3 && i <= 22 && t.trim().startsWith(String(openNum))
      );
      expect(targetRow).toBeGreaterThanOrEqual(3);

      // 真的用滑鼠點那一列（clientToPos → body index → 絕對索引 → 開文交易）。
      // x 必須落在**標題欄**（col >= 30，見 comment_parse.LIST_TITLE_COL_START）：
      // 2026-08 的滑鼠重新設計把可點區收斂到標題欄，點日期或作者欄不再開文。
      // 由 view.chw 算，字級改了也不會失準。
      const titleX = await page.evaluate(() => window.__app.view.chw * 32);
      await page
        .locator('#mainContainer [data-type="bbsline"]')
        .nth(targetRow)
        .click({ position: { x: titleX, y: 4 } });

      // 選取移到被點的那篇，並走完既有的兩段序列化開文交易。
      s = await waitState(page, (x) => x.state === 'suspended', 20000);
      expect(s.selectedNum).toBe(openNum);
      expect(s.pageState).toBe(3); // 真的進到文章
      // 全程零 raw byte 直送：開文只經 CommandQueue 的 jump + Enter。
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

// 2026-07-10：'/' 与 'v' 的模拟交易退役——非白名单键一键切原生（passthrough：
// 可选 sync 腿 → enter-function-mode → 代送原键），prompt 由原生镜像显示，
// 回 clean-list settle 自动恢复好读（resume+rebuild，不变量 15）。
test.describe('passthrough 一键切原生（离线，search/mark 卷）', () => {
  const search = loadCassette('cchat-list-search');
  const mark = loadCassette('cchat-list-mark');

  test('/ 一键切原生：原生 prompt 打字提交→黏性停原生（MODE_SELECT）→← 退回主列表仍原生', async ({ page }) => {
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

      // '/' → passthrough（seed 落点 server 游标=选取 → 免 sync 腿）→ 切原生
      // 代送 '/'（slash step 喂 prompt 画面，原生镜像直接显示）。
      await page.locator('#t').focus();
      await page.keyboard.press('/');
      s = await waitState(
        page,
        (x) => x.state === 'functionMode' && x.renderMode === 'native',
        10000
      );
      // 原生 prompt 画面已喂入 → 逐键打字（query 门控在 helper 侧累积到 \r）。
      const q = (search.steps.find((st) => st.on === 'query') || {}).query || 'Re';
      await page.waitForTimeout(300);
      await page.keyboard.type(q, { delay: 30 });
      await page.keyboard.press('Enter');

      // 提交完成 → MODE_SELECT 清单以原生镜像显示；黏性 hold（2026-07-10 UX）：
      // clean-list settle 不弹回 buffer——停在原生直到 article/menu 情境切换。
      // 注意 dump 的 nums 是「buffer」序号（hold 期间不更新），画面序号需自行
      // 从 DOM 列解析。
      const screenNums = async () => {
        const rows = await dumpScreenRows(page);
        return rows
          .map((t) => {
            const m = t.match(/^[>●\s]*(\d+)\s/);
            return m ? parseInt(m[1], 10) : null;
          })
          .filter((n) => n != null);
      };
      await page.waitForFunction(
        () => window.__app.listSession.state === 'functionMode'
      );
      // MODE_SELECT 画面到齐（row0 先画、body 后画的串流时序 → poll 到
      // 「画面序号整页落入独立小序号空间」为止，一次取样必踩 race）。
      await expect
        .poll(async () => {
          const ns = await screenNums();
          return ns.length > 0 && Math.max(...ns) < Math.min(...mainNums);
        }, { timeout: 15000 })
        .toBe(true);
      s = await dumpListState(page);
      expect(s.renderMode).toBe('native');
      expect(s.state).toBe('functionMode'); // 黏性：不弹回好读

      // ← 原生退出 select → back step 喂主列表 → 仍停原生（黏性）。
      await page.keyboard.press('ArrowLeft');
      await expect
        .poll(async () => {
          const ns = await screenNums();
          return ns.some((n) => n >= Math.min(...mainNums));
        }, { timeout: 15000 })
        .toBe(true);
      s = await dumpListState(page);
      expect(s.state).toBe('functionMode');
      expect(s.renderMode).toBe('native');
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  test('v 一键切原生：sync 腿→代送 v→原生 prompt→Enter 取消→黏性停原生', async ({ page }) => {
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

      // 选取设为卷内 jump 目标：passthrough 的 native-sync-jump 序号必须与录制
      // jump step 一致，门控才会喂。
      const markJumpNum = (mark.steps.find((st) => st.on === 'jump') || {}).num;
      expect(markJumpNum).toBeTruthy();
      await page.evaluate((n) => {
        const ls = window.__app.listSession;
        ls._selectedNum = n;
        ls._selectedPinnedKey = null;
        ls._forceRedraw();
      }, markJumpNum);

      // 'v' → native-sync-jump（jump step）→ 切原生＋代送 v（mark step 喂 prompt
      // 画面）→ 原生镜像显示 getdata prompt。
      await page.locator('#t').focus();
      await page.keyboard.press('v');
      s = await waitState(
        page,
        (x) => x.state === 'functionMode' && x.renderMode === 'native',
        10000
      );
      // 原生镜像＝server 的 prompt 画面（不再是 frozen 快照）。
      const rows = await dumpScreenRows(page);
      expect(rows.some((t) => t.includes('(U)未讀') || t.includes('未讀'))).toBe(true);

      // Enter 取消（cancel step 喂 FULLUPDATE）→ 黏性 hold：停在原生镜像，
      // 不自动弹回好读（2026-07-10 UX——反复 [ ] 的闪动/误触 banner 修正）。
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500); // 给 settle 机会（若误弹回这里会转 active）
      s = await dumpListState(page);
      expect(s.state).toBe('functionMode');
      expect(s.renderMode).toBe('native');
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });
});
