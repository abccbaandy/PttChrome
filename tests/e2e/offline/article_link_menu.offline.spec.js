// 右鍵選單對「文章代碼連結 / ptt.cc 文章網址」的兩個新選項，以及那個
// href="#" 造成的舊 bug —— 離線重放守門（真瀏覽器 / 真渲染 / 零網路）。
//
// 回歸來源：好讀模式的文章代碼連結（Row/LinkSegmentBuilder）href 寫死成佔位的
// "#"（導航靠 onClick + preventDefault）。右鍵端只看 tagName === 'A' 就把
// getAttribute('href') 當成網址：
//   - 「複製連結網址」複製到一個孤零零的 '#'；
//   - urlEnabled 變 true ⇒ 整組 normalEnabled 項目（含「複製本篇文章連結」）
//     全部消失。
// 修法：ContextMenu 用 class 認出 aidLink 並排除，改走 data-aid / data-board
// 推出的 contextArticle（src/js/article_link_target.js）。
//
// 為什麼要 e2e：判斷吃的是**真的 DOM**（classList / data-*），而且「選單裡有哪些
// 項目」是 React 依 urlEnabled/normalEnabled/contextArticle 三個旗標算出來的組合
// —— 純邏輯測得到 target 推導，測不到那個組合。
//
// 素材注入手法沿用 url-fragment-aid.offline.spec.js（AID 連結只在好讀模式偵測，
// 見 Screen#detectRowExtras 的 `easyReading && onAidClick` gate）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const {
  findCassette,
  bootOffline,
  replayCassette,
  feedRaw,
} = require('../helpers/replay');

const cassette = findCassette('article');

const AID = '1gIeu-3A';
// 同一篇的檔名形式（分享連結的正規形式）。換算對照守在 tests/unit/aid_codec.test.js。
const FN = 'M.1783270974.A.0CA.html';
const BOARD = 'movie';
// 內文裡真正的 ptt.cc 文章網址（另一條進入 contextArticle 的路）。
const PTT_URL = 'https://www.ptt.cc/bbs/Browsers/M.1786265274.A.5E3.html';
const PTT_URL_AID = '1gU3wwNZ';

const label = (page, key) => page.evaluate(k => window.__i18n(k), key);

async function stubClipboard(page) {
  await page.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: t => {
          window.__copied.push(String(t));
          return Promise.resolve();
        },
      },
    });
  });
}

async function setupRows(page) {
  await page.evaluate(() => window.__app.easyReading.enterEasyReading());
  await page.waitForTimeout(200);
  const { rows, cols } = await page.evaluate(() => ({
    rows: window.__app.buf.rows,
    cols: window.__app.buf.cols,
  }));
  const blank = ' '.repeat(cols - 1);
  const at = (r, text) => `\x1b[${r};1H${blank}\x1b[${r};1H${text}`;
  await feedRaw(
    page,
    at(10, `ref #${AID} (${BOARD}) there`) +
      at(11, 'url ' + PTT_URL + ' here') +
      `\x1b[${rows};${cols}H`
  );
  await page.waitForTimeout(800);
}

// 對某個 <a> 派發 contextmenu（真滑鼠右鍵在 headless 下座標對位太脆，
// 同 quick_search / ui_behavior 的手法）。
async function rightClickAnchor(page, selector) {
  await page.evaluate(sel => {
    const a = document.querySelector(sel);
    if (!a) throw new Error('未渲染到畫面，測試前提失效: ' + sel);
    a.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 10 })
    );
  }, selector);
  await expect(page.locator('.DropdownMenu').first()).toBeVisible();
}

const itemByText = (page, text) =>
  page.locator('.DropdownMenu').first().getByText(text, { exact: true });

async function boot(page) {
  await stubClipboard(page);
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, { enableEasyReading: true });
  await replayCassette(page, cassette, { easyReading: false });
  await setupRows(page);
}

