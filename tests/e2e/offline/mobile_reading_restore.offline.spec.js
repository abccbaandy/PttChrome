// 閱讀紀錄（docs/reading-record.md）：手機換行版面下，文章重讀後的還原要回到同一列。
//
// 斷線重連、AID 返回、長推文取消這些路徑都是「離開文章 → 從頭重讀 → 累積到那一列時
// 一次性捲過去」（easy_reading.requestScrollRestore → term_view.pageRowTop）。手機跟
// 桌機的差別全在版面：一列會折成好幾行、長頁分塊沒渲染過的塊以 100lh 估高（換行後
// 實際高好幾倍），所以採樣與還原都只能量節點。這裡用合成長文（多個分塊、有換行、
// 有圖）在 offline-mobile 走完整條：讀到中段 → 重新開機重讀 → 還原 → 預覽載完之後
// 視窗頂端仍是同一列的同一處。
// 內容全部合成（helpers/pmore_sim.js），不含任何真實文章。
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline } = require('../helpers/replay');
const { waitPreviewsSettled } = require('../helpers/layout');

const SIM_SRC = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'pmore_sim.js'), 'utf8');
const TOTAL = 600;

// 內文前 120 行是會在手機寬度換行的長列（每 30 行一張圖），之後是推文（每 40 則一張圖）。
async function installSim(page, total) {
  await page.evaluate(
    ({ src, total }) => {
      const module = { exports: {} };
      new Function('module', 'exports', src)(module, module.exports);
      const { createPmoreSim } = module.exports;
      const authors = ['alice', 'bob', 'carol', 'dave', 'erin'];
      const lineText = (n) => {
        if (n < 120) {
          if (n % 30 === 10) return `https://i.imgur.com/restore${n}.png`;
          return (`內文第 ${n} 行 ` + '測試文字'.repeat(n % 4 === 0 ? 16 : 3)).slice(0, 78);
        }
        const who = authors[Math.floor(n / 3) % authors.length];
        const body = n % 40 === 0 ? `https://i.imgur.com/restore${n}.png` : `comment ${n} ` + '推文內容'.repeat(n % 5);
        return `${n % 3 === 0 ? '推' : '→'} ${who}: ${body}`.padEnd(66) + '09/25 10:00';
      };
      const sim = createPmoreSim({ total, rows: window.__app.buf.rows, lineText });
      const u2b = (str) => {
        let out = '';
        for (const ch of str) {
          const c = ch.charCodeAt(0);
          if (c < 0x80) { out += ch; continue; }
          out += String.fromCharCode(window.lib.u2bArray[2 * c]) + String.fromCharCode(window.lib.u2bArray[2 * c + 1]);
        }
        return out;
      };
      const encode = (f) => {
        let d = '\x1b[H\x1b[2J';
        f.texts.forEach((t, i) => { if (t) d += '\x1b[' + (i + 1) + ';1H' + u2b(t); });
        return d + '\x1b[' + (f.cursor.y + 1) + ';' + (f.cursor.x + 1) + 'H';
      };
      const KEYS = /^(\x1b\[[1456]~|:\d+\r)$/;
      const wire = [];
      window.__stubWSSent = (s) => {
        if (!KEYS.test(s)) return;
        wire.push(s);
        setTimeout(() => {
          const resp = sim.press(wire.shift());
          if (resp) resp.frames.forEach((f) => window.__app.onData(encode(f)));
        }, 5);
      };
      window.__app.onData(encode(sim.screen()));
    },
    { src: SIM_SRC, total }
  );
}

// 視窗頂端：閱讀紀錄記的列索引，以及那一列節點相對視窗頂端的位置（px）。
// srow：改量指定那一列（還原後量「還原前的那一列」現在在哪；見 expectSamePlace）。
const topOfView = (page, srow) =>
  page.evaluate((srow) => {
    const v = window.__app.view;
    const d = v.mainDisplay;
    const li = v.currentLineIndex();
    const row = srow == null ? Math.floor(li) : srow;
    const el = document.querySelector('#mainContainer [type="bbsrow"][srow="' + row + '"]');
    return {
      li,
      reflow: v.reflow,
      chunks: document.querySelectorAll('#mainContainer > .screenChunk').length,
      top: el ? Math.round(el.getBoundingClientRect().top - d.getBoundingClientRect().top) : null,
      text: el ? el.textContent.slice(0, 24) : null,
    };
  }, srow);

// 開機 → 進好讀 → 預讀到文末。restoreLi：進好讀的同一刻掛上還原請求（＝重讀）。
async function openAndRead(page, restoreLi, bootOpts) {
  await bootOffline(page, ptt, bootOpts);
  await ptt.applyPrefs(page, { enableEasyReadingList: false, enableEasyReading: true });
  await installSim(page, TOTAL);
  await page.waitForFunction(() => window.__app.buf.pageState === 3);
  await page.evaluate((li) => {
    window.__app.easyReading.enterEasyReading();
    if (li != null) window.__app.easyReading.requestScrollRestore(li);
  }, restoreLi);
  await page.waitForFunction(() => window.__app.easyReading.easyReadingReachedPageEnd, null, { timeout: 120000 });
  await waitPreviewsSettled(page);
}

for (const frac of [0.25, 0.5, 0.8]) {
  test(`重讀後還原：讀到 ${frac * 100}% 處離開，回來仍是同一列同一處`, async ({ page }) => {
    test.setTimeout(180000);
    await openAndRead(page, null);
    await page.evaluate((f) => {
      const d = window.__app.view.mainDisplay;
      d.scrollTop = Math.round((d.scrollHeight - d.clientHeight) * f);
    }, frac);
    await waitPreviewsSettled(page);
    const before = await topOfView(page);
    expect(before.reflow).toBe(true);
    expect(before.chunks).toBeGreaterThan(2);
    expect(before.li).toBeGreaterThan(0);

    await openAndRead(page, before.li);
    const after = await topOfView(page, Math.floor(before.li));
    expectSamePlace(before, after);
  });
}

// 閱讀紀錄的列內比例恆 ≥ 0（term_view.currentLineIndex）：視窗頂端落在兩列之間的空隙
// （推文間距 .commentSpacing 的 margin-top）時，記下的是「下一列的列頂」，空隙那幾 px
// 不在紀錄裡 ⇒ 還原後那一列貼齊視窗頂端（top 0），而不是原本的正數。
// 依比例捲動時是否剛好落進空隙看當輪版面，所以這個分支另有下面那條決定性的 case 守。
const expectedTop = (before) => Math.min(before.top, 0);

// 同一列同一處：還原前視窗頂端的那一列（after 量的就是它），列頂相對視窗頂端的位置差
// ≤ 2px。一律用 px 判，不比 currentLineIndex：
//   - 列內比例＝px／列高，短列（兩行推文 39px）上 scroll anchoring 的 1px 取整就是 0.026，
//     大於 toBeCloseTo(…, 2) 的容差。
//   - 停在列與列的交界時，offsetTop／offsetHeight 各自取整讓相鄰兩列重疊 1px，「視窗頂端
//     那一列」可能判成上一列的最後 1px（317 → 316.974），位置其實一樣。
function expectSamePlace(before, after) {
  expect(after.text).toBe(before.text);
  expect(Math.abs(after.top - expectedTop(before))).toBeLessThanOrEqual(2);
}

test('重讀後還原：視窗頂端落在兩列之間的空隙 ⇒ 回來時那一列貼齊視窗頂端', async ({ page }) => {
  test.setTimeout(180000);
  await openAndRead(page, null);
  // 捲到推文區、等預覽載完，在視窗內找一段列與列之間的空隙，把視窗頂端放在空隙的上緣
  // 附近（離下一列列頂最遠 ⇒ 舊斷言「還原前後 top 差 ≤ 2」必紅）。只在視窗內找：捲動距離
  // 不到一屏，不會再觸發新的預覽載入把空隙推走。視窗只有約 290px，剛好被一張推文圖佔滿
  // 時這一屏沒有空隙 ⇒ 往下挪半屏、等預覽載完再找（最多幾次）。
  await page.evaluate(() => {
    const d = window.__app.view.mainDisplay;
    d.scrollTop = Math.round((d.scrollHeight - d.clientHeight) * 0.8);
  });
  await waitPreviewsSettled(page);
  const findGap = () => page.evaluate(() => {
    const d = window.__app.view.mainDisplay;
    const dTop = d.getBoundingClientRect().top;
    const rows = Array.from(document.querySelectorAll('#mainContainer [type="bbsrow"]'))
      .filter((el) => el.offsetParent !== null)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { srow: Number(el.getAttribute('srow')), top: r.top - dTop + d.scrollTop, bottom: r.bottom - dTop + d.scrollTop };
      })
      .filter((r) => r.top > d.scrollTop && r.bottom < d.scrollTop + d.clientHeight)
      .sort((a, b) => a.top - b.top);
    for (let i = 1; i < rows.length; ++i) {
      if (rows[i].srow === rows[i - 1].srow + 1 && rows[i].top - rows[i - 1].bottom >= 3)
        return { srow: rows[i].srow, y: rows[i - 1].bottom + 0.5 };
    }
    return null;
  });
  let gap = await findGap();
  for (let tries = 0; !gap && tries < 6; ++tries) {
    await page.evaluate(() => {
      const d = window.__app.view.mainDisplay;
      d.scrollTop += Math.round(d.clientHeight / 2);
    });
    await waitPreviewsSettled(page);
    gap = await findGap();
  }
  expect(gap).not.toBeNull();
  await page.evaluate((y) => { window.__app.view.mainDisplay.scrollTop = y; }, gap.y);
  await waitPreviewsSettled(page);
  const before = await topOfView(page);
  // 前提：視窗頂端確實在空隙裡（下一列的列頂在視窗頂端之下），紀錄是那一列、比例 0。
  expect(before.li).toBe(gap.srow);
  expect(before.top).toBeGreaterThan(0);

  await openAndRead(page, before.li);
  const after = await topOfView(page, Math.floor(before.li));
  expectSamePlace(before, after);
});

