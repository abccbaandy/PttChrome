// live 核心煙霧測試（連真 PTT，整輪只登入一次）。
//
// 定位（2026-10 使用者定案）：PTT 有登入額度限制，live 不能像 offline 一樣反覆跑到綠，
// 所以 live **只保證核心功能**：登入、主選單／文章列表／文章 不跑版不亂碼、開圖。
// 其餘功能一律由 offline（cassette 重放）守；live 每輪自動錄一份 DebugRecorder 錄製檔
// （helpers/fixtures.js → tests/e2e/__recordings__/），新版面／新協定在這裡紅了之後，
// 拿錄製檔到 offline 修。
//
// 規則：
//   - **不比對畫面內容**（PTT 近期改版頻繁）。版面判準全部是渲染不變量
//     （helpers/screen_sanity.js：DOM＝buf、格線對齊、Big5 可解、無水平溢出），
//     畫面是哪一種由 app 自己的分類器（buf.pageState）判定。
//   - 唯一寫死的是**選文條件**：Stock 板標題搜尋「盤後閒聊」取最新一篇（長文＋圖多，
//     天天有新的 ⇒ 不會過期）。
//   - 等待一律綁內容／狀態條件（pageState、waitEasyReadingComplete、seekMountedPreview）。
const { test, expect } = require('./helpers/fixtures');
const {
  sendKey,
  applyPrefs,
  resetSession,
  gotoBoard,
  waitEasyReadingComplete,
} = require('./helpers/ptt');
const { seekMountedPreview } = require('./helpers/layout');
const { screenSanity, describeSanity, expectScreenSane } = require('./helpers/screen_sanity');

const BOARD = 'Stock';
const SEARCH = '盤後閒聊';

