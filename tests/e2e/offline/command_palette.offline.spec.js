// 指令面板（src/js/command_palette.js）：真鍵盤 F4 開面板 → 打字不漏給 PTT → Enter 接到
// 既有入口。server 的回應由測試照 pttbbs 版面畫（同 unread_jump.offline.spec.js）。
// F 鍵的瀏覽器預設動作、打字時焦點在不在面板上，只有真按鍵驗得出來。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, waitScreenSettled } = require('../helpers/replay');

async function collectSent(page) {
  await page.evaluate(() => {
    window.__sent = [];
    window.__stubWSSent = (s) => window.__sent.push(s);
  });
}
const sentText = (page) => page.evaluate(() => (window.__sent || []).join(''));

async function drawList(page) {
  await page.evaluate(() => {
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
    const REV = '\x1b[7m';
    const OFF = '\x1b[0m';
    let d = '\x1b[2J';
    d += '\x1b[1;1H' + REV + u2b('【板主：test】看板《Test》'.padEnd(80)) + OFF;
    d += '\x1b[2;1H' + u2b('[←]離開 [→]閱讀 [^P]發表文章 [b]備忘錄');
    d += '\x1b[3;1H' + REV + u2b('  編號    日 期 作  者       文  章  標  題'.padEnd(70)) + OFF;
    for (let i = 0; i < 3; ++i) {
      const num = 1233 + i;
      const head = i === 0 ? '>' + String(num).padStart(6) : String(num).padStart(7);
      d += '\x1b[' + (4 + i) + ';1H' + u2b(head + ' + 5 9/01 testuser     □[閒聊] 測試' + num);
    }
    d += '\x1b[24;1H' + u2b(' 文章選讀  (y)回應(X)推文(^X)轉錄 ');
    d += '\x1b[4;1H';
    window.__app.onData(d);
  });
  await waitScreenSettled(page, { 2: '編號', 23: '文章選讀' });
}

async function bootOnList(page, prefs) {
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, { enableEasyReadingList: false, ...(prefs || {}) });
  await drawList(page);
  await page.evaluate(() => {
    window.__f4Prevented = null;
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F4') window.__f4Prevented = e.defaultPrevented;
    });
    window.__app.setInputAreaFocus();
  });
  await collectSent(page);
}

const paletteInput = (page) => page.locator('input[name="commandPaletteQuery"]');

test.describe('指令面板（F4）', () => {
  test('F4 開面板（擋下預設動作）；打字不送給 PTT；Esc 關掉零 byte', async ({ page }) => {
    await bootOnList(page);
    await page.keyboard.press('F4');
    await expect(paletteInput(page)).toBeFocused();
    expect(await page.evaluate(() => window.__f4Prevented)).toBe(true);

    await page.keyboard.type('Test');
    await expect(page.locator('[data-palette-item="board"]')).toBeVisible();
    await expect(page.locator('[data-palette-item="search:title"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(paletteInput(page)).toHaveCount(0);
    expect(await sentText(page)).toBe('');
  });

  test('打「未讀」Enter ⇒ 跑跳到第一篇未讀（送 End）', async ({ page }) => {
    await bootOnList(page);
    await page.keyboard.press('F4');
    await expect(paletteInput(page)).toBeFocused();
    await page.keyboard.type('unread');
    await expect(page.locator('[data-palette-item="action:unreadJump"]')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect.poll(() => sentText(page)).toContain('\x1b[4~');
    await expect(paletteInput(page)).toHaveCount(0);
  });

  test('pref 關 ⇒ F4 不開面板、不擋', async ({ page }) => {
    await bootOnList(page, { enableCommandPalette: false });
    await page.keyboard.press('F4');
    expect(await page.evaluate(() => window.__f4Prevented)).toBe(false);
    await expect(paletteInput(page)).toHaveCount(0);
  });
});
