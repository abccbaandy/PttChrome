// 跳過進板畫面（src/js/board_note_skip.js，pref skipBoardEntryScreen）—— 真瀏覽器＋完整 boot 鏈。
//
// unit（tests/unit/board_note_skip.test.js）蓋掉判斷與狀態機；這裡守的是 unit 摸不到的接線：
// 送出出口（telnet._sendEscaped → onDataSent）真的 arm 得起來、settle listener 的順序讓代按的鍵
// 排得上同一條 CommandQueue、好讀沒有把進板公告當文章開。
//
// 素材：tests/e2e/cassettes/scn-board-note-movie.json —— 由使用者錄製檔
// ptt-debug-20261008-105506 轉出（Android 板的動畫進板畫面，播完是「請按任意鍵繼續」），
// 首幀改成合成的單列看板列表（原檔首幀是使用者的我的最愛，不入 repo）。重放時整段動畫
// 一次餵完 ⇒ 落在 pressanykey；動畫中送 q 的分支由 unit 守。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootScenario, waitFed, waitScreenSettled } = require('../helpers/replay');

const cas = loadCassette('scn-board-note-movie');
// 全合成的小卷（主功能表 → s → 選擇看板 prompt），接上面那卷的動畫／文章列表 recv：
// 驗「主選單 s → 搜尋彈窗送出板名 ⏎」這條 arm 路徑（live 的 gotoBoard 走的就是它）。
const sel = loadCassette('scn-board-note-select');
const selectCassette = () =>
  sel &&
  cas && {
    ...sel,
    steps: [
      ...sel.steps,
      // 彈窗送出的是「板名＋⏎」一整串（article_search.buildSearchSteps）。
      { on: 'raw', send: Buffer.from('Android\r').toString('base64'), recv: cas.steps[1].recv },
      cas.steps[2],
    ],
  };

const screenState = (page) =>
  page.evaluate(() => {
    const app = window.__app;
    const b = app.buf;
    return {
      row0: b.getRowText(0, 0, b.cols),
      last: b.getRowText(b.rows - 1, 0, b.cols),
      sent: window.__replay.sent.slice(),
      fed: window.__replay.fed,
      active: app.boardNoteSkip.active,
      queueIdle: app.commandQueue.idle,
      easyReading: !!b.startedEasyReading,
    };
  });

test.describe('跳過進板畫面（scenario 重放）', () => {
  test('看板列表 Enter → 動畫進板畫面 ⇒ 自動代按一鍵，直接落在文章列表', async ({ page }) => {
    test.skip(!cas, '缺 scn-board-note-movie');
    // 好讀開著才驗得到「進板公告沒有被當成文章開」。
    await bootScenario(page, ptt, cas, { prefs: { enableEasyReading: true } });
    expect((await screenState(page)).row0).toContain('看板列表');

    await ptt.sendKey(page, 'Enter');
    await waitFed(page, cas.steps.length);
    await waitScreenSettled(page, { 0: '看板《Android》' });
    await expect.poll(async () => (await screenState(page)).queueIdle).toBe(true);

    const s = await screenState(page);
    expect(s.last).toContain('文章選讀');
    expect(s.active).toBe(false);
    expect(s.easyReading).toBe(false);
    // 代按的鍵恰好一個（pressanykey ⇒ 空白，fullRepaint 尾附 \f），沒有多送任何鍵落進文章列表。
    expect(s.sent).toEqual(['\r', ' \f']);
  });

  test('主選單 s → 搜尋彈窗送出板名 → 進板畫面 ⇒ 同樣自動代按', async ({ page }) => {
    const c = selectCassette();
    test.skip(!c, '缺 scn-board-note-select／scn-board-note-movie');
    await bootScenario(page, ptt, c);
    expect((await screenState(page)).row0).toContain('主功能表');

    await ptt.sendKey(page, 's');
    const box = page.locator('input[name="searchKeyword"]');
    await expect(box).toBeVisible();
    await box.fill('Android');
    await box.press('Enter');
    await waitFed(page, c.steps.length);
    await waitScreenSettled(page, { 0: '看板《Android》' });
    await expect.poll(async () => (await screenState(page)).queueIdle).toBe(true);

    const s = await screenState(page);
    expect(s.active).toBe(false);
    expect(s.sent).toEqual(['s\f', 'Android\r', ' \f']);
  });

  test('pref 關 ⇒ 停在進板畫面，一個鍵都不代按', async ({ page }) => {
    test.skip(!cas, '缺 scn-board-note-movie');
    await bootScenario(page, ptt, cas, { prefs: { skipBoardEntryScreen: false } });

    await ptt.sendKey(page, 'Enter');
    await waitFed(page, 2);
    await waitScreenSettled(page);
    await expect.poll(async () => (await screenState(page)).queueIdle).toBe(true);

    const s = await screenState(page);
    expect(s.last).toContain('請按任意鍵繼續');
    expect(s.active).toBe(false);
    expect(s.sent).toEqual(['\r']);
    expect(s.fed).toBe(2);
  });
});
