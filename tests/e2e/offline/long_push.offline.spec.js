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
// 文章畫面的第一列（term_view 由它認出 _articleBoard）與 PTT 附在文末的網址列
// （aid_navigation.findLocalPostAid 讀它 ⇒ 不必按 Q 就拿得到 AID）。少了它們，
// 長推文開場會多一次 Q，鍵序就不是這裡要守的那條了。
const ARTICLE_HEADER = '作者  testuser (安安) 看板 Test';
const ARTICLE_TITLE = '標題  [閒聊] 測試文章';
const ARTICLE_URL =
  '※ 文章網址: https://www.ptt.cc/bbs/Test/M.1756700000.A.ABC.html';
const POST_AID = '1Vr#TnAB';
const TYPE_MENU = '您覺得這篇文章 1.值得推薦 2.給它噓聲 3.只加→註解 [1]? ';
const PROMPT = '推 testuser: ';
const CONFIRM = '推 testuser: 內容                        確定[y/N]:';

const label = (page, key) => page.evaluate((k) => window.__i18n(k), key);

// 頁面裡已經載好 Big5 轉碼表，直接用它把畫面文字轉成 server 會送的 bytes。
// 畫一整幀：rows 是 { 列號: 文字 } 的對照表。
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

// 完整的文章畫面（標頭＋網址列＋pmore 狀態列）。
const drawArticle = (page) =>
  drawRows(page, {
    0: ARTICLE_HEADER,
    1: ARTICLE_TITLE,
    20: ARTICLE_URL,
    23: ARTICLE_FOOTER,
  });

// 一整幀**文章列表**。指紋要件見 list_session.classifyListScreen：row0/row2 反白、
// row2 含「編號」、底列含「文章選讀」、游標停在條目區且 curX <= 1、至少 3 列編號。
// 這裡刻意走真的 ANSI ＋ 真的游標定位，才會經過 term_buf.settleSnapshot →
// list_session._collectFacts → CommandQueue.onSettle 這條真實路徑。
function boardListRow(num, author, title) {
  return (
    String(num).padStart(7) +
    '    ' +
    ' 9/01 ' +
    author.padEnd(13).slice(0, 13) +
    '□' +
    title
  );
}

async function drawBoardList(page, rows, cursorRow) {
  await page.evaluate(
    ({ rows, curY }) => {
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
      const REV = '\x1b[7m';
      const OFF = '\x1b[0m';
      let d = '\x1b[2J';
      // row0 反白鋪滿整列、row1 不可留空：term_buf.setPageState 判 pageState 2
      // 要的就是這兩件事（isUnicolor(0,0,29) + isUnicolor(0,cols-20,cols-10) +
      // !isLineEmpty(1) + isUnicolor(2,0,cols-10)）。少了它們畫面會落在 pageState 0，
      // 「列表(2) → 文章(3)」的 settle 邊緣就不成立 ⇒ 好讀不會自動開。
      d += '\x1b[1;1H' + REV + u2b('【板主：test】看板《Test》'.padEnd(80)) + OFF;
      d += '\x1b[2;1H' + u2b('[←]離開 [→]閱讀 [^P]發表文章 [b]備忘錄');
      d +=
        '\x1b[3;1H' +
        REV +
        u2b('  編號    日 期 作  者       文  章  標  題'.padEnd(70)) +
        OFF;
      rows.forEach((t, i) => {
        d += '\x1b[' + (4 + i) + ';1H' + u2b(t);
      });
      d += '\x1b[24;1H' + u2b(' 文章選讀  (y)回應(X)推文(^X)轉錄 ');
      // 游標最後停在條目區那一列的第 0 欄（PTT 的 cursor_show 就是這樣）。
      d += '\x1b[' + (curY + 1) + ';1H';
      window.__app.onData(d);
    },
    { rows, curY: 3 + cursorRow }
  );
  await page.waitForTimeout(300);
}

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

