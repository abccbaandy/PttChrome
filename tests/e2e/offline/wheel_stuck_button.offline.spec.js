// 回歸：滾輪偶爾永久卡成 PgUp/PgDn。
//
// 根因：右鍵按住旗標（舊 mouseRightButtonDown，現 App.mouseButtons.right）只靠
// mouseup 清除，兩條路徑會讓 mouseup 丟失 → 旗標永久 true → 之後滾輪一律翻頁：
//   A) 按住右鍵時視窗失焦（alt-tab / devtools / OS 選單）→ mouseup 送不到 window
//   B) 右鍵放開時 modalShown=true → 舊 mouse_up 開頭 early-return 吞掉清除
// 修法三層：blur reset、mouse_up 在 modal gate 前清旗標、mouse_scroll 用
// e.buttons 自癒（純邏輯守護在 tests/unit/mouse_button_tracker.test.js）。
// 這裡驗 pttchrome.js 的接線與事件順序：斷言鎖「送出的 bytes 是方向鍵而非翻頁」。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline } = require('../helpers/replay');

const ARROW_UP = '\x1b[A';
const PAGE_UP = '\x1b[5~';

// 收集送出 bytes → 派發一次向上滾輪（buttons 由呼叫端指定）→ 回傳送出序列。
async function wheelUpAndCapture(page, buttons) {
  return page.evaluate((btns) => {
    const sent = [];
    window.__stubWSSent = (s) => sent.push(s);
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, buttons: btns }));
    window.__stubWSSent = null;
    return sent;
  }, buttons);
}

test.describe('滾輪按鍵旗標卡死（offline 回歸）', () => {
  test('基準：右鍵按住滾輪＝翻頁、放開後＝方向鍵', async ({ page }) => {
    await bootOffline(page, ptt);

    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent('mousedown', { button: 2 }));
    });
    // 右鍵按住期間，真實 wheel 事件的 buttons 含 bit1（=2）
    expect((await wheelUpAndCapture(page, 2)).join('')).toContain(PAGE_UP);

    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { button: 2 }));
    });
    const sent = (await wheelUpAndCapture(page, 0)).join('');
    expect(sent).toContain(ARROW_UP);
    expect(sent).not.toContain(PAGE_UP);
  });

  test('路徑 A：右鍵按住時失焦（mouseup 丟失）→ 滾輪不得卡在翻頁', async ({ page }) => {
    await bootOffline(page, ptt);

    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent('mousedown', { button: 2 }));
      // 模擬 alt-tab：blur 之後 mouseup 永遠不會來
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    });

    const sent = (await wheelUpAndCapture(page, 0)).join('');
    expect(sent).toContain(ARROW_UP);
    expect(sent).not.toContain(PAGE_UP);
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

    const sent = (await wheelUpAndCapture(page, 0)).join('');
    expect(sent).toContain(ARROW_UP);
    expect(sent).not.toContain(PAGE_UP);
  });

  test('終極保險：旗標被硬卡 true 時，下一次滾輪以 e.buttons 自癒', async ({ page }) => {
    await bootOffline(page, ptt);

    await page.evaluate(() => {
      // 直接製造「不明原因卡死」——不管哪條未知路徑漏掉，都該被 buttons 同步救回
      window.__app.mouseButtons.right = true;
    });

    const sent = (await wheelUpAndCapture(page, 0)).join('');
    expect(sent).toContain(ARROW_UP);
    expect(sent).not.toContain(PAGE_UP);
  });
});
