// 好讀「反向讀取」（讀取中按 End）的真瀏覽器端到端：真的鍵盤、真的狀態機、真的渲染／
// 版面／scroll anchoring，只有 WebSocket 是 stub。
//
// 既有 cassette 是線性的 pfterm 差分，無法照「End → PgUp → goto」的亂序重放，所以這裡
// 的 server 是 pmore 分頁模擬器（tests/e2e/helpers/pmore_sim.js，規則出自 pmore.c，
// unit 的交易 harness 用的是同一份）：client 每送一個翻頁鍵，模擬器就回一幀完整重繪
// （清屏＋23 列＋狀態列＋游標 park 在 (24,80)，P6）。
//
// 守的是 unit 碰不到的那半段：
//   - End 之後畫面真的先跳到文末（不必等整篇讀完）
//   - 往上插入的過程中讀者的位置不被推走（瀏覽器內建 scroll anchoring 的實際效果）
//   - tail 不編樓層、接合點有標記；接合後樓層補齊、標記消失
//   - 最後的累積頁與「從頭讀完」逐列相同；同時只有一個鍵在線上（P4）
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline } = require('../helpers/replay');

const SIM_SRC = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'pmore_sim.js'), 'utf8');
const TOTAL = 1200;
// 模擬器每個回應的延遲。真實 PTT 一次翻頁往返是數十到上百 ms；太快的話整篇在按 End
// 之前就讀完了，測不到「讀取中」。
const LATENCY_MS = 80;
const FIRST_COMMENT = 120;

// 在頁面裡裝模擬器＋回應器。回應一律非同步（下一個 task），與真實 WS 相同。
async function installSim(page, simOpts) {
  await page.evaluate(
    ({ src, simOpts, firstComment, LATENCY_MS }) => {
      const module = { exports: {} };
      new Function('module', 'exports', src)(module, module.exports);
      const { createPmoreSim } = module.exports;
      // 前段是內文，FIRST_COMMENT 起是推文（作者輪替，不會被同作者合併）
      const authors = ['alice', 'bob', 'carol', 'dave'];
      const lineText = (n) =>
        n < firstComment
          ? `article line ${n}`
          : `推 ${authors[n % authors.length]}: comment ${n}`.padEnd(66) + '09/25 10:00';
      const rows = window.__app.buf.rows;
      const sim = createPmoreSim({ ...simOpts, rows, lineText });
      const u2b = (str) => {
        let out = '';
        for (const ch of str) {
          const c = ch.charCodeAt(0);
          if (c < 0x80) { out += ch; continue; }
          out += String.fromCharCode(window.lib.u2bArray[2 * c]) +
                 String.fromCharCode(window.lib.u2bArray[2 * c + 1]);
        }
        return out;
      };
      const encode = (f) => {
        let d = '\x1b[H\x1b[2J';
        f.texts.forEach((t, i) => { if (t) d += '\x1b[' + (i + 1) + ';1H' + u2b(t); });
        d += '\x1b[' + (f.cursor.y + 1) + ';' + (f.cursor.x + 1) + 'H';
        return d;
      };
      const KEYS = /^(\x1b\[[1456]~|:\d+\r)$/;
      const state = { wire: [], overlaps: 0, sent: [] };
      window.__rev = { sim, state, encode };
      const answerNext = () => {
        const k = state.wire[0];
        const resp = sim.press(k);
        state.wire.shift();
        if (resp) resp.frames.forEach((f) => window.__app.onData(encode(f)));
      };
      window.__stubWSSent = (s) => {
        if (!KEYS.test(s)) return;   // telnet 協商、NAWS…
        if (state.wire.length) ++state.overlaps;
        state.sent.push(s);
        state.wire.push(s);
        setTimeout(answerNext, LATENCY_MS);
      };
      // 開文：第一頁
      window.__app.onData(encode(sim.screen()));
    },
    { src: SIM_SRC, simOpts, firstComment: FIRST_COMMENT, LATENCY_MS }
  );
}

async function openArticle(page, simOpts) {
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, { enableEasyReadingList: false, showFloorNumbers: true });
  await installSim(page, simOpts);
  await page.waitForFunction(() => window.__app.buf.pageState === 3);
  // 好讀的自動開啟靠「列表→文章」的 settle 邊緣；這裡沒有列表，直接走唯一入口。
  await page.evaluate(() => window.__app.easyReading.enterEasyReading());
  await page.waitForFunction(() => window.__app.view.useEasyReadingMode && window.__app.buf.pageLines.length > 0);
}