// 探路的一次往返：按 X／點選單之後，狀態機會先送一個 X 問 PTT「這篇推得了嗎」，
// 讀完答案再從推文流程退出來、按 ⏎ 回原文章，**然後**才開輸入框。
// 這裡餵的是「推得了」那條路（型別選單 → Ctrl-C ×2 → 回文章）。
async function runPreflight(page) {
  // 探路遮罩先出現：使用者按了 X 不能什麼反應都沒有。
  await expect(page.getByTestId('longPushProgressStatus')).toBeVisible();
  await expect.poll(() => sentText(page)).toContain('X');
  await drawLastRow(page, TYPE_MENU); // 推得了
  await drawLastRow(page, PROMPT); // 第 1 個 Ctrl-C 被 vkey() 當成預設值 → 輸入列
  await drawLastRow(page, ARTICLE_FOOTER); // 第 2 個 Ctrl-C 真的 abort 掉
  await drawArticle(page); // ⏎ 回到文章
  await expect(page.locator('[name="longPushText"]')).toBeVisible();
}

// 開輸入框（含探路往返）→ 打字 → 送出。
async function submitLongPush(page, text) {
  await openContextMenu(page);
  // 探路那一段也要看得到線路（runPreflight 會驗它送了 X）。
  await collectSent(page);
  await itemByText(page, await label(page, 'cmenu_longPush')).click();
  await runPreflight(page);
  const box = page.locator('[name="longPushText"]');
  await expect(box).toBeVisible();
  await box.fill(text);
  // collectSent 一定要排在**探路之後**：探路的那個 X 不屬於「送出」這一段，
  // 把它算進來下面每一條鍵序斷言都會多一個 X。

  await collectSent(page);
  await page
    .getByRole('button', { name: await label(page, 'longPushModal_confirm') })
    .click();
}