// 還原落地時視窗頂端那張圖還沒載完（佔位盒只有幾十 px）：列內比例是照「當下」列高換算的，
// 圖載完列撐高，瀏覽器的 scroll anchoring 保住的是**像素**位移而不是比例 ⇒ 沒有落地後的
// 守位，視窗頂端會往回縮到圖的上緣附近（依比例捲動的 case 在 CI 負載下偶發踩到）。
// 重讀改用慢速圖片（5.2s），讓「落地時圖還沒到」變成決定性的。
test('重讀後還原：落地時視窗頂端的圖還沒載完 ⇒ 載完後仍停在圖的同一處', async ({ page }) => {
  test.setTimeout(180000);
  await openAndRead(page, null);
  const IMAGE_ROW = 101; // lineText(100)：每 30 行一張圖（srow ＝行號 + 1）
  // 先捲到圖那一列、等圖載完（列高才是真的），再把視窗頂端放進那一列的 60% 處。
  const scrollIntoRow = (frac) =>
    page.evaluate(({ srow, frac }) => {
      const d = window.__app.view.mainDisplay;
      const el = document.querySelector('#mainContainer [type="bbsrow"][srow="' + srow + '"]');
      d.scrollTop += el.getBoundingClientRect().top - d.getBoundingClientRect().top + Math.round(el.offsetHeight * frac);
    }, { srow: IMAGE_ROW, frac });
  await scrollIntoRow(0);
  await waitPreviewsSettled(page);
  await scrollIntoRow(0.6);
  await waitPreviewsSettled(page);
  const before = await topOfView(page);
  // 前提：視窗頂端落在那張圖的中段（比例明顯 > 0，列高是載完的圖）。
  expect(Math.floor(before.li)).toBe(IMAGE_ROW);
  expect(before.li - IMAGE_ROW).toBeGreaterThan(0.3);

  await openAndRead(page, before.li, { imageProfile: 'slow' });
  const after = await topOfView(page, Math.floor(before.li));
  expectSamePlace(before, after);
});