test.describe('文章連結的右鍵選單（離線重放）', () => {
  if (!cassette) {
    test.skip('尚無 article cassette；先 yarn record:cassette', () => {});
    return;
  }

  test('右鍵文章代碼連結：不再誤判成網址，兩個文章選項出現', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);

    // 前提：那一列真的被畫成 aidLink（不然下面「沒有複製連結網址」是假綠）。
    await expect(page.locator('a.aidLink')).toHaveCount(1);
    await rightClickAnchor(page, 'a.aidLink');

    // REGRESSION：href="#" 不是網址，這兩項都不該出現。
    await expect(itemByText(page, await label(page, 'cmenu_copyLinkUrl'))).toHaveCount(0);
    await expect(itemByText(page, await label(page, 'cmenu_openUrlNewTab'))).toHaveCount(0);
    // REGRESSION：normalEnabled 被誤關的話這一項會整個消失。
    await expect(
      itemByText(page, await label(page, 'cmenu_copyArticleLink'))
    ).toHaveCount(1);
    // 新選項。
    await expect(
      itemByText(page, await label(page, 'cmenu_copyArticleAid'))
    ).toHaveCount(1);
    await expect(
      itemByText(page, await label(page, 'cmenu_copyArticleDeepLink'))
    ).toHaveCount(1);
  });

  test('複製文章代碼 → 帶看板的 PTT 慣用寫法', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);
    await rightClickAnchor(page, 'a.aidLink');
    await itemByText(page, await label(page, 'cmenu_copyArticleAid')).click();

    await expect
      .poll(() => page.evaluate(() => window.__copied))
      .toEqual([`#${AID} (${BOARD})`]);
  });

  test('複製文章分享連結 → 檔名形式的本站 deep link', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);
    await rightClickAnchor(page, 'a.aidLink');
    await itemByText(page, await label(page, 'cmenu_copyArticleDeepLink')).click();

    await expect
      .poll(() => page.evaluate(() => window.__copied))
      .toHaveLength(1);
    const copied = await page.evaluate(() => window.__copied[0]);
    // 本站的連結（origin + pathname 照抄目前頁面），hash 是檔名形式。
    // 對照值 1gIeu-3A ⇄ M.1783270974.A.0CA 守在 aid_codec.test.js。
    const base = await page.evaluate(
      () => window.location.origin + window.location.pathname
    );
    expect(copied).toBe(`${base}#${BOARD}/${FN}`);
  });

  test('右鍵內文裡的 ptt.cc 文章網址：原有兩項 ＋ 兩個新選項', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);
    await rightClickAnchor(page, `a.y[href="${PTT_URL}"]`);

    // 它是真的網址 ⇒ 原有兩項照舊在。
    await expect(itemByText(page, await label(page, 'cmenu_copyLinkUrl'))).toHaveCount(1);
    await expect(itemByText(page, await label(page, 'cmenu_openUrlNewTab'))).toHaveCount(1);
    await itemByText(page, await label(page, 'cmenu_copyArticleAid')).click();

    await expect
      .poll(() => page.evaluate(() => window.__copied))
      .toEqual([`#${PTT_URL_AID} (Browsers)`]);
  });

  // REGRESSION：selEnabled 曾被寫成 `!normalEnabled`，於是「在連結上、又沒選取
  // 任何文字」也被當成有選取 ⇒ 畫出「複製」「複製 (包含 ANSI 顏色)」，但
  // selectedText 是空字串 ⇒ 點了什麼都不會發生。純邏輯守在
  // tests/unit/context_menu_items.test.js#menuTargetFlags，這裡守真 DOM 的組合。
  test('右鍵連結但沒有選取文字 → 不出現點了沒作用的「複製」', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await rightClickAnchor(page, `a.y[href="${PTT_URL}"]`);

    await expect(itemByText(page, await label(page, 'cmenu_copy'))).toHaveCount(0);
    await expect(itemByText(page, await label(page, 'cmenu_copyAnsi'))).toHaveCount(0);
    // 前提：選單真的開著（不然上面兩條是假綠）。
    await expect(itemByText(page, await label(page, 'cmenu_copyLinkUrl'))).toHaveCount(1);
  });

  // 選單裡的預覽必須就是**真的會被複製的字串**（同一個 copyTextFor），不然使用者
  // 看到 A、複製到 B。純邏輯守在 tests/unit/context_menu_items.test.js，這裡守
  // 「畫出來的那一行 == 點下去進剪貼簿的那一份」。
  test('複製預覽 == 實際複製到的內容', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);
    await rightClickAnchor(page, 'a.aidLink');

    const aidLabel = await label(page, 'cmenu_copyArticleAid');
    const item = page
      .locator('.DropdownMenu .mantine-Menu-item')
      .filter({ hasText: aidLabel });
    const preview = await item.locator('.DropdownMenu__preview').textContent();
    expect(preview).toBe(`#${AID} (${BOARD})`);

    await item.click();
    await expect
      .poll(() => page.evaluate(() => window.__copied))
      .toEqual([preview]);
  });

  // 兩個小幫手預設不顯示（enableInputHelper / enableLiveArticleHelper），
  // 手法與圖片上傳同源：開選單當下現讀偏好。
  test('輸入小幫手／Live 文小幫手：預設不在選單，開了才出現', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);
    // 空白處右鍵（normalEnabled 那一組才有這兩項）。
    await page.evaluate(() => {
      document
        .getElementById('BBSWindow')
        .dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 10 })
        );
    });
    await expect(page.locator('.DropdownMenu').first()).toBeVisible();
    await expect(
      itemByText(page, await label(page, 'cmenu_showInputHelper'))
    ).toHaveCount(0);
    await expect(
      itemByText(page, await label(page, 'cmenu_showLiveArticleHelper'))
    ).toHaveCount(0);

    await page.keyboard.press('Escape');
    await ptt.applyPrefs(page, {
      enableInputHelper: true,
      enableLiveArticleHelper: true,
    });
    await page.evaluate(() => {
      document
        .getElementById('BBSWindow')
        .dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 10 })
        );
    });
    await expect(page.locator('.DropdownMenu').first()).toBeVisible();
    await expect(
      itemByText(page, await label(page, 'cmenu_showInputHelper'))
    ).toHaveCount(1);
    await expect(
      itemByText(page, await label(page, 'cmenu_showLiveArticleHelper'))
    ).toHaveCount(1);
  });
});
