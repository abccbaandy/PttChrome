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
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline } = require('../helpers/replay');

const PAGE_UP = '\x1b[5~';

// 派發一次向上滾輪（buttons 由呼叫端指定），回傳 { sent, swallowNextMenu }。
// swallowNextMenu = CmdHandler 的 doDOMMouseScroll 旗標，也就是「下一次右鍵選單
// 會不會被吞掉」。讀完就復位，避免污染後續斷言。
async function wheelUp(page, buttons) {
  return page.evaluate((btns) => {
    const sent = [];
    window.__stubWSSent = (s) => sent.push(s);
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, buttons: btns }));
    window.__stubWSSent = null;
    const cmd = window.__app.CmdHandler;
    const swallowNextMenu = cmd.getAttribute('doDOMMouseScroll') === '1';
    cmd.setAttribute('doDOMMouseScroll', '0');
    return { sent: sent.join(''), swallowNextMenu, right: window.__app.mouseButtons.right };
  }, buttons);
}

test.describe('滾輪按鍵旗標卡死（offline 回歸）', () => {
  test('基準：右鍵按住滾輪會吞掉下一次右鍵選單、放開後不會', async ({ page }) => {
    await bootOffline(page, ptt);

    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent('mousedown', { button: 2 }));
    });
    // 右鍵按住期間，真實 wheel 事件的 buttons 含 bit1（=2）
    const held = await wheelUp(page, 2);
    expect(held.right).toBe(true);
    expect(held.swallowNextMenu).toBe(true);
    // 翻頁本身與按住哪顆鍵無關（重新設計後唯一的滾輪動作）
    expect(held.sent).toContain(PAGE_UP);

    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { button: 2 }));
    });
    const released = await wheelUp(page, 0);
    expect(released.right).toBe(false);
    expect(released.swallowNextMenu).toBe(false);
    expect(released.sent).toContain(PAGE_UP);
  });

  test('路徑 A：右鍵按住時失焦（mouseup 丟失）→ 旗標不得卡住', async ({ page }) => {
    await bootOffline(page, ptt);

    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent('mousedown', { button: 2 }));
      // 模擬 alt-tab：blur 之後 mouseup 永遠不會來
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    });

    const r = await wheelUp(page, 0);
    expect(r.right).toBe(false);
    expect(r.swallowNextMenu).toBe(false);
  });

  test('路徑 B：右鍵放開時 modal 開啟 → 旗標仍須清除', async ({ page }) => {
    await bootOffline(page, ptt);

    await page.evaluate(() => {
      // 走 setModalOpen（具名來源集合）而非直接寫 modalShown：後者已改由來源集合
      // 推導，硬寫會在下一次任何 modal 開關時被覆蓋。
      window.dispatchEvent(new MouseEvent('mousedown', { button: 2 }));
      window.__app.setModalOpen('test', true);
      window.dispatchEvent(new MouseEvent('mouseup', { button: 2 }));
      window.__app.setModalOpen('test', false);
    });

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

  test('左鍵旗標卡住時，滑鼠移動不得再更新游標底色（拖曳選取中的行為）', async ({ page }) => {
    await bootOffline(page, ptt);

    const rows = await page.evaluate(() => {
      const app = window.__app;
      const seen = [];
      const move = (y) => {
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400, clientY: y }));
        seen.push(app.buf.nowHighlight);
      };
      app.mouseButtons.left = false;
      move(200);
      app.mouseButtons.left = true; // 按住左鍵＝拖曳選取，hover 不該再跟著跑
      const frozen = app.buf.nowHighlight;
      move(320);
      return { seen, frozen, after: app.buf.nowHighlight };
    });

    expect(rows.after).toBe(rows.frozen);
  });
});
