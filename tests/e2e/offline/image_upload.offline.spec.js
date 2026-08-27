// 圖片上傳（urusai）的端到端行為：真瀏覽器、真拖放事件、真 XHR（圖床被 route 攔下），
// 只有 WebSocket 是 stub（installReplay）。
//
// 這裡守的是 unit 抓不到的那半段：
//   - 拖檔案進視窗會亮出遮罩、放開會真的發出上傳請求
//   - 推文列狀態下，網址**真的送上線**（讀 stub WS 收到的 bytes）
//   - 非輸入狀態下**一個 byte 都不送**（走剪貼簿）——這條若壞掉就是在列表亂按指令
//   - 多檔一次插入、面板的「插入」鈕走同一條路
const { test, expect } = require('@playwright/test');
const { installReplay, waitConnected } = require('../helpers/replay');

const uploadJson = (id) =>
  JSON.stringify({
    status: 'success',
    message: 'uploaded',
    data: {
      id,
      r18: '0',
      filename: id + '.png',
      url_preview: 'https://i.urusai.cc/' + id,
      url_direct: 'https://i.urusai.cc/' + id + '.png',
      url_delete: 'https://urusai.cc/del/' + id,
      mime: 'image/png'
    }
  });

// 圖床 stub：每次上傳回一個遞增的 id。CORS header 要自己補——瀏覽器對跨網域 XHR
// 一樣會做 preflight，缺 header 的話 fulfill 出來的回應會被擋在 CORS 檢查。
async function stubUploadApi(page) {
  let n = 0;
  await page.route('**api-v1-t2-upload.urusai.cc**', async (route) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'POST, OPTIONS'
    };
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors, body: '' });
      return;
    }
    n += 1;
    await route.fulfill({
      status: 200,
      headers: { ...cors, 'content-type': 'application/json' },
      body: uploadJson('img' + n)
    });
  });
}

// client 送出的 bytes 全部收進 window.__sent（replay stub 的既有 hook）。
async function collectSent(page) {
  await page.evaluate(() => {
    window.__sent = [];
    window.__stubWSSent = (s) => window.__sent.push(s);
  });
}

const sentText = (page) => page.evaluate(() => (window.__sent || []).join(''));

// 把最後一列畫成 PTT 的推文輸入列。型別符刻意用**推**而不是 →：bbs.c#recommend 的
// prompt 是 ctype[type]（推／噓／→），而按 1.值得推薦 是最常走的路；判斷式只認 →
// 的那版 bug 在這裡才會現形（unit 另有三種型別符的逐一守護）。畫面是 Big5，所以用頁面裡已載入的
// 轉碼表把字串轉成 Big5 bytes 再餵進 App.onData（＝真實的 parser→termBuf 路徑）。
async function drawPushPrompt(page) {
  await page.evaluate(() => {
    const u2b = (s) => {
      let out = '';
      for (const ch of s) {
        const c = ch.charCodeAt(0);
        if (c < 0x80) {
          out += ch;
          continue;
        }
        const hi = window.lib.u2bArray[2 * c];
        const lo = window.lib.u2bArray[2 * c + 1];
        out += String.fromCharCode(hi) + String.fromCharCode(lo);
      }
      return out;
    };
    window.__app.onData('\x1b[2J\x1b[24;1H' + u2b('推 testuser: '));
  });
  await page.waitForTimeout(200);
}

// 拖放一批檔案到視窗（controller 綁在 window 上）。
async function dropFiles(page, names) {
  await page.evaluate((fileNames) => {
    const dt = new DataTransfer();
    for (const name of fileNames) {
      dt.items.add(
        new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'image/png' })
      );
    }
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    window.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }));
    window.__dropDt = dt;
  }, names);
}

async function releaseDrop(page) {
  await page.evaluate(() => {
    window.dispatchEvent(
      new DragEvent('drop', { dataTransfer: window.__dropDt, bubbles: true })
    );
  });
}