async function boot(page) {
  await bootOffline(page, ptt);
  // 這支 spec 自己畫畫面（drawArticle／drawBoardList）驗的都是**原生**行為，而列表
  // 好讀自 2026-09-16 起預設開 —— 它一 engage 就會自己往線路送機器鍵，讓「按 X 只送
  // 出一個 byte」這類斷言收到多餘的 bytes。明確關掉，別靠預設值。
  await ptt.applyPrefs(page, { enableEasyReadingList: false });
  await drawArticle(page);
  expect(await page.evaluate(() => window.__app.buf.pageState)).toBe(3);
  // 免費路徑拿得到 AID ⇒ 開場不會按 Q（長推文的錨點來源，見 long_push_anchor.js）。
  expect(
    await page.evaluate(() => !!window.__app.aidNavigation.findLocalPostAid())
  ).toBe(true);
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

  // 鍵盤送出。unit（long_push_modal.test.jsx）已經守了「Ctrl+Enter 會呼叫
  // onConfirm」，這裡守只有真瀏覽器看得到的兩件事：
  //   1. preventDefault 真的擋掉了 textarea 自己的換行（jsdom 不會插那個字元，
  //      fireEvent 的回傳值只證明「有呼叫 preventDefault」）——送不出去的空白狀態
  //      下按一次最看得出來：框還開著，內容必須仍是空的。
  //   2. 這一下沒漏給 PTT：modalShown 擋著 term_view 的 global keydown，線路上
  //      第一個 byte 必須就是長推文自己送的 X。
  test('Ctrl+Enter 送出：不多插換行，也不漏 byte 給 PTT', async ({ page }) => {
    await boot(page);
    await openContextMenu(page);
    await collectSent(page);
    await itemByText(page, await label(page, 'cmenu_longPush')).click();
    await runPreflight(page);

    const box = page.locator('[name="longPushText"]');
    await expect(box).toBeVisible();
    await collectSent(page);
    await box.press('Control+Enter');
    // 空的時候按＝什麼都不會發生，但那一下也不能變成一個換行。
    await expect(box).toBeVisible();
    await expect(box).toHaveValue('');
    expect(await sentText(page)).toBe('');

    await box.fill('安安');
    await collectSent(page);
    await box.press('Control+Enter');

    await expect(page.getByTestId('longPushProgressStatus')).toBeVisible();
    await expect.poll(() => sentText(page)).toBe('X');

    // 內容就是打的那兩個字，沒有被多出來的換行切成兩則。
    await drawLastRow(page, TYPE_MENU);
    await drawLastRow(page, PROMPT);
    const seg = await toBig5(page, '安安');
    await expect.poll(() => sentText(page)).toBe('X1' + seg + '\r');

    await drawLastRow(page, CONFIRM);
    await drawLastRow(page, ARTICLE_FOOTER);
    await expect(page.getByTestId('longPushProgressStatus')).toHaveCount(0);
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

  // 使用者實測的 bug：熱門版推完第 1 則，列表一有增刪游標就飄掉，第 2 則推到別篇。
  // 根因在 pttbbs（read.c 的 crs_ln 只是行號，不綁文章身分），完整推導見
  // src/js/long_push_anchor.js 檔頭。unit 用假 facts 釘死了決策表，這裡要證明
  // 真實那條 term_buf → list_session._collectFacts → CommandQueue 的路徑也接得上。
  test('落回列表時游標飄掉：先用 #AID 釘回原篇，不會直接按 X', async ({ page }) => {
    await boot(page);
    const aid = await page.evaluate(
      () => window.__app.aidNavigation.findLocalPostAid().aid
    );

    await submitLongPush(page, '第一段\n第二段');
    await expect.poll(() => sentText(page)).toBe('X');
    await drawLastRow(page, TYPE_MENU);
    await drawLastRow(page, PROMPT);
    await drawLastRow(page, CONFIRM);

    // 第 1 則落地，但游標底下已經是別人剛貼的新文。
    await collectSent(page);
    await drawBoardList(
      page,
      [
        boardListRow(1233, 'testuser', '[閒聊] 測試文章'),
        boardListRow(1234, 'someoneElse', '[公告] 剛剛才貼的新文'),
        boardListRow(1235, 'thirdGuy', '[問卦] 又一篇'),
      ],
      1
    );

    // 送出去的必須是定位鍵，**不是** X。
    await expect.poll(() => sentText(page)).toBe('#' + aid + '\r\f');
    expect(await sentText(page)).not.toContain('X');
  });

  // --- 攔截推文鍵（X／%）-----------------------------------------------------
  //
  // 判準是純函式（tests/unit/long_push_gate.test.js），三條入口的分派也有 unit
  // （tests/unit/push_key_intercept.test.js）。這裡守的是 unit 碰不到的那半段：
  // 真鍵盤事件 → 真 term_view 分派 → 真 React 樹開輸入框，而且**線路上一個 byte
  // 都沒送**（unit 的假 ctx 驗不到真的 WebSocket）。
  // 2026-09 起按 X 會先探路：使用者那個 byte 仍然被吞掉，改由 CommandQueue 送一個
  // X 去問 PTT 推不推得了。**線路上總共就那一個 X**（toBe 不是 toContain：多送一個
  // 就是使用者按一次卻推兩次的前奏），而且輸入框要等答案回來才開。
  test('文章畫面按 X → 先送一個 X 探路，探完才開輸入框', async ({ page }) => {
    await boot(page);
    await collectSent(page);

    await ptt.sendKey(page, 'X');
    // 還在問 PTT：輸入框還沒開，但畫面上已經有遮罩。
    await expect(page.getByTestId('longPushProgressStatus')).toBeVisible();
    await expect(page.locator('[name="longPushText"]')).toHaveCount(0);
    expect(await sentText(page)).toBe('X');
    // 遮罩與輸入框都要收鍵盤（modalShown 由 render state 推導）。
    expect(await page.evaluate(() => window.__app.modalShown)).toBe(true);

    await drawLastRow(page, TYPE_MENU);
    await drawLastRow(page, PROMPT);
    await drawLastRow(page, ARTICLE_FOOTER);
    await drawArticle(page);
    await expect(page.locator('[name="longPushText"]')).toBeVisible();
    expect(await page.evaluate(() => window.__app.modalShown)).toBe(true);
  });

  test('% 是推文的同義鍵，一樣攔（送出去的是 X，不是 %）', async ({ page }) => {
    await boot(page);
    await collectSent(page);

    await ptt.sendKey(page, '%');
    await expect(page.getByTestId('longPushProgressStatus')).toBeVisible();
    // 使用者的 % 沒有被原樣轉送——線路上只有狀態機自己送的那個 X。
    expect(await sentText(page)).toBe('X');
    await drawLastRow(page, TYPE_MENU);
    await drawLastRow(page, PROMPT);
    await drawLastRow(page, ARTICLE_FOOTER);
    await drawArticle(page);
    await expect(page.locator('[name="longPushText"]')).toBeVisible();
  });

  // 探路真正的價值：推不了的板子，使用者在**打字之前**就知道，而且看到的是 PTT
  // 自己的話。unit（long_push_preflight.test.js）用假 facts 驗過決策，這裡要證明
  // 「Big5 bytes → term_buf → rowText → classifyPushScreen → React」整條也接得上。
  test('探路被擋 → 不開輸入框，錯誤框裡是 PTT 的原文', async ({ page }) => {
    await boot(page);
    await collectSent(page);

    await ptt.sendKey(page, 'X');
    await expect.poll(() => sentText(page)).toBe('X');
    await drawLastRow(page, ' ◆ 抱歉, 禁止推薦          [按任意鍵繼續]');
    // vmsg 的 vkey() 迴圈要一個真按鍵才消得掉；**不該**送 Ctrl-C（沒有推文流程
    // 可以取消）。
    await expect.poll(() => sentText(page)).toBe('X ');
    expect(await sentText(page)).not.toContain('\x03');

    await drawArticle(page); // 橫幅消掉，FULLUPDATE 回來
    const msg = page.getByTestId('longPushErrorMessage');
    await expect(msg).toBeVisible();
    // 逐字，不改寫不翻譯（PTT 改版時我們要照樣轉達）。
    expect((await msg.textContent()).trim()).toBe('抱歉, 禁止推薦');
    await expect(page.getByTestId('longPushErrorSource')).toHaveText(
      await label(page, 'longPushError_sourcePtt')
    );
    // 使用者不該對著一個推不出去的板打一大段字。
    await expect(page.locator('[name="longPushText"]')).toHaveCount(0);
  });

  // 被擋下來的人只是按了 X，不該因此丟掉閱讀進度（PTT 原生會把他丟回文章列表）。
  test('探路被擋之後回到原文章，閱讀位置還原', async ({ page }) => {
    await boot(page);
    await collectSent(page);
    await ptt.sendKey(page, 'X');
    await expect.poll(() => sentText(page)).toBe('X');
    await drawLastRow(page, ' ◆ 抱歉, 禁止推薦          [按任意鍵繼續]');
    await drawLastRow(page, ARTICLE_FOOTER); // 橫幅消掉，人落在文章／列表
    // 收尾之後按 ⏎ 回文章。
    await expect.poll(() => sentText(page)).toBe('X \r');
    await drawArticle(page);

    await expect(page.getByTestId('longPushErrorMessage')).toBeVisible();
    // 人回到文章（原生按 X 被擋是留在文章列表的）。閱讀位置的還原本身在
    // tests/unit/long_push_preflight.test.js 驗（offline 的假文章只有一頁，
    // mainDisplay 根本捲不動）。
    expect(await page.evaluate(() => window.__app.buf.pageState)).toBe(3);
  });

  // 底列的 (X%)推文 按鈕走 App.onFunctionKey，**完全不經 term_view.onKeyDown**
  // ⇒ 兩條要各攔一次。tokenizeKeyGroup 把那組拆成兩顆按鈕，所以 % 那顆也驗。
  test('點底列的 (X)／(%) 推文按鈕 → 同樣走探路開輸入框', async ({ page }) => {
    await boot(page);
    await ptt.applyPrefs(page, {
      useMouseBrowsing: true,
      mouseLeftClick: true,
      mouseFunctionKeys: true,
    });
    await drawArticle(page);

    for (const key of ['X', '%']) {
      await collectSent(page);
      const btn = page.locator(`#mainContainer a.fnKey[data-fnkey="${key}"]`);
      await expect(btn).toHaveCount(1);
      await btn.click();
      // 兩顆按鈕都要走探路（線路上是狀態機送的 X，不是使用者那一顆的 byte）。
      await runPreflight(page);
      // 使用者那顆按鈕的 byte 沒有被原樣轉送：線路上只有探路那一個 X（後面那些
      // 是收尾的 Ctrl-C 與回文章的 ⏎）。% 那顆尤其要驗——漏攔的話會變成「點這顆
      // 是長推文、點旁邊那顆是原生」。
      //
      // 第二輪的 X 前面會多一個 ESC，那是**對的**：上一輪用 Escape 關輸入框，那一下
      // 會漏到終端機（Mantine 的 Escape handler 先跑，modalShown 那時已經翻成 false）
      // ⇒ server 的 vtkbd 停在 VKSTATE_ESC。機器鍵一律先補一個 ESC 化解才到得了
      // pmore；沒有它，這個 X 會被吃成 esc_arg、PTT 零反應 ——「讀不到文章代碼（miss）」
      // 就是這樣來的（回歸守在本檔最後一支與 tests/unit/vtkbd_send_state.test.js）。
      const sent = await page.evaluate(() => window.__sent);
      expect(sent[0]).toMatch(/^?X$/);
      expect(sent.filter((b) => b.indexOf('X') >= 0)).toHaveLength(1);
      expect(sent.join('')).not.toContain('%');
      // 收掉輸入框，下一輪重來。關框＝這次不推了 ⇒ 探路成果要丟掉，不然下一次
      // start() 會拿舊錨點去比對新畫面。
      await page.keyboard.press('Escape');
      await expect(page.locator('[name="longPushText"]')).toHaveCount(0);
      await expect
        .poll(() => page.evaluate(() => window.__app.longPush.busy))
        .toBe(false);
      await drawArticle(page);
    }
  });

  test('設定關掉攔截 → X 回到 PTT 原生推文（逃生門）', async ({ page }) => {
    await boot(page);
    await ptt.applyPrefs(page, { pushKeyOpensLongPush: false });
    await collectSent(page);

    await ptt.sendKey(page, 'X');
    await expect.poll(() => sentText(page)).toBe('X');
    await expect(page.locator('[name="longPushText"]')).toHaveCount(0);
    // 那個 X 是**使用者的 byte 直達**，不是探路 —— 兩者的差別在有沒有遮罩／
    // 有沒有人接手（關掉攔截後 longPush 完全沒被啟動）。
    await expect(page.getByTestId('longPushProgressStatus')).toHaveCount(0);
    expect(await page.evaluate(() => window.__app.longPush.busy)).toBe(false);
  });

  // 文章列表按 X 也是推文（bbs.c:4595 同一個 recommend），但**刻意不攔**：
  // LongPushSession 的游標錨點要從文章標頭取，在列表上取不到 ⇒ 攔了等於拆掉唯一
  // 擋住「推到別篇」的機制（long_push_gate.js 檔頭）。
  test('文章列表按 X 不攔，維持原生', async ({ page }) => {
    await boot(page);
    await drawBoardList(
      page,
      [
        boardListRow(1233, 'testuser', '[閒聊] 測試文章'),
        boardListRow(1234, 'someoneElse', '[公告] 別篇'),
        boardListRow(1235, 'thirdGuy', '[問卦] 又一篇'),
      ],
      0
    );
    await collectSent(page);

    await ptt.sendKey(page, 'X');
    await expect.poll(() => sentText(page)).toBe('X');
    await expect(page.locator('[name="longPushText"]')).toHaveCount(0);
    await expect(page.getByTestId('longPushProgressStatus')).toHaveCount(0);
    expect(await page.evaluate(() => window.__app.longPush.busy)).toBe(false);
  });

  // 「讀不到文章代碼（miss）」的根因回歸（錄製檔 ptt-debug-20260917-012944.json）。
  //
  // 使用者關掉長推文輸入框後順手多按一下 Esc：那時畫面上已經沒有任何彈窗，
  // modalShown 是 false ⇒ 那一下是**合法的終端機輸入**，源頭擋不住（想靠「有彈窗
  // 就不送鍵」修的話會發現關框那一下本來就擋得住，多按的那一下沒得擋）。
  // 於是 server 的 vtkbd 停在 VKSTATE_ESC，下一次按 X 時 CommandQueue 送出去的第一個
  // byte 會被吃成 esc_arg ⇒ 畫面零反應 ⇒ 700ms 後送  探針 ⇒ 判成 miss。
  //
  // 修法是把守門的預設反轉（機器送出一律化解，ESC 組合鍵的保護只留給真鍵盤）。
  // 純函式兩層都有 unit（vtkbd_send_state / telnet_esc_guard / user_key_send_wiring），
  // 這裡守的是 unit 碰不到的那條：**真 DOM keydown → term_view → telnet._vkState →
  // CommandQueue → WS**。
  test('關輸入框後漏出去的 Esc 不會吃掉下一次按 X', async ({ page }) => {
    await boot(page);
    await collectSent(page);

    // 第一輪：按 X 探路 → 輸入框開 → 取消關掉。
    await ptt.sendKey(page, 'X');
    await runPreflight(page);
    await page
      .locator('form')
      .getByRole('button', { name: await label(page, 'longPushModal_cancel') })
      .click();
    await expect(page.locator('[name="longPushText"]')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__app.modalShown)).toBe(false);

    await collectSent(page);
    // 順手多按的那一下 Esc。框已經關了 ⇒ 它本來就該送到 PTT。
    await ptt.sendKey(page, 'Escape');
    await expect.poll(() => sentText(page)).toBe('');

    // 再按一次 X：探路的第一個機器 byte 前面要補一個 ESC 化解，X 才到得了 pmore。
    await ptt.sendKey(page, 'X');
    await expect.poll(() => sentText(page)).toBe('' + 'X');
    // 而且探路真的走完：miss 的那條路會開錯誤框，這裡要開的是輸入框。
    await runPreflight(page);
    await expect(page.getByTestId('longPushErrorMessage')).toHaveCount(0);
  });

  test('游標還在原篇時不多送任何定位鍵', async ({ page }) => {
    await boot(page);
    await submitLongPush(page, '第一段\n第二段');
    await drawLastRow(page, TYPE_MENU);
    await drawLastRow(page, PROMPT);
    await drawLastRow(page, CONFIRM);

    await collectSent(page);
    await drawBoardList(
      page,
      [
        boardListRow(1233, 'someoneElse', '[公告] 別篇'),
        boardListRow(1234, 'testuser', '[閒聊] 測試文章'),
        boardListRow(1235, 'thirdGuy', '[問卦] 又一篇'),
      ],
      1
    );
    await expect.poll(() => sentText(page)).toBe('X');
  });

  // REGRESSION（使用者回報 + 錄製檔 ptt-debug-20260917-221112）：按 X 叫出長推文
  // 輸入框、然後**取消**，文章就再也不會往下讀到結尾。
  //
  // 根因是通知只有單向：好讀的自動翻頁被 easy_reading._wireBusy() 擋下時是延後
  // 不是丟棄，喚醒點只有 EasyReading.onWireIdle()，而那是接在 CommandQueue.onIdle
  // 上的。longPush.busy 卻是唯一一個 queue 管不到的來源 —— 探路成功後 _armed 一直
  // 活著（使用者在打字，線路真的空著），queue 早就空了、onIdle 也發過了，busy 要
  // 等到關框（disarm）才翻 false ⇒ 那一刻沒有人再通知好讀。沒送鍵就沒有新幀，
  // 不會再評估第二次 ⇒ 死結。
  //
  // 兩層 unit 各守一半（easy_reading_send_gate 的 force 補送、long_push_wire_release
  // 的 _releaseWire），這裡守的是 unit 碰不到的那條：**真的好讀狀態機 + 真的
  // CommandQueue + 真的 React 關框**串起來之後，那個 PageDown 真的上得了線路。
  test('取消長推文之後，好讀的自動翻頁要接得回去', async ({ page }) => {
    await boot(page);

    // 這支 spec 其他 case 的 drawArticle 刻意**不**把游標停在右下角（P6 的 complete
    // gate 不成立）⇒ 好讀不會送 PageDown，鍵序斷言才乾淨。這一條要的正好相反：
    // 一幀「完整的」文章畫面，好讀看到就會想翻頁。
    const drawArticleComplete = async (footer) => {
      await page.evaluate(
        ({ rows, footer }) => {
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
          let d = '\x1b[2J';
          for (const k of Object.keys(rows))
            d += '\x1b[' + (Number(k) + 1) + ';1H' + u2b(rows[k]);
          d += '\x1b[24;1H' + u2b(footer);
          // P6：只有游標停在右下角的那一幀才是「完整的 server 回應」。
          d += '\x1b[24;80H';
          window.__app.onData(d);
        },
        { rows: { 0: ARTICLE_HEADER, 1: ARTICLE_TITLE, 20: ARTICLE_URL }, footer }
      );
      await page.waitForTimeout(300);
    };
    const footerAt = (page1, page2, pct, start, end) =>
      `  瀏覽 第 ${page1}/${page2} 頁 (${String(pct).padStart(3)}%)  ` +
      `目前顯示: 第 ${start}~${end} 行  (y)回應(X%)推文(h)說明(←)離開 `;

    // 好讀是在「列表(2) → 文章(3)」的 settle 邊緣自動開的，boot() 直接畫文章沒有
    // 那道邊緣 ⇒ 要先過一次列表。
    await drawBoardList(
      page,
      [
        boardListRow(1233, 'someoneElse', '[公告] 別篇'),
        boardListRow(1234, 'testuser', '[閒聊] 測試文章'),
        boardListRow(1235, 'thirdGuy', '[問卦] 又一篇'),
      ],
      1
    );
    await drawArticleComplete(footerAt(1, 3, 33, '01', '23'));
    await expect
      .poll(() => page.evaluate(() => window.__app.view.useEasyReadingMode))
      .toBe(true);

    // 探路 → 輸入框開著（_armed 活著 ⇒ busy 為 true）。
    await collectSent(page);
    await ptt.sendKey(page, 'X');
    await runPreflight(page);
    expect(await page.evaluate(() => window.__app.longPush.busy)).toBe(true);

    // 輸入框開著時來了一幀完整的文章畫面（真實情境：探路收尾按 ⏎ 回文章那一幀，
    // 它同時也讓好讀退出鏡像原生模式）。好讀想翻頁，但被 longPush.busy 擋下來
    // —— 這是**正確**的，不可以讓它插進長推文的線路。
    await collectSent(page);
    await drawArticleComplete(footerAt(2, 3, 66, '24', '46'));
    await expect.poll(() => sentText(page)).toBe('');

    // 使用者按取消。這一刻 busy 翻 false，而 queue 早就空了。
    await page
      .locator('form')
      .getByRole('button', { name: await label(page, 'longPushModal_cancel') })
      .click();
    await expect(page.locator('[name="longPushText"]')).toHaveCount(0);
    expect(await page.evaluate(() => window.__app.longPush.busy)).toBe(false);

    // 修好之前：這裡永遠是空字串，文章就此卡住。
    await expect.poll(() => sentText(page)).toContain('\x1b[6~');
  });
});
