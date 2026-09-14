// Alt（macOS 的 Option）＝ PTT 的 Ctrl，全 26 字母 —— 離線重放，真瀏覽器、真渲染、
// 完整 boot 鏈、真 WebSocket 出口。
//
// unit 用的是手刻的假 KeyboardEvent，證不到「真瀏覽器產生的 keydown 真的走完整條
// term_view keyEventFilter → 分派鏈 → TermKeyboard → WebSocket」。這支就鎖那一段。
//
// **這支測不到的事**（別以為綠了就代表萬無一失）：Playwright 走 CDP 的
// Input.dispatchKeyEvent，不經過 browser chrome 的快捷鍵分派 ⇒ 量不到「這顆 Alt
// 組合會不會被瀏覽器先吃掉」。那是 tools/alt-key-probe.html 人工量測的職責，
// 結論表在 docs/pttbbs-screen-protocol.md §11.8。
//
// 同理，macOS 的 dead key（⌥E/⌥I/⌥N/⌥U 的 keyCode 229 ＋組字）在 Windows/Linux
// 的 Chromium 上重現不出來；那三道防線的守護在 tests/unit/term_view_alt_composition。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const {
  findCassette,
  bootOffline,
  replayListCassette,
} = require('../helpers/replay');

const list = findCassette('list');

async function startCapture(page) {
  await page.evaluate(() => {
    window.__sentLog = [];
    window.__stubWSSent = (s) => window.__sentLog.push(s);
  });
}
async function takeCapture(page) {
  return page.evaluate(() => {
    const out = window.__sentLog.join('');
    window.__sentLog = [];
    return out;
  });
}

test.describe('Alt ＝ PTT 的 Ctrl（離線重放）', () => {
  if (!list) {
    test.skip('尚無 list cassette；先 yarn record:cassette', () => {});
  }

  test.beforeEach(async ({ page }) => {
    await bootOffline(page, ptt);
    // 好讀關掉：這支要鎖的是**原生路徑**把 byte 寫上線。好讀列表的 sync 腿
    // （Alt 鍵先跳號再代送）已由 tests/unit/list_keys.test.js 全 26 字母守護。
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableEasyReadingList: false,
    });
    await replayListCassette(page, list);
  });

  test('Alt+A~Z 送出對應的控制碼 0x01~0x1A', async ({ page }) => {
    test.setTimeout(120000);
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    for (let i = 0; i < letters.length; ++i) {
      const L = letters[i];
      await startCapture(page);
      await page.keyboard.press('Alt+Key' + L);
      await page.waitForTimeout(30);
      const sent = await takeCapture(page);
      expect(sent, 'Alt+' + L).toBe(String.fromCharCode(i + 1));
    }
  });

  test('Alt+C/A/X 給 PTT，不是複製／全選／剪下', async ({ page }) => {
    test.setTimeout(90000);
    // 這三顆的 Ctrl 版被 term_view 的本地快捷鍵吃掉（doSelectAll 無條件吃），
    // Alt 版是 PTT 端 ClearTagList / show_filename / cross_post 唯一可靠的入口。
    for (const [key, out] of [
      ['Alt+KeyC', '\x03'],
      ['Alt+KeyA', '\x01'],
      ['Alt+KeyX', '\x18'],
    ]) {
      await startCapture(page);
      await page.keyboard.press(key);
      await page.waitForTimeout(30);
      expect(await takeCapture(page), key).toBe(out);
    }
  });

  test('Alt 版與 Ctrl 版送出的 byte 相同（不變量本身）', async ({ page }) => {
    test.setTimeout(90000);
    // Ctrl-V 是唯一例外（刻意讓給瀏覽器貼上），Ctrl-C/A 被本地快捷鍵吃掉，都排除。
    for (const L of ['Q', 'W', 'S', 'D', 'Z', 'T', 'P', 'Y']) {
      await startCapture(page);
      await page.keyboard.press('Control+Key' + L);
      await page.waitForTimeout(30);
      const viaCtrl = await takeCapture(page);

      await startCapture(page);
      await page.keyboard.press('Alt+Key' + L);
      await page.waitForTimeout(30);
      const viaAlt = await takeCapture(page);

      expect(viaAlt, 'Alt+' + L + ' 應與 Ctrl+' + L + ' 同 byte').toBe(viaCtrl);
      expect(viaAlt.length).toBe(1);
    }
  });

  test('非字母的 Alt 組合一個 byte 都不送（留給瀏覽器／OS）', async ({ page }) => {
    test.setTimeout(90000);
    for (const key of ['Alt+ArrowLeft', 'Alt+Digit5', 'Alt+BracketLeft']) {
      await startCapture(page);
      await page.keyboard.press(key);
      await page.waitForTimeout(30);
      expect(await takeCapture(page), key).toBe('');
    }
  });

  test('Alt+Shift+字母不送（remap 分支排除 shift）', async ({ page }) => {
    test.setTimeout(90000);
    await startCapture(page);
    await page.keyboard.press('Alt+Shift+KeyT');
    await page.waitForTimeout(30);
    expect(await takeCapture(page)).toBe('');
  });
});