test.describe('圖片上傳（離線）', () => {
  test.beforeEach(async ({ page, context }) => {
    // doCopy 走 navigator.clipboard.writeText，沒授權會 reject。
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await installReplay(page);
    await stubUploadApi(page);
    await page.goto('/');
    await waitConnected(page);
    await collectSent(page);
  });

  test('拖檔案進視窗亮出遮罩，放開後把直連網址送進推文列', async ({ page }) => {
    await drawPushPrompt(page);

    await dropFiles(page, ['a.png']);
    await expect(page.locator('.ImageUploadDropZone')).toBeVisible();

    await releaseDrop(page);
    // 遮罩在放開的當下就要收掉（不然畫面被半透明黑蓋住）。
    await expect(page.locator('.ImageUploadDropZone')).toHaveCount(0);

    await expect
      .poll(() => sentText(page), { timeout: 15000 })
      .toContain('https://i.urusai.cc/img1.png');
  });

  test('不在推文列／編輯器時一個 byte 都不送（改走剪貼簿）', async ({ page }) => {
    // 空畫面＝既不是編輯器也不是推文列；送字等於在列表亂按指令。
    await page.evaluate(() => window.__app.onData('\x1b[2J\x1b[H  BOARD LIST  '));
    await page.waitForTimeout(200);

    await dropFiles(page, ['a.png']);
    await releaseDrop(page);

    // 上傳有完成（提示卡出現），但線路上什麼都沒有。
    await expect(page.locator('.ImageUploadCard--notice')).toBeVisible({ timeout: 15000 });
    expect(await sentText(page)).toBe('');
  });

  test('多檔：依序上傳後一次插入，網址以空白分隔', async ({ page }) => {
    await drawPushPrompt(page);

    await dropFiles(page, ['a.png', 'b.png']);
    await releaseDrop(page);

    await expect
      .poll(() => sentText(page), { timeout: 30000 })
      .toContain('https://i.urusai.cc/img1.png https://i.urusai.cc/img2.png');
  });

  test('上傳紀錄面板的「插入」鈕走同一條插入路徑', async ({ page }) => {
    await drawPushPrompt(page);
    await dropFiles(page, ['a.png']);
    await releaseDrop(page);
    await expect
      .poll(() => sentText(page), { timeout: 15000 })
      .toContain('https://i.urusai.cc/img1.png');

    // 清掉已送出的紀錄，再從面板插一次同一張圖。
    await collectSent(page);
    await page.evaluate(() => window.__app.imageUpload.openPanel());
    await expect(page.locator('.ImageUploadPanel')).toBeVisible();
    // 用 class 而非文字選：瀏覽器語系決定 i18n 文案（CI 的 chromium 是 en-US）。
    await page.locator('.ImageUploadPanel__Insert').first().click();

    await expect.poll(() => sentText(page), { timeout: 10000 }).toContain(
      'https://i.urusai.cc/img1.png'
    );
  });

  test('拖非圖片檔不會發出上傳請求，只說明原因', async ({ page }) => {
    let requested = false;
    page.on('request', (req) => {
      if (req.url().indexOf('api-v1-t2-upload.urusai.cc') >= 0) requested = true;
    });

    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['hello'], 'note.txt', { type: 'text/plain' }));
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
    });

    await expect(page.locator('.ImageUploadCard--notice')).toBeVisible();
    await expect(page.locator('.ImageUploadCard--notice')).toContainText('note.txt');
    expect(requested).toBe(false);
    expect(await sentText(page)).toBe('');
  });

  // 回歸（2026-08-21「Ctrl+V 貼不上，Shift+Insert 正常」）：Ctrl+V 必須讓給瀏覽器。
  // unit（tests/unit/term_keyboard_paste.test.js）只能證明 TermKeyboard 回 false；
  // 「keydown 真的沒被 cancel、瀏覽器才生得出 paste 事件」這層要真瀏覽器＋完整
  // boot 鏈才量得到——被 preventDefault 的話 #t 收不到 paste、App.onDOMPaste 不跑，
  // 文字貼上與截圖上傳兩條路一起死。
  test('Ctrl+V 不被吃掉：keydown 放行、線路上沒有 ^V', async ({ page }) => {
    await drawPushPrompt(page);
    await collectSent(page);

    // app 的 keydown handler 綁在 window 的冒泡階段（term_view），所以這個後掛的
    // listener 一定在它之後跑 → 讀得到最終的 defaultPrevented。
    await page.evaluate(() => {
      window.__lastKeyPrevented = null;
      window.addEventListener('keydown', (e) => {
        if (e.key === 'v' || e.key === 'V') window.__lastKeyPrevented = e.defaultPrevented;
      });
    });

    await page.locator('#t').focus();
    await page.keyboard.press('Control+v');
    await page.waitForTimeout(200);

    expect(await page.evaluate(() => window.__lastKeyPrevented)).toBe(false);
    expect(await sentText(page)).not.toContain('');
  });

  test('Alt+V 仍送得出 ^V（Ctrl+V 讓位後唯一的路）', async ({ page }) => {
    await drawPushPrompt(page);
    await collectSent(page);

    await page.locator('#t').focus();
    await page.keyboard.press('Alt+v');
    await expect.poll(() => sentText(page), { timeout: 5000 }).toContain('');
  });
});
