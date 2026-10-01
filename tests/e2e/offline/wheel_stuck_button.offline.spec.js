// 回歸：右鍵按住旗標永久卡 true。
//
// 根因：旗標（舊 mouseRightButtonDown，現 App.mouseButtons.right）只靠 mouseup
// 清除，兩條路徑會讓 mouseup 丟失：
//   A) 按住右鍵時視窗失焦（alt-tab / devtools / OS 選單）→ mouseup 送不到 window
//   B) 右鍵放開時 modalShown=true → 舊 mouse_up 開頭 early-return 吞掉清除
// 修法三層：blur reset、mouse_up 在 modal gate 前清旗標、mouse_scroll 用
// e.buttons 自癒（純邏輯守護在 tests/unit/mouse_button_tracker.test.js）。
//
// 可觀察面（2026-08 滑鼠重新設計後換過一次）：滾輪動作不再看按住哪顆鍵（一律
// 上下頁），所以舊的「右鍵滾＝PgUp／素滾＝方向鍵」對照失效。現在鎖的是仍然依賴
// 該旗標的**使用者可見症狀**：右鍵滾輪之後那一次 contextmenu 會被刻意吞掉
// （doDOMMouseScroll），旗標卡死就變成「之後每次滾輪都吃掉下一次右鍵選單」。
//
// 輸入一律是真的（CDP Input.dispatchMouseEvent，helpers/real_input）：滾輪的 buttons
// 必須由呼叫端指定 —— page.mouse.wheel 不帶 buttons（實測恆為 0）。
//
// **各條都在滾輪之前直接讀旗標**：滾輪本身會用 e.buttons 自癒（第三層），先滾再讀
// 的話，blur reset／modal 前清旗標那兩層就算整個拿掉也照樣綠。
//
// contextmenu 的時機依 OS 而異（Blink：Windows 在放開時發，Linux／macOS 在按下時
// 發）。「按住右鍵滾輪、放開時吞掉選單」只在前者成立 ⇒ 基準那條依實際觀察到的時機
// 分支斷言，不寫死平台。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, loadCassette, replayListCassette } = require('../helpers/replay');
const {
  mousePress,
  mouseRelease,
  mouseWheel,
  recordContextMenu,
} = require('../helpers/real_input');

const PAGE_UP = '\x1b[5~';

const center = (page) => {
  const vp = page.viewportSize();
  return { x: Math.round(vp.width / 2), y: Math.round(vp.height / 2) };
};

const rightFlag = (page) => page.evaluate(() => window.__app.mouseButtons.right);

// 真滾輪向上一格（buttons 由呼叫端指定），回傳 { sent, swallowNextMenu, right }。
// swallowNextMenu = CmdHandler 的 doDOMMouseScroll 旗標，也就是「下一次右鍵選單
// 會不會被吞掉」。預設讀完就復位，避免污染後續斷言；keep=true 時留著（要接著驗
// 放開右鍵那一次選單真的被吞掉）。
async function wheelUp(page, buttons, { keep = false } = {}) {
  await page.evaluate(() => {
    window.__wheelSent = [];
    window.__wheelSeen = 0;
    window.__stubWSSent = (s) => window.__wheelSent.push(s);
    // capture：app 的 handler 也是 window capture，且會 stopPropagation ⇒ bubble 收不到。
    window.addEventListener('wheel', () => ++window.__wheelSeen, { once: true, capture: true });
  });
  const { x, y } = center(page);
  await mouseWheel(page, x, y, { deltaY: -100, buttons });
  await expect.poll(() => page.evaluate(() => window.__wheelSeen)).toBe(1);
  return page.evaluate((keepFlag) => {
    window.__stubWSSent = null;
    const cmd = window.__app.CmdHandler;
    const swallowNextMenu = cmd.getAttribute('doDOMMouseScroll') === '1';
    if (!keepFlag) cmd.setAttribute('doDOMMouseScroll', '0');
    return {
      sent: window.__wheelSent.join(''),
      swallowNextMenu,
      right: window.__app.mouseButtons.right,
    };
  }, keep);
}

