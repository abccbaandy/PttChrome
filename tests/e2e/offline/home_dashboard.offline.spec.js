// 首頁儀表板（src/js/home_dashboard.js、docs/home-dashboard.md）：主功能表上蓋面板 → 自動送
// Ctrl+Z f 抓我的最愛 → q 回主功能表 → 畫出卡片；點卡片走 s<板>；真鍵盤打字收起面板、鍵照送。
// server 的回應由測試照 pttbbs 版面畫（主功能表＝helpers/main_menu，我的最愛＝board.c#brdlist_renderer）。
// 焦點留在 #t、點面板不變成點終端機、面板開著打字照常送 PTT，只有真瀏覽器驗得出來。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, waitScreenSettled } = require('../helpers/replay');
const { drawMainMenu } = require('../helpers/main_menu');
const { startCapture, peekCapture, takeCapture } = require('../helpers/capture');

const ZA_FAV = '\x1af';

// 一頁我的最愛：%7d%c%s（未讀是全形ˇ）＋板名(13)＋類別＋◎＋敘述(34)＋人氣＋板主。
async function drawFavorites(page, boards) {
  await page.evaluate((boards) => {
    const u2b = (str) => {
      let out = '';
      for (const ch of str) {
        const c = ch.charCodeAt(0);
        if (c < 0x80) {
          out += ch;
          continue;
        }
        out += String.fromCharCode(window.lib.u2bArray[2 * c]) + String.fromCharCode(window.lib.u2bArray[2 * c + 1]);
      }
      return out;
    };
    const width = (s) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) < 0x80 ? 1 : 2), 0);
    const padCells = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));
    const REV = '\x1b[7m';
    const OFF = '\x1b[0m';
    let d = '\x1b[H\x1b[2J';
    d += '\x1b[1;1H' + REV + u2b(padCells('【看板列表】                     批踢踢實業坊', 80)) + OFF;
    d += '\x1b[2;1H' + u2b('[←][q]回上層 [→][r]閱讀 [↑↓]選擇 [PgUp][PgDn]翻頁 [c]新文章 [/]搜尋 [h]求助');
    d += '\x1b[3;1H' + REV + u2b(padCells('   編號   看  板       類別   中   文   敘   述               人氣 板   主', 80)) + OFF;
    boards.forEach((b, i) => {
      const head = String(i + 1).padStart(7, ' ') + ' ' + (b.unread ? 'ˇ' : '  ');
      const row = (i === 0 ? '>' + head.slice(1) : head) + b.name.padEnd(13, ' ') + '綜合 ◎' + padCells(b.desc, 34) + 'HOT someone';
      d += '\x1b[' + (4 + i) + ';1H' + u2b(row);
    });
    d += '\x1b[24;1H' + REV + u2b(padCells('  選擇看板    (a)增加看板 (s)進入已知板名 (y)列出全部 (v/V)已讀/未讀', 79)) + OFF;
    d += '\x1b[4;1H';
    window.__app.onData(d);
  }, boards);
  await waitScreenSettled(page, { 0: '看板列表', 23: '(a)增加看板' });
}

const FAVS = [
  { name: 'C_Chat', desc: '[希洽] 閒聊', unread: true },
  { name: 'Stock', desc: '[股票] 今天漲了', unread: false },
];

const dashboard = (page) => page.locator('#homeDashboard');

async function bootHome(page, prefs) {
  await bootOffline(page, ptt, { homeDashboard: true });
  if (prefs) await ptt.applyPrefs(page, prefs);
  await page.evaluate(() => window.__app.setInputAreaFocus());
  await startCapture(page);
}

// 面板出現 → 自動 Ctrl+Z f → 畫我的最愛 → 送 q → 畫回主功能表 → 卡片。
async function fetchFlow(page) {
  await drawMainMenu(page);
  await expect(dashboard(page)).toBeVisible();
  await expect.poll(() => peekCapture(page)).toContain(ZA_FAV);
  await drawFavorites(page, FAVS);
  await expect.poll(() => peekCapture(page)).toContain('q');
  expect(await takeCapture(page)).toBe(ZA_FAV + '\fq\f');
  await drawMainMenu(page);
  await expect(page.locator('[data-home-board]')).toHaveCount(2);
}

test.describe('首頁儀表板', () => {
  test('自動抓我的最愛：Ctrl+Z f → q，卡片與未讀標記照畫面', async ({ page }) => {
    await bootHome(page);
    await fetchFlow(page);
    await expect(page.locator('[data-home-board="C_Chat"]')).toHaveAttribute('data-unread', '');
    await expect(page.locator('[data-home-board="Stock"]')).not.toHaveAttribute('data-unread', '');
    await expect(page.locator('[data-home-board="C_Chat"]')).toContainText('[希洽] 閒聊');
    await expect(page.locator('#t')).toBeFocused();
  });

  test('點卡片 ⇒ 走 s<板>（同搜尋彈窗的前往看板），點下去不變成點終端機', async ({ page }) => {
    await bootHome(page, { useMouseBrowsing: true, mouseLeftClick: true });
    await fetchFlow(page);
    await page.locator('[data-home-board="Stock"]').click();
    await expect.poll(() => peekCapture(page)).toContain('s');
    // 只有搜尋的第一步（s＋\f），沒有滑鼠瀏覽送的 ↑↓／Enter。
    expect(await takeCapture(page)).toBe('s\f');
    await expect(page.locator('#t')).toBeFocused();
  });

  test('面板開著用真鍵盤打字 ⇒ 面板收起、鍵照常送給 PTT', async ({ page }) => {
    await bootHome(page);
    await fetchFlow(page);
    await page.keyboard.press('ArrowDown');
    await expect(dashboard(page)).toHaveCount(0);
    await expect.poll(() => peekCapture(page)).toContain('\x1b[B');
    expect(await takeCapture(page)).toBe('\x1b[B');
  });

  test('「原生主選單」⇒ 收起，主功能表留在原地', async ({ page }) => {
    await bootHome(page);
    await fetchFlow(page);
    await page.locator('[data-home-native]').click();
    await expect(dashboard(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.__app.buf.getRowText(0, 0, 80))).toContain('主功能表');
  });

  test('pref 關 ⇒ 不蓋面板、不排自動抓', async ({ page }) => {
    await bootHome(page, { enableHomeDashboard: false });
    await drawMainMenu(page);
    await expect(dashboard(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.__app.homeDashboard._autoTimer)).toBeNull();
  });
});
