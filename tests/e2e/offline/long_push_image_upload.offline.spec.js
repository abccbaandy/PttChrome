// 長推文輸入框 × 圖片上傳：上傳完的圖床網址要插進**那個 Textarea**，不是送給 PTT。
//
// unit 已經把三個缺口各自釘死了（decideInsertMode 的 target 優先權、controller 的
// 分派、modal 的註冊／游標插入）。這裡守的是 unit 碰不到的那半段：
//   - modal 開著時，window 層的拖放事件真的還到得了 ImageUploadController
//     （Mantine Modal 有 focus trap／overlay，攔掉就整條上傳鏈不啟動）
//   - 插進輸入框的那一刻，stub WS **一個 byte 都沒送**——此時底下的畫面是文章，
//     走 send 等於把網址的每個字元當成 pmore 快捷鍵按下去
//   - 點通知卡的「開啟上傳紀錄」不會關掉 modal（那是另一個 React root，對 Modal
//     而言算「點外面」，closeOnClickOutside 沒關掉就整段稿子沒了）
const { test, expect } = require('@playwright/test');
const { installReplay, waitConnected } = require('../helpers/replay');

// 文章畫面（pmore 狀態列）＝右鍵選單出現「長推文一鍵發送」的前提
// （ContextMenu 的 gating：enableLongPush && buf.pageState === 3）。
const ARTICLE_HEADER = '作者  testuser (安安) 看板 Test';
const ARTICLE_TITLE = '標題  [閒聊] 測試文章';
const ARTICLE_URL =
  '※ 文章網址: https://www.ptt.cc/bbs/Test/M.1756700000.A.ABC.html';
const ARTICLE_FOOTER =
  '  瀏覽 第 1/2 頁 ( 50%)  目前顯示: 第 01~23 行  (y)回應(X%)推文(h)說明(←)離開 ';

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

// 圖床 stub。CORS header 要自己補——跨網域 XHR 一樣會做 preflight，缺 header 的話
// fulfill 出來的回應會被擋在 CORS 檢查（抄 image_upload.offline.spec.js）。
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

// 畫一整幀：rows 是 { 列號: 文字 }。畫面是 Big5，用頁面裡已載入的轉碼表轉成
// server 會送的 bytes 再餵進 App.onData（＝真實的 parser → termBuf 路徑）。
async function drawRows(page, rows) {
  await page.evaluate((map) => {
    const u2b = (str) => {
      let out = '';
      for (const ch of str) {
        const c = ch.charCodeAt(0);
        if (c < 0x80) {
          out += ch;
          continue;
        }
        out +=
          String.fromCharCode(window.lib.u2bArray[2 * c]) +
          String.fromCharCode(window.lib.u2bArray[2 * c + 1]);
      }
      return out;
    };
    let data = '\x1b[2J';
    for (const k of Object.keys(map))
      data += '\x1b[' + (Number(k) + 1) + ';1H' + u2b(map[k]);
    window.__app.onData(data);
  }, rows);
  await page.waitForTimeout(300);
}

const drawArticle = (page) =>
  drawRows(page, {
    0: ARTICLE_HEADER,
    1: ARTICLE_TITLE,
    20: ARTICLE_URL,
    23: ARTICLE_FOOTER
  });

async function collectSent(page) {
  await page.evaluate(() => {
    window.__sent = [];
    window.__stubWSSent = (s) => window.__sent.push(s);
  });
}

const sentText = (page) => page.evaluate(() => (window.__sent || []).join(''));
const label = (page, key) => page.evaluate((k) => window.__i18n(k), key);

async function openContextMenu(page) {
  await page.evaluate(() => {
    document
      .getElementById('mainContainer')
      .dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 })
      );
  });
  await expect(page.locator('.DropdownMenu').first()).toBeVisible();
}

// 開啟長推文輸入框。
async function openLongPushModal(page) {
  await openContextMenu(page);
  await page
    .locator('.DropdownMenu')
    .first()
    .getByText(await label(page, 'cmenu_longPush'), { exact: true })
    .click();
  await expect(page.locator('[name="longPushText"]')).toBeVisible();
}