test.describe('滾輪按鍵旗標卡死（offline 回歸）', () => {
  test('基準：右鍵按住滾輪會吞掉放開時的右鍵選單、放開後不會', async ({ page }) => {
    await bootOffline(page, ptt);
    await recordContextMenu(page);
    const { x, y } = center(page);

    await mousePress(page, x, y, 'right');
    expect(await rightFlag(page)).toBe(true);
    const menuOnPress = await page.evaluate(() => window.__cm.length > 0);

    if (menuOnPress) {
      // Linux／macOS：選單在按下時就開了（modal），滾輪不翻頁也不立吞選單旗標 ——
      // 「放開時吞掉」這個現場在這些平台不存在。只鎖旗標本身的生命週期。
      await expect(page.locator('.DropdownMenu').first()).toBeVisible();
      await mouseRelease(page, x, y, 'right');
      expect(await rightFlag(page)).toBe(false);
      return;
    }

    // Windows：右鍵按住期間，真實 wheel 的 buttons 含 bit1（=2）
    const held = await wheelUp(page, 2, { keep: true });
    expect(held.right).toBe(true);
    expect(held.swallowNextMenu).toBe(true);
    // 翻頁本身與按住哪顆鍵無關（重新設計後唯一的滾輪動作）
    expect(held.sent).toContain(PAGE_UP);

    await mouseRelease(page, x, y, 'right');
    await expect.poll(() => page.evaluate(() => window.__cm.length)).toBe(1);
    // 使用者可見症狀：翻完頁放開右鍵，不跳我們的選單。
    await expect(page.locator('.DropdownMenu')).toHaveCount(0);
    expect(await rightFlag(page)).toBe(false);

    const released = await wheelUp(page, 0);
    expect(released.right).toBe(false);
    expect(released.swallowNextMenu).toBe(false);
    expect(released.sent).toContain(PAGE_UP);
  });

  // headless 拿不到 alt-tab 的 OS 失焦（Playwright 的 focus emulation 讓每頁都以為
  // 自己有焦點；有頭＋關 emulation 才量得到，見 tests/e2e/README.md「真輸入」）。
  // 改用「焦點移進 iframe」：觸發原因不同，但 window 的 blur 是瀏覽器發的（trusted），
  // 走的是同一個 listener。
  test('路徑 A：右鍵按住時失焦（mouseup 丟失）→ 旗標不得卡住', async ({ page }) => {
    await bootOffline(page, ptt);
    const { x, y } = center(page);

    await mousePress(page, x, y, 'right');
    expect(await rightFlag(page)).toBe(true);

    await page.evaluate(() => {
      window.__blur = null;
      window.addEventListener('blur', (e) => { window.__blur = { trusted: e.isTrusted }; }, {
        once: true,
      });
      const f = document.createElement('iframe');
      f.id = 'e2e-focus-sink';
      f.srcdoc = '<input id="sink">';
      f.style.cssText = 'position:fixed;left:0;top:0;width:40px;height:20px;z-index:9999';
      document.body.appendChild(f);
    });
    const frame = page.frameLocator('#e2e-focus-sink');
    await frame.locator('#sink').focus();
    // 不送 mouseReleased —— 這就是「丟失」本身，不是模擬。
    await expect.poll(() => page.evaluate(() => window.__blur)).toEqual({ trusted: true });
    expect(await rightFlag(page), 'blur 之後旗標要立刻清掉（不靠下一次滾輪自癒）').toBe(false);

    await page.evaluate(() => document.getElementById('t').focus());
    const r = await wheelUp(page, 0);
    expect(r.right).toBe(false);
    expect(r.swallowNextMenu).toBe(false);
  });

  test('路徑 B：右鍵放開時 modal 開啟 → 旗標仍須清除', async ({ page }) => {
    await bootOffline(page, ptt);
    const { x, y } = center(page);

    await mousePress(page, x, y, 'right');
    expect(await rightFlag(page)).toBe(true);
    // 走 setModalOpen（具名來源集合）而非直接寫 modalShown：後者已改由來源集合
    // 推導，硬寫會在下一次任何 modal 開關時被覆蓋。
    await page.evaluate(() => window.__app.setModalOpen('test', true));
    await mouseRelease(page, x, y, 'right');
    expect(await rightFlag(page), 'modal 開著時放開，旗標也要清掉').toBe(false);
    await page.evaluate(() => window.__app.setModalOpen('test', false));
    await page.keyboard.press('Escape'); // Windows 上放開時開的那個右鍵選單

    const r = await wheelUp(page, 0);
    expect(r.right).toBe(false);
    expect(r.swallowNextMenu).toBe(false);
  });

  test('終極保險：旗標被硬卡 true 時，下一次滾輪以 e.buttons 自癒', async ({ page }) => {
    await bootOffline(page, ptt);

    await page.evaluate(() => {
      // 直接製造「不明原因卡死」——不管哪條未知路徑漏掉，都該被 buttons 同步救回
      window.__app.mouseButtons.right = true;
    });

    const r = await wheelUp(page, 0);
    expect(r.right).toBe(false);
    expect(r.swallowNextMenu).toBe(false);
  });

  // 底色只在看板列表（pageState 2）跟著滑鼠走 ⇒ 要真的有列表。以前在空白畫面上量，
  // 底色本來就不會動，這條沉默地永真。
  test('按住左鍵拖曳時，滑鼠移動不得再更新游標底色', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableEasyReadingList: false,
      useMouseBrowsing: true,
      mouseLeftClick: true,
    });
    await replayListCassette(page, loadCassette('cchat-list-nav'));
    await expect.poll(() => page.evaluate(() => window.__app.buf.pageState)).toBe(2);

    const highlight = () => page.evaluate(() => window.__app.buf.nowHighlight);
    // 前提：沒按鍵時，這兩點之間移動**會**改底色（否則下面的斷言沉默地永真）。
    await page.mouse.move(400, 320);
    const free320 = await highlight();
    await page.mouse.move(400, 200);
    expect(await highlight()).not.toBe(free320);
    expect(await page.evaluate(() => window.__app.mouseButtons.left)).toBe(false);
    await page.mouse.down();
    expect(await page.evaluate(() => window.__app.mouseButtons.left)).toBe(true);
    const frozen = await page.evaluate(() => window.__app.buf.nowHighlight);
    await page.mouse.move(400, 320, { steps: 4 });
    const after = await page.evaluate(() => window.__app.buf.nowHighlight);
    await page.mouse.up();

    expect(after).toBe(frozen);
  });
});
