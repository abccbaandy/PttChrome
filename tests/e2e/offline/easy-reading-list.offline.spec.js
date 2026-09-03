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
// 滾輪 smoke 會量 rect 又會動指標 ⇒ 版面穩定契約要求走這個模組
// （tests/unit/e2e_layout_settle.test.js 靜態守護）。
const { waitRectStable, waitScrollStable } = require('../helpers/layout');

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
      chh: app.view.chh,
      domRows: document.querySelectorAll('#mainContainer [data-type="bbsline"]')
        .length,
      seqLen: ls._sequence().length,
      // 捲動視口：畫面高度必須恆等於 body 那 20 列（＝畫面仍是 24 列），
      // 內容比它高的部分就是可捲距離。
      viewportPx: (() => {
        const v = document.querySelector('#mainContainer .listBodyView');
        return v ? v.clientHeight : -1;
      })(),
      scrollTop: (() => {
        const v = document.querySelector('#mainContainer .listBodyView');
        return v ? v.scrollTop : -1;
      })(),
      overflowY: (() => {
        const v = document.querySelector('#mainContainer .listBodyView');
        return v ? getComputedStyle(v).overflowY : null;
      })()
    };
  });
}

// 畫面是不是「看起來仍是 24 列」。全序列渲染後 DOM 的列數 = 3 header + 序列
// （不足 bodyRows 補到 bodyRows）+ 1 footer，而**視口高度**才是使用者看到的
// 那 20 列 —— 這才是原本 `domRows === 24` 想守的東西。
function expectListViewport(s) {
  expect(s.domRows).toBe(4 + Math.max(s.seqLen, 20));
  expect(s.viewportPx).toBe(20 * s.chh); // bodyRows × 列高
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

// 視口頂端在「過濾後序列」裡的位置（0 = 已在 buffer 最上方）。**直接量 DOM 的
// scrollTop**，不靠 session 狀態反查 —— 捲動的真相源就是那個 scrollTop。
async function windowTopPos(page) {
  return await page.evaluate(() => {
    const v = document.querySelector('#mainContainer .listBodyView');
    if (!v) return -1;
    return Math.round(v.scrollTop / window.__app.view.chh);
  });
}

// 游標那一列相對**視口**的位置（0 = 視口第一列）；null = 游標捲出視野了。
// 全序列渲染後 cursorRowIndex 是絕對列號（3 + 序列位置），不再等於視口位置。
async function cursorRowInViewport(page) {
  return await page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll('#mainContainer [data-type="bbsline"]')
    );
    const i = rows.findIndex((el) => el.textContent.startsWith('>'));
    if (i < 0) return null;
    const v = document.querySelector('#mainContainer .listBodyView');
    if (!v) return null;
    const chh = window.__app.view.chh;
    const pos = i - 3 - Math.round(v.scrollTop / chh);
    return pos >= 0 && pos < 20 ? pos : null;
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
      // 畫面仍是 24 列：整段序列都在 DOM 裡，但視口高度恆等於 body 那 20 列。
      expectListViewport(s);
      expect(s.overflowY).toBe('auto'); // 捲動交給瀏覽器
      // 游标 = 恰好一列行首 '>'（body 区内）。行首比对：'>' 可能出现在标题里。
      const rows = await dumpScreenRows(page);
      const cursorRows = rows
        .map((t, i) => (t.startsWith('>') ? i : -1))
        .filter((i) => i !== -1);
      expect(cursorRows.length).toBe(1);
      expect(cursorRows[0]).toBeGreaterThanOrEqual(3);
      // 剛 engage 時游標看得見 ⇒ 相對視口落在 body 的 20 列內。（絕對列號現在是
      // 序列位置＋3，可以遠大於 22——游標本來就允許被捲出視野。）
      expect(await cursorRowInViewport(page)).not.toBeNull();
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
      expectListViewport(s);

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
      // 2026-09-03 起尾附 \f（Ctrl-L）：PTT 完全忽略某个键时是零 byte 零 settle，
      // 没有它命令只能等满 3s timeout —— 使用者要盯著原生画面发呆，
      //「操作完成后自动回好读」也无从触发。协定 §6：\f 全域被 igetch 拦截。
      expect(after.sentCount).toBe(before.sentCount + 1);
      const sent = await page.evaluate(() => window.__replay.sent.slice(-1)[0]);
      expect(sent).toBe('z\f');
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
      expect(sent).toBe(AID + '\f'); // 同 native-key：尾附 \f 保证必有一帧
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

  // 捲動語意：用 scrollTo 直接驅動視口（決定性、不動指標、不量座標）。
  // 這裡驗的是「捲動之後 app 做了什麼」——錨跟上、游標不動、demand 觸發、不重繪。
  test('原生捲動：視口捲動更新錨與 demand，游標不被拉走，且不重繪', async ({ page }) => {
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
      const before = await waitState(
        page,
        (x) => x.state === 'active' && x.listLen > 40 && x.queueIdle,
        20000
      );

      // body 視口是真的可捲容器：內容比視口高，overflow-y 交給瀏覽器。
      expect(before.overflowY).toBe('auto');
      const geom = await page.evaluate(() => {
        const v = document.querySelector('#mainContainer .listBodyView');
        return {
          chh: window.__app.view.chh,
          clientHeight: v.clientHeight,
          scrollHeight: v.scrollHeight
        };
      });
      expect(geom.clientHeight).toBe(20 * geom.chh); // 畫面仍是 20 列 body
      expect(geom.scrollHeight).toBeGreaterThan(geom.clientHeight); // 有可捲距離

      const topPos0 = await windowTopPos(page);
      expect(topPos0).toBeGreaterThan(3); // 上方要有捲得動的空間

      // 捲到一個**不是列高整數倍**的位置：畫面停得住半列（原生捲動的自然結果）。
      const target = (topPos0 - 3) * geom.chh + 7;
      await page.evaluate((top) => {
        document.querySelector('#mainContainer .listBodyView').scrollTop = top;
      }, target);
      await page.waitForFunction(
        (t) =>
          Math.abs(
            document.querySelector('#mainContainer .listBodyView').scrollTop - t
          ) < 1,
        target
      );
      // scroll handler 是 rAF 合併的，等錨真的跟上。
      await page.waitForFunction(
        (t) => window.__app.listSession._lastScrollTop === t,
        target,
        { timeout: 5000 }
      );

      const after = await dumpListState(page);
      // 1) 錨跟著畫面走（視口頂那一列 + 列內偏移）。
      expect(await windowTopPos(page)).toBe(topPos0 - 3);
      expect(
        await page.evaluate(() => window.__app.listSession._scrollFrac)
      ).toBeCloseTo(7, 0);
      // 2) 游標**不被拉走**（網頁式語意：它可以被捲出視野）。
      expect(after.selectedNum).toBe(before.selectedNum);
      // 3) 捲動不改變 DOM 列數（沒有重繪、沒有視窗切片）。
      expect(after.domRows).toBe(before.domRows);

      // 4) 往下捲到接近 buffer 底 ⇒ 觸發方向性 demand（背景補頁）。
      const fedBefore = await page.evaluate(() => window.__replay.fed);
      await page.evaluate(() => {
        const v = document.querySelector('#mainContainer .listBodyView');
        v.scrollTop = v.scrollHeight;
      });
      await page.waitForTimeout(300);
      const grown = await waitState(page, (x) => x.queueIdle, 15000);
      expect(grown.state).toBe('active'); // 捲動零 byte、不轉態
      expect(await page.evaluate(() => window.__replay.fed)).toBeGreaterThanOrEqual(
        fedBefore
      );
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  // 滾輪 smoke：**真的**用滑鼠滾輪，驗 default action 有作用在視口上。
  // 這條非用 page.mouse.wheel 不可——合成的 WheelEvent 是 untrusted，沒有
  // default action，改成原生捲動後量到的位移恆為 0（假綠）。
  test('滾輪 smoke：真滾輪驅動瀏覽器原生捲動', async ({ page }) => {
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
      await waitState(
        page,
        (x) => x.state === 'active' && x.listLen > 40 && x.queueIdle,
        20000
      );

      // 先離開頂端，才有往上捲的空間可量。
      await page.evaluate(() => {
        const v = document.querySelector('#mainContainer .listBodyView');
        v.scrollTop = Math.round(v.scrollHeight / 2);
      });
      const box = await waitRectStable(page, '#mainContainer .listBodyView');
      const before = await page.evaluate(
        () => document.querySelector('#mainContainer .listBodyView').scrollTop
      );

      await page.mouse.move(box.left + box.width / 2, box.top + box.height / 2);
      await page.mouse.wheel(0, -300);
      await page.waitForFunction(
        (b) =>
          document.querySelector('#mainContainer .listBodyView').scrollTop < b,
        before,
        { timeout: 5000 }
      );
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  // 按住 PgUp/PgDn 的回歸（2026-08-30 回報：按著畫面一直慢慢爬，放開之後才快速補捲
  // 1~2 頁）。根因：programmatic scrollTo({behavior:'smooth'}) **不保留速度** —— OS
  // 的自動重複（約 30/s）比動畫快，每次呼叫都取消上一個動畫、從 ease 曲線的起點重跑，
  // 而目標卻一次往前一整頁 ⇒ 按著的時候永遠追不上，剩下的距離在放開之後才補完。
  // 修法：連發一律 instant（list_scroll.revealPlan 的 repeat）。
  //
  // 這條非 e2e 不可：unit 的 scrollListTo mock 量不到「瀏覽器的動畫繼續把畫面帶走」。
  // 用 CDP 的 autoRepeat 送鍵 ⇒ 拿到的是**真的 trusted keydown 且 event.repeat===true**，
  // 不必靠「連按夠快」這種會 flaky 的時序假設。
  test('按住 PgUp（自動重複）：位移立刻跟上按鍵，放開後畫面不再自己捲', async ({ page }) => {
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
      await waitState(
        page,
        (x) => x.state === 'active' && x.listLen > 50 && x.queueIdle,
        20000
      );

      const BODY_ROWS = 20;
      const pos0 = await windowTopPos(page);
      // 第一發至少要能整整往上翻一頁而不被 clamp，斷言才量得到「有沒有跟上按鍵」。
      expect(pos0).toBeGreaterThanOrEqual(BODY_ROWS + 5);

      // 終點用那一列的**內容身分**（序號）而不是 px：按住 PgUp 會觸發背景補頁，而
      // prepend 會讓整段序列往下位移（不變量 6 的補償），px 不是穩定的座標。
      const numAtPos = (pos) =>
        page.evaluate((p) => {
          const seq = window.__app.listSession._sequence();
          return window.__app.buf.listLineNums[seq[p]];
        }, pos);
      const afterFirst = await numAtPos(pos0 - BODY_ROWS);
      const afterSecond = await numAtPos(Math.max(0, pos0 - 2 * BODY_ROWS));
      expect(afterFirst).toBeGreaterThan(0);

      const cdp = await page.context().newCDPSession(page);
      const pgup = (extra) =>
        cdp.send(
          'Input.dispatchKeyEvent',
          Object.assign(
            {
              key: 'PageUp',
              code: 'PageUp',
              windowsVirtualKeyCode: 33,
              nativeVirtualKeyCode: 33
            },
            extra
          )
        );
      const topNum = () => page.evaluate(() => window.__app.listSession._topNum);

      // **送完鍵當下就到位**：鍵盤那條路整段是同步的（_moveSelection → 重繪 →
      // applyScrollAfterRender 寫 scrollTop），所以這裡刻意一次都不等 —— 等下去舊行為
      // 也會慢慢捲到，就抓不到「按著跟不上」了。
      await pgup({ type: 'rawKeyDown', autoRepeat: true });
      expect(await topNum()).toBe(afterFirst);
      await pgup({ type: 'rawKeyDown', autoRepeat: true });
      expect(await topNum()).toBe(afterSecond);
      await pgup({ type: 'keyUp' });

      // 放開之後畫面不再自己捲：沒有殘留的平滑動畫可以再把視口帶走。
      await waitScrollStable(page, '#mainContainer .listBodyView');
      expect(await topNum()).toBe(afterSecond);
      expect(
        await page.evaluate(() => window.__app.listSession._scrollAnim)
      ).toBeNull();
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  // 逃生門與吞捲動：兩者都靠 CSS overflow，不靠 preventDefault
  //（window 上的 wheel listener 在 Chrome 是 passive ⇒ preventDefault 是 no-op）。
  test('pref 關掉＝一次一頁；交易進行中（frozen）畫面凍住', async ({ page }) => {
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
      await waitState(
        page,
        (x) => x.state === 'active' && x.listLen > 40 && x.queueIdle,
        20000
      );

      // --- 逃生門：關掉 pref → 視口不吃使用者輸入，滾輪退回一次一頁 ---
      await ptt.applyPrefs(page, { mouseWheelSmoothScroll: false });
      await page.waitForFunction(
        () =>
          getComputedStyle(
            document.querySelector('#mainContainer .listBodyView')
          ).overflowY === 'hidden'
      );
      const topPos2 = await windowTopPos(page);
      expect(topPos2).toBeGreaterThan(3);
      // pref 關掉時走 window handler（不需要 default action）⇒ 合成事件可用。
      await page.evaluate(() => {
        window.dispatchEvent(
          new WheelEvent('wheel', { deltaY: -100, deltaMode: 0, cancelable: true })
        );
      });
      // 翻頁也走平滑捲動 ⇒ 要等它**到站**再量，不能看到動一下就收工
      //（動畫中間值會讓這裡量到「只捲了一列」）。
      const wantTop = Math.max(0, topPos2 - 20);
      await page.waitForFunction(
        (t) => {
          const v = document.querySelector('#mainContainer .listBodyView');
          return Math.round(v.scrollTop / window.__app.view.chh) === t;
        },
        wantTop,
        { timeout: 5000 }
      );
      const topPos3 = await windowTopPos(page);
      expect(topPos2 - topPos3).toBe(Math.min(20, topPos2));

      // --- frozen：開文交易進行中，視口一樣不吃輸入、scrollTop 原地不動 ---
      await ptt.applyPrefs(page, { mouseWheelSmoothScroll: true });
      const frozenTop = await page.evaluate(() => {
        const app = window.__app;
        app.listSession._freezeForTransaction();
        app.buf.listRenderMode = 'frozen';
        app.view.redraw(true);
        return document.querySelector('#mainContainer .listBodyView').scrollTop;
      });
      await page.waitForFunction(
        () =>
          getComputedStyle(
            document.querySelector('#mainContainer .listBodyView')
          ).overflowY === 'hidden'
      );
      expect(
        await page.evaluate(
          () => document.querySelector('#mainContainer .listBodyView').scrollTop
        )
      ).toBe(frozenTop);
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
        const v = document.querySelector('#mainContainer .listBodyView');
        return {
          domRows: lines.length,
          hasAuthor: lines.some((t) => t.includes(a)),
          listLen: window.__app.buf.listLines.length,
          seqLen: window.__app.listSession._sequence().length,
          viewportPx: v ? v.clientHeight : -1,
          chh: window.__app.view.chh
        };
      }, author);
      expect(res.hasAuthor).toBe(false);
      // 隱藏列直接從序列消失（不留空隙），畫面高度不變。
      expect(res.domRows).toBe(4 + Math.max(res.seqLen, 20));
      expect(res.viewportPx).toBe(20 * res.chh);
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
      // 游标 = 视口第一列（PgUp 以視口頂為基準，游標落在新頁頂）。
      await page.waitForFunction(() => {
        const v = document.querySelector('#mainContainer .listBodyView');
        const rows = Array.from(
          document.querySelectorAll('#mainContainer [data-type="bbsline"]')
        );
        const i = rows.findIndex((el) => el.textContent.startsWith('>'));
        if (i < 0 || !v) return false;
        return i - 3 - Math.round(v.scrollTop / window.__app.view.chh) === 0;
      });
      const cursorNumBefore = (await dumpListState(page)).selectedNum;
      s = await waitState(page, (x) => x.queueIdle && x.listLen > 50, 15000);
      const fedAfter = await page.evaluate(() => window.__replay.fed);
      expect(fedAfter).toBeGreaterThan(fedBefore); // demand 确实走了锚定对
      // prepend 之后视口以内容锚定（不变量 6）—— 游标仍停在同一篇、也仍在视口顶，
      // 新页没有把画面往下挤。
      expect((await dumpListState(page)).selectedNum).toBe(cursorNumBefore);
      expect(await cursorRowInViewport(page)).toBe(0);

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

      // 视野必须停在 server 落点那一页：视口顶列＝锚（_topNum）那一列，刚读的
      // 那篇在视野内。**下面的逐行 diff 抓不到这件事**——全序列渲染后
      // dumpScreenRows 撈的是整段緩衝，對 scrollTop 完全不敏感。
      //
      // 注意这条**不是**「退文后视野跑掉」的重现（本卷录的开文目标恰好就是缓冲
      // 最旧一篇 ⇒ 落点页顶＝序列位置 0，锚被覆写成 0 也看不出差别）。那条回归
      // 由 unit 守：list_session.test.js「退文回列表：视野停在 server 落点那一页」
      // ＋ render_list_scroll.test.js 的 hasListViewport()。这里守的是「视口位置
      // 与锚一致、游标可见」，锚若被写去别处（例如沿用进文章前的 scrollTop）会红。
      const topPos = await page.evaluate(() => {
        const ls = window.__app.listSession;
        const nums = window.__app.buf.listLineNums || [];
        return ls._sequence().indexOf(nums.indexOf(ls._topNum));
      });
      expect(topPos).toBeGreaterThanOrEqual(0); // 锚没丢
      expect(await windowTopPos(page)).toBe(topPos);
      expect(await cursorRowInViewport(page)).not.toBeNull();

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
      // 全序列渲染後目標列可能在視口外（body 的 data-row 是絕對序列位置）。
      const targetRow = rows.findIndex(
        (t, i) => i >= 3 && t.trim().startsWith(String(openNum))
      );
      expect(targetRow).toBeGreaterThanOrEqual(3);
      // 先把它捲進視口再點：Playwright 的 auto-scroll 會在點擊當下才捲，
      // 那之後量到的位置與實際點下去的位置可能對不上。
      await page.evaluate((r) => {
        const v = document.querySelector('#mainContainer .listBodyView');
        v.scrollTop = (r - 3) * window.__app.view.chh;
      }, targetRow);
      await page.waitForFunction(
        (r) => {
          const v = document.querySelector('#mainContainer .listBodyView');
          return (
            Math.abs(v.scrollTop - (r - 3) * window.__app.view.chh) < 1
          );
        },
        targetRow
      );

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
// 可选 sync 腿 → enter-function-mode → 代送原键），prompt 由原生镜像显示。
// 2026-09-03（本檔兩條的語意反轉）：原生操作**做完之後**不再停在原生 —— 畫面
// 靜下來（RESUME_QUIET_MS=250ms 內沒有 server 活動也沒有使用者送 byte）就由靜置
// 探針自動切回好讀（resume+rebuild，不變量 15 照舊）。pref
// enableListNativeAutoResume 預設開；關掉才是舊的黏性行為。
test.describe('passthrough 一键切原生（离线，search/mark 卷）', () => {
  const search = loadCassette('cchat-list-search');
  const mark = loadCassette('cchat-list-mark');

  test('/ 一键切原生：原生 prompt 打字提交→MODE_SELECT 落地後自动回好读→← 退回主列表仍好读', async ({ page }) => {
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

      // 提交完成 → MODE_SELECT 清单落地。画面静下来之后靜置探針自动把我们切回
      // 好读（resume+rebuild：MODE_SELECT 是独立编号空间，协定 §8）。
      // 画面序号从 DOM 列解析（buffer 重建前后都对得上）。
      const screenNums = async () => {
        const rows = await dumpScreenRows(page);
        return rows
          .map((t) => {
            const m = t.match(/^[>●\s]*(\d+)\s/);
            return m ? parseInt(m[1], 10) : null;
          })
          .filter((n) => n != null);
      };
      // MODE_SELECT 画面到齐（row0 先画、body 后画的串流时序 → poll 到
      // 「画面序号整页落入独立小序号空间」为止，一次取样必踩 race）。
      await expect
        .poll(async () => {
          const ns = await screenNums();
          return ns.length > 0 && Math.max(...ns) < Math.min(...mainNums);
        }, { timeout: 15000 })
        .toBe(true);
      // 自动回好读（本次改动的主体）：不按任何键，state 自己回 active、
      // .listBodyView 重新出现。
      s = await waitState(
        page,
        (x) => x.state === 'active' && x.renderMode === 'buffer',
        15000
      );
      await expect(page.locator('.listBodyView')).toHaveCount(1);

      // ← 退回主列表：这时已经是好读，所以走的是序列化的离开交易（back step）。
      // 落地仍是好读（编号空间换了 ⇒ rebuild）。
      await page.keyboard.press('ArrowLeft');
      await expect
        .poll(async () => {
          const ns = await screenNums();
          return ns.some((n) => n >= Math.min(...mainNums));
        }, { timeout: 15000 })
        .toBe(true);
      s = await waitState(
        page,
        (x) => x.state === 'active' && x.renderMode === 'buffer',
        15000
      );
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  test('v 一键切原生：sync 腿→代送 v→原生 prompt→Enter 取消→自动回好读', async ({ page }) => {
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

      // Enter 取消（cancel step 喂 FULLUPDATE）→ 操作完成、画面静下来 ⇒ 靜置探針
      // 自动把我们切回好读。这就是本次改动要的行为：使用者除了非导览操作本身，
      // 大部分时间都看不到原生模式。
      await page.keyboard.press('Enter');
      s = await waitState(
        page,
        (x) => x.state === 'active' && x.renderMode === 'buffer',
        15000
      );
      await expect(page.locator('.listBodyView')).toHaveCount(1);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });
});

// ---------------------------------------------------------------------------
// 中文輸入法（IME）在列表好讀下的兩件事，都是使用者回報的「切到中文模式打字，
// 整個畫面就卡住」的組成部分：
//   1. 組字框 #t 必須看得見（它是 OS 候選字清單的錨；跑到視窗外＝使用者以為當機）。
//      #t 的幾何契約主場在 cursor_shape.offline.spec.js，但那裡的兩條刻意關掉
//      enableEasyReadingList；列表好讀的環境（cassette／pref／waitState）在本檔，
//      而且斷言不同（要的是「落在視窗內」而非「貼齊該格」），所以放這裡。
//   2. 組完字送出必須先切成原生鏡像，否則 PTT 畫的 prompt 被累積緩衝視窗蓋住。
// IME 的 keydown keyCode 是 229，被 keyEventFilter 擋在 onKeyDown 之外 ⇒ 走不到
// _classifyKey 的 passthrough，這兩件事都得靠 onTextInput 那條共用漏斗。
// 純邏輯守護：tests/unit/row_anchor.test.js、tests/unit/list_text_input.test.js。
// ---------------------------------------------------------------------------
test.describe('中文輸入法（離線）', () => {
  test.skip(!nav, '缺 cchat-list-nav cassette（yarn record:cassette 先錄一次）');

  // 真 IME 事件序：compositionstart（框出現）→ 填字 → compositionend（送出）。
  async function composeStart(page) {
    await page.evaluate(() => {
      const t = document.getElementById('t');
      t.focus();
      t.style.width = '40px'; // 避免右邊界 clamp 介入量測
      t.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
  }
  async function composeEnd(page, text) {
    await page.evaluate((s) => {
      const t = document.getElementById('t');
      t.value = s;
      t.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: s }));
    }, text);
  }

  // prefetch: 0 ＝只有 seed 那 20 列，body 剛好塞滿視口、捲不動。要驗「錨到捲出
  // 視野的列」就得先讓上方長出可捲距離（比照「原生捲動」那條：fill 往舊文方向長）。
  async function engaged(page, { fill = false } = {}) {
    await bootOffline(page, ptt);
    await replayListCassette(page, nav);
    await page.waitForFunction(() => window.__app.buf.pageState === 2);
    await ptt.applyPrefs(page, {
      enableEasyReadingList: true,
      easyReadingListPrefetchCount: fill ? 200 : 0,
    });
    return waitState(
      page,
      (x) => x.state === 'active' && x.queueIdle && (!fill || x.listLen > 40),
      20000
    );
  }

  test('組字框 #t 落在視窗內（不再錨到捲出視野的那一列）', async ({ page }) => {
    test.setTimeout(60000);
    const logs = ptt.attachConsole(page);
    try {
      await engaged(page, { fill: true });

      // 捲到序列深處：buf.cur_y 對應的 srow 是整段序列最前面幾列，捲下去之後
      // 就在視口上方外。捲動用 DOM 真相源（scrollTop），等它穩再量。
      await page.evaluate(() => {
        document.querySelector('#mainContainer .listBodyView').scrollTop = 9999;
      });
      await waitScrollStable(page, '#mainContainer .listBodyView');

      const pre = await page.evaluate(() => {
        const app = window.__app;
        const v = document.querySelector('#mainContainer .listBodyView');
        const el = document.querySelector(
          `#mainContainer [type="bbsrow"][srow="${app.buf.cur_y}"]`
        );
        return {
          cur_y: app.buf.cur_y,
          scrollTop: v ? v.scrollTop : -1,
          rowTop: el ? el.getBoundingClientRect().top : null,
        };
      });
      // 前提成立才有意義（否則這條會沉默地永真）：真的捲動了、buf.cur_y 落在
      // body（非 header 那 3 列）、而且那一列真的被捲出視野上方。
      expect(pre.scrollTop).toBeGreaterThan(0);
      expect(pre.cur_y).toBeGreaterThanOrEqual(3);
      expect(pre.rowTop).not.toBeNull();
      expect(pre.rowTop).toBeLessThan(0);

      await composeStart(page);
      const m = await page.evaluate(() => {
        const b = document.getElementById('t').getBoundingClientRect();
        return {
          bshow: document.getElementById('t').getAttribute('bshow'),
          top: b.top, bottom: b.bottom, left: b.left, right: b.right,
          w: window.innerWidth, h: window.innerHeight,
        };
      });
      expect(m.bshow).toBe('1');
      // 舊碼：top ≈ pre.rowTop（大負數）⇒ 框整個在視窗外，候選字清單跟著跑掉。
      expect(m.top).toBeGreaterThanOrEqual(0);
      expect(m.bottom).toBeLessThanOrEqual(m.h);
      expect(m.left).toBeGreaterThanOrEqual(0);
      expect(m.right).toBeLessThanOrEqual(m.w);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });

  test('組完字送出：切原生鏡像＋走 CommandQueue（Big5，恰送一次）', async ({ page }) => {
    test.setTimeout(60000);
    const logs = ptt.attachConsole(page);
    const TEXT = '測試';
    try {
      const before = await engaged(page);
      // seed 落點 server 游標＝選取 ⇒ 免 sync 腿（cassette 沒有那一腿的素材）。
      await page.evaluate(() => {
        const ls = window.__app.listSession;
        ls._serverNum = ls._selectedNum;
      });

      await composeStart(page);
      await composeEnd(page, TEXT);

      const after = await waitState(
        page,
        (x) => x.state === 'functionMode' && x.renderMode === 'native',
        10000
      );
      // 恰好一次送出（不得裸送 + 佇列各送一次）
      expect(after.sentCount).toBe(before.sentCount + 1);
      const sent = await page.evaluate(() => window.__replay.sent.slice(-1)[0]);
      // Big5：兩個全形字 = 4 bytes，每個 byte < 256（裸送 UTF-16 會是 2 個 >0xFF 的碼位）
      // 尾巴多一個 \f（同 native-key，保證必有一幀可判定）。
      expect(sent.slice(-1)).toBe('\f');
      const body = sent.slice(0, -1);
      expect(body.length).toBe(4);
      expect(Math.max(...[...body].map((c) => c.charCodeAt(0)))).toBeLessThan(256);
      expect(body).not.toBe(TEXT);
      // 原生鏡像：第二層捲動視口收掉，畫面回到固定 24 列
      expect(after.viewportPx).toBe(-1);
      expect(after.domRows).toBe(24);
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });
});
