// 超長文（幾乎整篇推文）反向讀取（End）時，視窗內的文字不得震動。
//
// 回歸實錄（2026-09，使用者回報「文字細微震動，一直到預讀完」）：推文區塊行距
// （.commentSpacing 的 margin-top 0.55em、合併塊 line-height 1.3）在字級不是 20 的
// 倍數時是小數像素。反向讀取每在視窗上方插入一頁推文，scroll anchoring 補償後的捲動
// 位置被對齊到整數 ⇒ 視窗內文字每幀 +0.5／-0.5px 來回跳。現有
// easy_reading_reverse.offline.spec.js 只在 viewUpdate 時量「離底部多遠」、容許誤差到
// chh，而且用預設字級 20（0.55em＝11px 剛好整數）⇒ 量不到。
//
// 這裡每個 rAF 追蹤同一個列節點相對 .main 的位置，任何非零位移都算震動。
// 內容全部合成（tests/e2e/helpers/pmore_sim.js），不含任何真實文章。
// 每幀 render 成本只印出來不斷言（機器快慢差太多）；O(n²) 的結構性回歸由 unit
// tests/unit/screen_reverse_splice.test.js「零屬性寫入」守。
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline } = require('../helpers/replay');

const SIM_SRC = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'pmore_sim.js'), 'utf8');
const TOTAL = Number(process.env.PERF_TOTAL || 3000);
const LATENCY_MS = 15;
const FIRST_COMMENT = 60;

async function installSim(page, simOpts) {
  await page.evaluate(
    ({ src, simOpts, firstComment, LATENCY_MS }) => {
      const module = { exports: {} };
      new Function('module', 'exports', src)(module, module.exports);
      const { createPmoreSim } = module.exports;
      const authors = ['alice', 'bob', 'carol', 'dave', 'erin'];
      // 同作者連續 3 則（會被合併成一塊）、每 40 則一張圖、每 150 行一段作者的內文回覆
      const lineText = (n) => {
        if (n < firstComment) return `article line ${n}`;
        if (n % 150 === 0) return `edit reply line ${n}`;
        const who = authors[Math.floor(n / 3) % authors.length];
        const body = n % 40 === 0 ? `https://i.imgur.com/perf${n}.png` : `comment ${n}`;
        return `${n % 3 === 0 ? '推' : '→'} ${who}: ${body}`.padEnd(66) + '09/25 10:00';
      };
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
      const wire = [];
      const answerNext = () => {
        const resp = sim.press(wire.shift());
        if (resp) resp.frames.forEach((f) => window.__app.onData(encode(f)));
      };
      window.__stubWSSent = (s) => {
        if (!KEYS.test(s)) return;
        wire.push(s);
        setTimeout(answerNext, LATENCY_MS);
      };
      window.__app.onData(encode(sim.screen()));
    },
    { src: SIM_SRC, simOpts, firstComment: FIRST_COMMENT, LATENCY_MS }
  );
}

async function openArticle(page, prefs) {
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, Object.assign({ enableEasyReadingList: false }, prefs));
  await installSim(page, { total: TOTAL });
  await page.waitForFunction(() => window.__app.buf.pageState === 3);
  await page.evaluate(() => window.__app.easyReading.enterEasyReading());
  await page.waitForFunction(() => window.__app.view.useEasyReadingMode && window.__app.buf.pageLines.length > 0);
}

// 每一次 ScreenController._render 的耗時（含同步 layout），只供印出。
async function instrumentRender(page) {
  await page.evaluate(() => {
    const proto = Object.getPrototypeOf(window.__app.view.componentScreen);
    const orig = proto._render;
    window.__renders = [];
    proto._render = function() {
      const t0 = performance.now();
      orig.call(this);
      const t1 = performance.now();
      void document.querySelector('.main').scrollHeight;
      window.__renders.push({ n: (this.props.lines || []).length, js: t1 - t0, layout: performance.now() - t1 });
    };
  });
}

test.describe('好讀超長文反向讀取（離線）', () => {
  test.setTimeout(180000);

  test('往上插入推文的整個過程，視窗內的文字不得有任何位移（含次像素）', async ({ page }) => {
    // fontSize 32 ⇒ chh 30 ⇒ 0.55em＝16.5px（小數）：修正前每幀 ±0.5px
    await openArticle(page, { fontSize: 32, commentBlockSpacing: true, mergeSameAuthorComments: true });
    await instrumentRender(page);
    await page.keyboard.press('End');
    await page.waitForFunction(
      () => window.__app.view._reverse && window.__app.view._reverse.tailComplete,
      null, { timeout: 15000 }
    );
    await page.evaluate(() => {
      const m = document.querySelector('.main');
      window.__jit = [];
      let target = null, last = null;
      const tick = () => {
        if (!window.__app.easyReading._reverse) return;
        // 以節點本身追蹤；節點被換掉（接合點那一列）就換一個重新起算
        if (!target || !target.isConnected) {
          // 視窗中線以下的第一列（只拿來追蹤位置，不點它）
          const mid = m.getBoundingClientRect().top + m.clientHeight / 2;
          const rows = m.querySelectorAll('#mainContainer [type="bbsrow"]');
          target = null;
          for (let i = rows.length - 1; i >= 0; --i) {
            if (rows[i].getBoundingClientRect().top < mid) break;
            target = rows[i];
          }
          last = null;
        }
        if (target) {
          const y = target.getBoundingClientRect().top - m.getBoundingClientRect().top;
          if (last != null) window.__jit.push(y - last);
          last = y;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.waitForFunction(
      () => !window.__app.easyReading._reverse && window.__app.easyReading.easyReadingReachedPageEnd,
      null, { timeout: 150000 }
    );
    const r = await page.evaluate(() => ({
      renders: window.__renders, jit: window.__jit, chh: window.__app.view.chh,
    }));
    // 前提：這個字級下間距真的是小數像素（否則這支測試什麼都沒守到）
    expect((r.chh * 0.55) % 1).not.toBe(0);
    const step = Math.ceil(TOTAL / 4);
    for (let lo = 0; lo < TOTAL; lo += step) {
      const xs = r.renders.filter((x) => x.n >= lo && x.n < lo + step);
      const avg = (k) => (xs.length ? (xs.reduce((a, x) => a + x[k], 0) / xs.length).toFixed(1) : '-');
      console.log(`render n∈[${lo},${lo + step}) js=${avg('js')}ms layout=${avg('layout')}ms (${xs.length})`);
    }
    expect(r.jit.length).toBeGreaterThan(20);
    const moves = r.jit.filter((d) => d !== 0);
    expect(moves, JSON.stringify(moves.slice(0, 20))).toEqual([]);
  });
});