// 會被 ImagePreviewer 解析成圖片的連結（直連圖檔與 imgur）。
const IMAGE_LINK =
  /(\.(?:jpe?g|png|gif|webp|bmp|apng|avif)(?:$|[?#:]))|imgur\.com|pbs\.twimg\.com/i;

const pageState = (page) => page.evaluate(() => window.__app.buf.pageState);
const waitPageState = (page, want, timeout = 20000) =>
  page.waitForFunction((w) => window.__app.buf.pageState === w, want, { timeout });

// 畫面 settle（30ms notify＋50ms settle）跑完才量：DOM 比 buf 慢一幀。
const waitSettled = (page) =>
  page.waitForFunction(() => {
    const buf = window.__app.buf;
    return !buf.timerUpdate && !buf._settleTimer;
  });

async function checkScreen(page, label, opts) {
  await waitSettled(page);
  const r = await screenSanity(page, opts);
  console.log(describeSanity(r, label));
  expectScreenSane(r, label);
  return r;
}

// Stock → `/` 盤後閒聊 → End（最新一篇）。停在搜尋結果列表、游標在那一篇。
// `/` 走預設的搜尋彈窗（docs/article-search.md）：這是唯一能在真 PTT 上驗「搜尋鍵 →
// 等 prompt 幀（read.c 的字串指紋）→ 才送關鍵字」整條鏈的地方，不多花登入。
async function gotoLatestThread(page) {
  await gotoBoard(page, BOARD);
  await sendKey(page, 'Slash');
  const box = page.locator('input[name="searchKeyword"]');
  await box.waitFor({ state: 'visible', timeout: 10000 });
  await box.fill(SEARCH);
  await box.press('Enter');
  // 送出是兩步（`/` → 等 prompt → 關鍵字），在途期間鍵盤被閘門吞掉 ⇒ 等產品自己的
  // searchInFlight 收尾，不能只看「列表＋游標不在輸入欄」（送出前那一刻就成立）。
  await page.waitForFunction(
    () =>
      window.__app.searchInFlight === false &&
      window.__app.buf.pageState === 2 &&
      !window.__app.buf.isCursorOnInputField(),
    null,
    { timeout: 20000 }
  );
  await sendKey(page, 'End');
  const cursorRow = () =>
    page.evaluate(() => {
      const buf = window.__app.buf;
      return buf.getRowText(buf.cur_y, 0, buf.cols);
    });
  await expect
    .poll(cursorRow, { message: '搜尋結果的游標列要是那篇（搜尋沒命中？）', timeout: 15000 })
    .toContain(SEARCH);
  await waitSettled(page);
}

test.describe.serial('核心功能（live）', () => {
  test('登入：開站即到主選單，主選單不跑版／不亂碼', async ({ shared }) => {
    const { page, boot } = shared;
    // 有帳密時這一次開機就是產品的自動登入（完全不按鍵）；guest 時是手動 login()。
    if (process.env.PTT_USER && process.env.PTT_PASS) expect(boot.auto).toBe(true);
    expect(await pageState(page)).toBe(1);
    await checkScreen(page, 'main-menu');
  });

  test('文章列表：原生與列表好讀都不跑版／不亂碼，產品解析器認得列表列', async ({ shared }) => {
    test.setTimeout(120000);
    const { page } = shared;
    await resetSession(page);
    await gotoBoard(page, BOARD);
    expect(await pageState(page)).toBe(2);
    await checkScreen(page, 'list-native');

    // 解析器健康度（取代以前寫死欄位 17-28 的 live 測項）：有序號的列，產品自己的
    // parseListAuthor 要認得出大多數（data-list-author，右鍵加黑名單的依據）。PTT 改了
    // 列表欄位就會在這裡紅，而不是靜默讓黑名單失效。
    const health = await page.evaluate(() => {
      const buf = window.__app.buf;
      let numbered = 0;
      for (let r = 0; r < buf.rows; r++)
        if (/^[>\s●]*\d+\s/.test(buf.getRowText(r, 0, buf.cols))) numbered++;
      const authors = document.querySelectorAll('#mainContainer [data-list-author]').length;
      return { numbered, authors };
    });
    console.log('LIST PARSER:', JSON.stringify(health));
    expect(health.numbered).toBeGreaterThan(0);
    expect(health.authors).toBeGreaterThanOrEqual(Math.ceil(health.numbered * 0.7));

    // 列表好讀（預設開）：engage → 補頁 → 檢查捲動視窗。
    await applyPrefs(page, { enableEasyReadingList: true });
    await page.waitForFunction(
      () =>
        window.__app.listSession.state === 'active' &&
        window.__app.buf.listRenderMode === 'buffer' &&
        window.__app.commandQueue.idle,
      null,
      { timeout: 45000 }
    );
    const r = await checkScreen(page, 'list-easy-reading');
    expect(r.listWindow).toBe(true);
  });

  test('文章：原生不跑版／不亂碼', async ({ shared }) => {
    test.setTimeout(120000);
    const { page } = shared;
    await resetSession(page);
    await gotoLatestThread(page);
    await sendKey(page, 'Enter');
    await waitPageState(page, 3);
    await checkScreen(page, 'article-native');
  });

  test('文章：好讀不跑版／不亂碼，行內圖片載得出來', async ({ shared }) => {
    test.setTimeout(300000);
    const { page } = shared;
    await resetSession(page);
    // 合併同作者推文會把多列併成一塊（DOM 不再逐列對應 buf），那條路徑由 offline 守。
    await applyPrefs(page, { enableEasyReading: true, mergeSameAuthorComments: false });
    await gotoLatestThread(page);
    await sendKey(page, 'Enter');
    // 盤後閒聊很長：等累積完（好讀在累積時會控 scrollTop，量版面／捲去開圖會打架）。
    const acc = await waitEasyReadingComplete(page, { timeout: 240000 });
    console.log('ACCUMULATE:', JSON.stringify(acc));
    expect(acc.reachedEnd, '好讀沒有累積到文末').toBe(true);
    expect(await page.evaluate(() => window.__app.view.useEasyReadingMode)).toBe(true);
    const r = await checkScreen(page, 'article-easy-reading', { maxRows: 400 });
    expect(r.er).toBe(true);

    // 開圖：有圖片連結就必須有佔位盒 → 捲過去會 mount → 至少一張真的畫出來。
    // 試多張：單一圖床偶發失敗不算產品壞；全部載不出來才是。
    const seek = await seekMountedPreview(page, {
      hrefFilter: IMAGE_LINK,
      maxSlots: 8,
      mountTimeout: 20000,
      mediaTimeout: 30000,
    });
    console.log('IMAGE SEEK:', JSON.stringify(seek));
    expect(seek.slots, '這篇沒有圖片連結（選文條件失效？）').toBeGreaterThan(0);
    expect(seek.mounted).toBe(true);
    expect(seek.loadedImage, '試過的圖片一張都沒畫出來').toBe(true);
  });
});
