// 長推文一鍵發送的端到端行為：真瀏覽器、真右鍵選單、真渲染、真 CommandQueue，
// 只有 WebSocket 是 stub（installReplay）——「server 回什麼」由測試逐幀餵進
// App.onData，「client 送了什麼」從 stub WS 的 window.__sent 讀回來。
//
// unit（tests/unit/long_push_flow.test.js）已經把狀態機的鍵序釘死了，這裡守的是
// unit 碰不到的那半段：
//   - 右鍵選單的項目真的在文章畫面出現、點下去開得了輸入框
//   - 送出時整條鏈（React modal → LongPushSession → CommandQueue → WS）真的接得起來
//   - 送出期間遮罩擋住畫面、鍵盤不會漏到 PTT（modalShown 由 render state 推導）
//   - 取消送出 Ctrl-C 收尾
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, feedRaw } = require('../helpers/replay');

// pmore 的底部狀態列＝「這頁是文章」的決定性指紋（term_buf.setPageState → 3）。
// 含「回應」⇒ currstat == READING ⇒ 按 X 推得到文（string_util 的說明）。
const ARTICLE_FOOTER =
  '  瀏覽 第 1/2 頁 ( 50%)  目前顯示: 第 01~23 行  (y)回應(X%)推文(h)說明(←)離開 ';
const TYPE_MENU = '您覺得這篇文章 1.值得推薦 2.給它噓聲 3.只加→註解 [1]? ';
const PROMPT = '推 testuser: ';
const CONFIRM = '推 testuser: 內容                        確定[y/N]:';

const label = (page, key) => page.evaluate((k) => window.__i18n(k), key);

// 頁面裡已經載好 Big5 轉碼表，直接用它把畫面文字轉成 server 會送的 bytes。
async function drawLastRow(page, text) {
  await page.evaluate((s) => {
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
    window.__app.onData('\x1b[2J\x1b[24;1H' + u2b(s));
  }, text);
  // settle 是 50ms 的安靜窗，等它 dispatch 之後 CommandQueue 才判得到這一幀。
  await page.waitForTimeout(300);
}

async function collectSent(page) {
  await page.evaluate(() => {
    window.__sent = [];
    window.__stubWSSent = (s) => window.__sent.push(s);
  });
}

const sentText = (page) => page.evaluate(() => (window.__sent || []).join(''));

// 期望值也用頁面裡那份轉碼表算，才不會在測試裡手抄 Big5 bytes。
const toBig5 = (page, s) =>
  page.evaluate((str) => {
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
  }, s);

// 對終端機派發 contextmenu（真滑鼠右鍵在 headless 下座標對位太脆，
// 同 article_link_menu / quick_search 的手法）。
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

const itemByText = (page, text) =>
  page.locator('.DropdownMenu').first().getByText(text, { exact: true });

// 開輸入框 → 打字 → 送出。
async function submitLongPush(page, text) {
  await openContextMenu(page);
  await itemByText(page, await label(page, 'cmenu_longPush')).click();
  const box = page.locator('[name="longPushText"]');
  await expect(box).toBeVisible();
  await box.fill(text);
  await collectSent(page);
  await page
    .getByRole('button', { name: await label(page, 'longPushModal_confirm') })
    .click();
}

async function boot(page) {
  await bootOffline(page, ptt);
  await drawLastRow(page, ARTICLE_FOOTER);
  expect(await page.evaluate(() => window.__app.buf.pageState)).toBe(3);
}

