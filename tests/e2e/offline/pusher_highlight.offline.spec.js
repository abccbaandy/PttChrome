// 推文者高亮（點推文列 → 該作者的每一則整列上色）的離線重放守門。
//
// 這裡鎖的是**機制**而不只是顏色：高亮曾經是 annotation 的一個欄位，而
// selectedPusher 進了 screen_annotate_cache.annotationsKey ⇒ 點一下推文列就讓整份
// 好讀累積長頁全量重算 ＋ 每一列節點重建。兩個使用者實際回報的症狀：
//   1. 每個 inlinePreviewSlot 被 disposeNode 收掉重建（新 slot 的 pinned=null ⇒
//      minHeight 歸零）⇒ 圖片佔位盒塌陷成 0 高、等非同步流程再撐回來
//      ＝「合併推文的空白區域閃爍，閃爍時可隱約看到其他行的推文」。
//   2. 節點抽換發生在雙擊的第二個 mousedown **之前** ⇒ 瀏覽器的雙擊選詞落在已被
//      換掉的節點／位移後的版面上 ＝「雙擊選字時好時壞」。
//
// 穩定的回歸守護是 (a)「節點零抽換」——它是上面兩個症狀共同的因，且與時序無關。
// (b) 的雙擊在舊 code 下是**間歇**紅（＝使用者說的時好時壞），別因為它偶爾綠就以為
// 修好了。純邏輯層另有 tests/unit/screen_incremental_render.test.js 的三條。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const {
  findCassette,
  bootOffline,
  replayCassette,
  mountLazyPreviewsAt,
} = require('../helpers/replay');
// 量座標前一律先等版面停。這支 spec 的 commentRow 原本是 mouse.offline 修好之前的那一份
// 拷貝（scrollIntoView → 立刻量 → 用舊座標點），而它跑的還是全套件裡預覽最密的設定
//（mergeSameAuthorComments: true）—— 同一個 bug 在這裡原封不動地活著。判準已收斂到
// helpers/layout.js。
const {
  assertElementUnder,
  stableCommentRow,
  waitPreviewsSettled,
} = require('../helpers/layout');

const article = findCassette('article');

// 點擊前的最後一道：指標底下真的還是那一列推文嗎？版面若在量測之後又位移，這裡會
// 直接指出來，而不是讓 `expect(on.length).toBeGreaterThan(0)` 退化成沉默的 0。
const assertUnderRow = (page, row) =>
  assertElementUnder(page, row.contentX, row.y, row.pusher, {
    closest: '[data-pusher]',
    attribute: 'data-pusher',
  });

// 點擊前替每個 bbsrow 掛一個 JS expando —— 節點被抽換掉它就跟著消失（DOM 屬性做
// 不到這件事：重建出來的節點會有一模一樣的屬性）。
const markRows = (page) =>
  page.evaluate(() => {
    const rows = document.querySelectorAll('#mainContainer span[type="bbsrow"]');
    rows.forEach((el, i) => {
      el.__e2eMark = i;
    });
    return rows.length;
  });

const survivedMarks = (page) =>
  page.evaluate(
    () =>
      Array.from(
        document.querySelectorAll('#mainContainer span[type="bbsrow"]')
      ).filter((el) => el.__e2eMark !== undefined).length
  );

// 版面快照：捲動位置、內容總高、目前掛著的佔位盒高度。整批節點重建時三者都會動。
const layout = (page) =>
  page.evaluate(() => {
    const main = window.__app.view.mainDisplay;
    return {
      scrollTop: main.scrollTop,
      scrollHeight: main.scrollHeight,
      slots: Array.from(document.querySelectorAll('.inlinePreviewSlot')).map(
        (n) => n.offsetHeight
      ),
    };
  });

const highlighted = (page) =>
  page.evaluate(() =>
    Array.from(
      document.querySelectorAll('#mainContainer .pusherHighlight')
    ).map((el) => el.getAttribute('data-pusher'))
  );

const selectionInfo = (page) =>
  page.evaluate(() => {
    const sel = window.getSelection();
    return { isCollapsed: sel.isCollapsed, text: sel.toString() };
  });

async function boot(page) {
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, {
    enableEasyReading: true,
    showFloorNumbers: true,
    useMouseBrowsing: true,
    mouseLeftClick: true,
    mouseMisclickGuard: true,
    // 合併塊在場才是 bug 回報的現場（塊內的圖最多）。
    mergeSameAuthorComments: true,
  });
  await replayCassette(page, article, { easyReading: true });
  // 佔位盒是延遲載入的：不先捲進視野，量到的永遠是空盒。
  await mountLazyPreviewsAt(page, '#mainContainer');
  await waitPreviewsSettled(page);
}

test.describe('推文者高亮（offline）', () => {
  test.skip(!article, '尚無 article cassette；先 yarn record:cassette');

  test('點推文列：高亮生效，但不得重建任何一列節點、版面不得跳動', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await boot(page);

    const row = await stableCommentRow(page, { capHalfRow: true });
    const marks = await markRows(page);
    expect(marks).toBeGreaterThan(0);
    const before = await layout(page);

    await assertUnderRow(page, row);
    await page.mouse.click(row.contentX, row.y);
    await page.waitForTimeout(400);

    // 高亮真的上了，而且只上在同一個人身上。
    const on = await highlighted(page);
    expect(on.length).toBeGreaterThan(0);
    on.forEach((p) => expect(p).toBe(row.pusher));

    // 核心不變量：一個節點都沒被換掉。
    expect(await survivedMarks(page)).toBe(marks);

    const after = await layout(page);
    expect(after.scrollTop).toBe(before.scrollTop);
    // 佔位盒沒有塌陷 ⇒ 內容總高不變（延遲載入自己的微幅變動留 5% 餘裕）。
    expect(after.scrollHeight).toBeGreaterThan(before.scrollHeight * 0.95);
    expect(after.slots.length).toBe(before.slots.length);
    after.slots.forEach((h, i) => expect(h).toBe(before.slots[i]));
  });

  test('再點同一列：高亮清除，節點依舊零抽換', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);

    const row = await stableCommentRow(page, { capHalfRow: true });
    const marks = await markRows(page);

    await assertUnderRow(page, row);
    await page.mouse.click(row.contentX, row.y);
    await page.waitForTimeout(300);
    expect((await highlighted(page)).length).toBeGreaterThan(0);

    await assertUnderRow(page, row);
    await page.mouse.click(row.contentX, row.y);
    await page.waitForTimeout(300);
    expect(await highlighted(page)).toEqual([]);
    expect(await survivedMarks(page)).toBe(marks);
  });

  test('在推文列上雙擊：選得到字（不被高亮的重繪打斷）', async ({ page }) => {
    test.setTimeout(90000);
    await boot(page);

    const row = await stableCommentRow(page, { capHalfRow: true });
    const marks = await markRows(page);

    await assertUnderRow(page, row);
    await page.mouse.dblclick(row.contentX, row.y);
    await page.waitForTimeout(300);

    const info = await selectionInfo(page);
    expect(info, `雙擊後的選取狀態: ${JSON.stringify(info)}`).toMatchObject({
      isCollapsed: false,
    });
    expect(info.text.length).toBeGreaterThan(0);
    // 選到的內容確實來自被點的那一列（不是別處的殘留選取）。
    expect(row.text).toContain(info.text.trim());
    // 症狀的因：雙擊期間不得有節點被抽換。
    expect(await survivedMarks(page)).toBe(marks);
  });
});