// 真 DataTransfer 拖放（controller 綁在 window 上）。
async function dropImage(page, name) {
  await page.evaluate((fileName) => {
    const dt = new DataTransfer();
    dt.items.add(
      new File([new Uint8Array([1, 2, 3, 4])], fileName, { type: 'image/png' })
    );
    window.dispatchEvent(
      new DragEvent('dragenter', { dataTransfer: dt, bubbles: true })
    );
    window.dispatchEvent(
      new DragEvent('dragover', { dataTransfer: dt, bubbles: true })
    );
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
  }, name);
}

test.describe('長推文輸入框的圖片上傳（離線）', () => {
  test.beforeEach(async ({ page, context }) => {
    // doCopy 走 navigator.clipboard.writeText，沒授權會 reject（退回剪貼簿那條
    // 路若被誤觸，至少不要炸在權限上，紅的才會是真正的斷言）。
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await installReplay(page);
    await stubUploadApi(page);
    await page.goto('/');
    await waitConnected(page);
    await drawArticle(page);
    expect(await page.evaluate(() => window.__app.buf.pageState)).toBe(3);
    await collectSent(page);
  });

  test('拖圖進輸入框 → 網址插進 Textarea，線路上一個 byte 都沒送', async ({
    page
  }) => {
    await openLongPushModal(page);
    const box = page.locator('[name="longPushText"]');
    await box.fill('先打一段話');
    await collectSent(page);

    await dropImage(page, 'a.png');

    await expect(box).toHaveValue(/https:\/\/i\.urusai\.cc\/img1\.png/, {
      timeout: 15000
    });
    // 原本打的字還在，網址接在後面（插入是插進游標處，不是整段覆蓋）。
    await expect(box).toHaveValue(/^先打一段話 /);
    // 底下的畫面是文章：走 send 的話網址每個字元都會變成 pmore 快捷鍵。
    expect(await sentText(page)).toBe('');
  });

  test('提示卡說的是「已插入輸入框」，點「開啟上傳紀錄」不會關掉輸入框', async ({
    page
  }) => {
    await openLongPushModal(page);
    const box = page.locator('[name="longPushText"]');
    await box.fill('稿子不可以被弄丟');

    await dropImage(page, 'a.png');
    await expect(page.locator('.ImageUploadCard--notice')).toBeVisible({
      timeout: 15000
    });
    await expect(page.locator('.ImageUploadCard--notice')).toContainText(
      await label(page, 'imageUpload_insertedTarget')
    );

    // 通知卡／紀錄面板是另一個 React root（#imageUploadReact，portal 在 body 上）
    // ⇒ 對 Mantine Modal 而言是「點外面」。closeOnClickOutside 沒關掉的話，這一點
    //   就把整段稿子連同 modal 一起收掉。
    await page
      .locator('.ImageUploadCard--notice')
      .getByText(await label(page, 'imageUpload_openHistory'))
      .click();
    await expect(page.locator('.ImageUploadPanel')).toBeVisible();
    await expect(box).toBeVisible();
    await expect(box).toHaveValue(/稿子不可以被弄丟/);
  });

  test('關掉輸入框後恢復原本的決策（不再插進已卸載的輸入框）', async ({
    page
  }) => {
    await openLongPushModal(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('[name="longPushText"]')).toHaveCount(0);
    await collectSent(page);

    await dropImage(page, 'a.png');

    // 文章畫面既不是編輯器也不是推文列 ⇒ 走剪貼簿，線路上仍然什麼都沒有。
    await expect(page.locator('.ImageUploadCard--notice')).toBeVisible({
      timeout: 15000
    });
    await expect(page.locator('.ImageUploadCard--notice')).toContainText(
      await label(page, 'imageUpload_insertedClipboard')
    );
    expect(await sentText(page)).toBe('');
  });
});