const lastLine = `comment ${TOTAL}`;

test.describe('好讀反向讀取（End，離線）', () => {
  test('讀取中按 End：先看到文末，往上長完與從頭讀完逐列相同', async ({ page }) => {
    await openArticle(page, { total: TOTAL });
    // 還在讀前段（這時文末一定還沒進來）
    expect(
      await page.evaluate((t) => window.__app.buf.pageLines.some(
        (r) => r.map((c) => c.ch).join('').includes(t)), lastLine)
    ).toBe(false);
    await page.keyboard.press('End');
    // 不必等整篇讀完就看得到文末
    await page.waitForFunction(
      (t) => !!window.__app.view._reverse &&
        document.querySelector('#mainContainer').textContent.includes(t),
      lastLine, { timeout: 15000 }
    );
    // 等接合完成（反向狀態清掉、已到底）
    await page.waitForFunction(
      () => !window.__app.easyReading._reverse && window.__app.easyReading.easyReadingReachedPageEnd,
      null, { timeout: 60000 }
    );
    // 逐列比對只取 ASCII 部分：推文的「推」是 Big5 雙位元組 cell，解碼要轉碼表；
    // 列的順序與有無重複由 ASCII 部分（comment N／article line N）就完全決定。
    const res = await page.evaluate(() => {
      const { sim, state } = window.__rev;
      const ascii = (s) => s.replace(/[^\x20-\x7e]/g, '').replace(/\s+$/, '');
      return {
        overlaps: state.overlaps,
        pgUpAtTop: sim.stats.pgUpAtTop,
        pgUps: state.sent.filter((k) => k === '\x1b[5~').length,
        expected: sim.allRows().map(ascii),
        got: window.__app.buf.pageLines.map((r) =>
          ascii(r.filter((c) => c.ch.charCodeAt(0) < 0x80).map((c) => c.ch).join(''))),
      };
    });
    expect(res.got).toEqual(res.expected);
    expect(res.overlaps).toBe(0);
    expect(res.pgUpAtTop).toBe(0);
    expect(res.pgUps).toBeGreaterThan(5);
  });

  test('反向期間：tail 不編樓層、接合點有標記；接合後樓層補齊、標記消失', async ({ page }) => {
    await openArticle(page, { total: TOTAL });
    await page.keyboard.press('End');
    await page.waitForFunction(
      () => window.__app.view._reverse && window.__app.view._reverse.tailStartLine != null &&
        document.querySelector('.reverseJunction'),
      null, { timeout: 15000 }
    );
    // 同一個 task 內讀 J 與 DOM（回應是非同步的，分兩次讀會對不上）
    const mid = await page.evaluate(() => {
      const J = window.__app.view._reverse.junction;
      const floorsInTail = Array.from(document.querySelectorAll('#mainContainer .floorBadgeNum'))
        .map((n) => Number(n.closest('[type="bbsrow"]').getAttribute('srow')))
        .filter((r) => r >= J).length;
      const marks = Array.from(document.querySelectorAll('#mainContainer .reverseJunction'));
      const markRow = marks.length
        ? Number(marks[0].getAttribute('srow') ?? marks[0].querySelector('[srow]').getAttribute('srow'))
        : null;
      return { J, floorsInTail, marks: marks.length, markRow };
    });
    expect(mid.floorsInTail).toBe(0);
    expect(mid.marks).toBe(1);
    expect(mid.markRow).toBe(mid.J);

    await page.waitForFunction(
      () => !window.__app.easyReading._reverse && window.__app.easyReading.easyReadingReachedPageEnd,
      null, { timeout: 60000 }
    );
    const done = await page.evaluate(() => ({
      marks: document.querySelectorAll('#mainContainer .reverseJunction').length,
      floors: Array.from(document.querySelectorAll('#mainContainer .floorBadgeNum'))
        .map((n) => Number(n.textContent)),
    }));
    expect(done.marks).toBe(0);
    // 推文從第 FIRST_COMMENT 行起每行一則 ⇒ 樓層 1..N 連號（接合後全量重算）
    const n = TOTAL - FIRST_COMMENT + 1;
    expect(done.floors.length).toBe(n);
    expect(done.floors[0]).toBe(1);
    expect(done.floors[n - 1]).toBe(n);
  });

  // 回歸實錄（2026-09-25 開發時量到）：
  //   - _patchInto 把換掉的接合點列留在 cursor 上 ⇒ 每頁把整段 tail 搬家 ⇒ 錨點
  //     丟失 ⇒ scrollTop 釘在 1720，上方長出 5 萬 px，讀者被推到文章開頭附近；
  //   - 接合那一幀全量重建（樓層補上）⇒ 錨點隨舊節點消失 ⇒ 被推走 300px。
  // 斷言在**每一次取樣**都成立，不是只看最後一刻。
  test('往上插入的過程中，讀者停在文末的位置不被推走（scroll anchoring）', async ({ page }) => {
    await openArticle(page, { total: TOTAL });
    await page.keyboard.press('End');
    await page.waitForFunction(
      () => window.__app.view._reverse && window.__app.view._reverse.tailComplete,
      null, { timeout: 15000 }
    );
    // 此後每一頁都插在接合點（視窗上方）。每一幀之後量「距離底部多遠」。
    await page.evaluate(() => {
      window.__gaps = [];
      const m = document.querySelector('.main');
      window.__app.buf.addEventListener('viewUpdate', () => {
        window.__gaps.push(Math.round(m.scrollHeight - m.clientHeight - m.scrollTop));
      });
    });
    await page.waitForFunction(
      () => !window.__app.easyReading._reverse && window.__app.easyReading.easyReadingReachedPageEnd,
      null, { timeout: 60000 }
    );
    const r = await page.evaluate(() => ({ gaps: window.__gaps, chh: window.__app.view.chh }));
    expect(r.gaps.length).toBeGreaterThan(10);
    expect(Math.max(...r.gaps), JSON.stringify(r.gaps)).toBeLessThanOrEqual(r.chh);
  });

  test('反向期間停在 head 讀的人，接合時位置不動', async ({ page }) => {
    await openArticle(page, { total: TOTAL });
    await page.keyboard.press('End');
    await page.waitForFunction(
      () => window.__app.view._reverse && window.__app.view._reverse.tailComplete,
      null, { timeout: 15000 }
    );
    // 讀者捲回 head 的第 10 列
    const before = await page.evaluate(() => {
      const m = document.querySelector('.main');
      const el = document.querySelector('#mainContainer [type="bbsrow"][srow="10"]');
      m.scrollTop = el.offsetTop - document.querySelector('#mainContainer').offsetTop;
      return el.getBoundingClientRect().top;
    });
    await page.waitForFunction(
      () => !window.__app.easyReading._reverse && window.__app.easyReading.easyReadingReachedPageEnd,
      null, { timeout: 60000 }
    );
    const after = await page.evaluate(() =>
      document.querySelector('#mainContainer [type="bbsrow"][srow="10"]').getBoundingClientRect().top);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
  });

  test('已讀完再按 End：只捲到底，不送任何鍵', async ({ page }) => {
    await openArticle(page, { total: 60 });
    await page.waitForFunction(() => window.__app.easyReading.easyReadingReachedPageEnd, null,
      { timeout: 15000 });
    const before = await page.evaluate(() => window.__rev.state.sent.length);
    await page.evaluate(() => { document.querySelector('.main').scrollTop = 0; });
    await page.keyboard.press('End');
    await expect.poll(() => page.evaluate(() => {
      const m = document.querySelector('.main');
      return m.scrollTop > 0;
    })).toBe(true);
    expect(await page.evaluate(() => window.__rev.state.sent.length)).toBe(before);
    expect(await page.evaluate(() => window.__app.easyReading._reverse)).toBeNull();
  });
});