test.describe('長推文一鍵發送（離線）', () => {
  test('文章畫面才看得到選單項', async ({ page }) => {
    await boot(page);
    await openContextMenu(page);
    await expect(
      itemByText(page, await label(page, 'cmenu_longPush'))
    ).toHaveCount(1);

    // 離開文章（底列不再是 pmore 狀態列）⇒ 按 X 推不到文，這一項就不該出現。
    // term_buf.setPageState 是 sticky 的（沒有分支命中就維持原值），空底列會走
    // 最後那條 isLineEmpty → pageState 0。
    await page.keyboard.press('Escape');
    await expect(page.locator('.DropdownMenu')).toHaveCount(0);
    await drawLastRow(page, '');
    expect(await page.evaluate(() => window.__app.buf.pageState)).not.toBe(3);
    await openContextMenu(page);
    await expect(
      itemByText(page, await label(page, 'cmenu_longPush'))
    ).toHaveCount(0);
  });

  test('送出兩則：整條鏈接得起來，鍵序與 PTT 的推文流程一致', async ({ page }) => {
    await boot(page);
    await submitLongPush(page, '第一段\n第二段');

    // 遮罩亮起來，畫面被擋住。
    await expect(page.getByTestId('longPushProgressStatus')).toBeVisible();
    expect(await page.evaluate(() => window.__app.modalShown)).toBe(true);

    // 步驟 1：X
    await expect.poll(() => sentText(page)).toBe('X');

    // 步驟 2：型別選單 → 單一 byte（帶 Enter 的話會被下一個 getdata 吃掉）
    await drawLastRow(page, TYPE_MENU);
    await expect.poll(() => sentText(page)).toBe('X1');

    // 步驟 3：內容 + Enter（Big5）
    await drawLastRow(page, PROMPT);
    const seg1 = await toBig5(page, '第一段');
    await expect.poll(() => sentText(page)).toBe('X1' + seg1 + '\r');

    // 步驟 4：確定[y/N]
    await drawLastRow(page, CONFIRM);
    await expect.poll(() => sentText(page)).toContain('y\r');

    // 第一則落地 → 馬上開始第二則。
    await drawLastRow(page, ARTICLE_FOOTER);
    await expect.poll(() => sentText(page)).toMatch(/y\rX$/);

    // 第二則走 PTT 的 90 秒降級分支（沒有型別選單，底列直接是輸入列）。
    await drawLastRow(page, '→ testuser: ');
    await drawLastRow(page, CONFIRM);
    await drawLastRow(page, ARTICLE_FOOTER);

    // 送完收工：遮罩收掉、鍵盤還回終端機。
    await expect(page.getByTestId('longPushProgressStatus')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.__app.modalShown))
      .toBe(false);
    await expect
      .poll(() => page.evaluate(() => window.__app.longPush.active))
      .toBe(false);
  });

  // 送 bytes 給 PTT 的四條使用者入口在送出期間都必須噤聲。鍵盤那條走真按鍵；
  // IME 與貼上沒有可靠的離線觸發方式（IME 的 composition 在 headless 造不出來），
  // 所以直接戳產品自己的漏斗 view.onTextInput / App.onPasteDone——那正是
  // image_upload_controller 與 doPaste 走的同一個入口。
  // 純邏輯在 tests/unit/serialized_op_gate.test.js，這裡守的是真物件的接線。
  test('送出期間鍵盤／IME／貼上都不會漏到 PTT', async ({ page }) => {
    await boot(page);
    await submitLongPush(page, '安安');
    await expect.poll(() => sentText(page)).toBe('X');

    // 序列真的在途才驗得到守門（進度遮罩上的按鍵會結束這一輪，所以注入排在
    // 鍵盤那兩下**之前**）。
    expect(await page.evaluate(() => window.__app.longPush.active)).toBe(true);
    await page.evaluate(() => window.__app.view.onTextInput('測'));
    await page.evaluate(() => window.__app.onPasteDone('測'));

    await page.keyboard.press('a');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    // 只有狀態機自己送出去的那個 X。
    expect(await sentText(page)).toBe('X');
  });

  test('取消：送 Ctrl-C 收尾，剩餘內容留給使用者', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await boot(page);
    await submitLongPush(page, '第一段\n第二段');
    await drawLastRow(page, TYPE_MENU);
    await drawLastRow(page, PROMPT);

    await page
      .getByRole('button', { name: await label(page, 'longPushProgress_cancel') })
      .click();
    // vgetstring 的 Ctrl-C＝清空 + abort ⇒ recommend() 什麼都不寫就 return。
    await expect.poll(() => sentText(page)).toMatch(/\x03$/);

    await drawLastRow(page, ARTICLE_FOOTER);
    await expect(page.getByTestId('longPushProgressStatus')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.__app.longPush.active))
      .toBe(false);
  });

  test('冷卻：先消掉橫幅，遮罩顯示倒數', async ({ page }) => {
    await boot(page);
    await submitLongPush(page, '安安');
    await expect.poll(() => sentText(page)).toBe('X');

    await drawLastRow(page, ' ◆ 本板禁止快速連續推文，請再等 30 秒     [按任意鍵繼續]');
    // vmsg 的 vkey() 迴圈要一個真按鍵才消得掉。
    await expect.poll(() => sentText(page)).toBe('X ');
    await drawLastRow(page, ARTICLE_FOOTER);
    await expect(page.getByTestId('longPushProgressStatus')).toContainText('30');
  });
});
