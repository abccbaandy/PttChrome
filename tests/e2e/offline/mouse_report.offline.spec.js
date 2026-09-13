// XTerm SGR 滑鼠回報的端到端守護 —— 離線重放，真瀏覽器、真渲染、完整 boot 鏈。
//
// unit 已經鎖了編碼、狀態機與 App.mouse_click 的分派（mouse_report_*.test.js），
// 這裡鎖的是那些只有整條鏈跑起來才看得見的事：
//   1. 主機宣告的序列真的穿過 WebSocket → AnsiParser → TermBuf.mouseReport
//      （unit 用的是 stub termbuf，證不到這一段）；
//   2. 點擊真的把 SGR 寫上線，而且**恰好一對**（不是每個 mousedown/mouseup 各一份）；
//   3. 座標對得上真實的格線幾何（unit 的 clientToPos 是 mock）；
//   4. **原生行為沒被弄壞**：選字仍然選得到、右鍵仍然是我們的選單。
//      這條是 CLAUDE.md 的硬規則，也是整個 Phase C 風險最高的地方。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const {
  findCassette,
  bootOffline,
  replayListCassette,
} = require('../helpers/replay');

const list = findCassette('list');

// mbbsd/term.c:79-118 的 MOUSE_MODE_CLICK 實際字串，逐字抄。
const ENABLE_CLICK = '\x1b[?1003l\x1b[?1000h\x1b[?1006h';
// 沒有 UF_MOUSE 的使用者實際會收到的關閉四連。
const DISABLE_ALL = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l';

async function startCapture(page) {
  await page.evaluate(() => {
    window.__sentLog = [];
    window.__stubWSSent = (s) => window.__sentLog.push(s);
  });
}
async function takeCapture(page) {
  return page.evaluate(() => {
    const out = window.__sentLog.join('');
    window.__sentLog = [];
    return out;
  });
}

// 讓 server「宣告」它要滑鼠回報：直接餵進 app 的收資料入口，走真 parser。
async function feedRaw(page, bytes) {
  await page.evaluate((b) => window.__app.onData(b), bytes);
}

// 終端機 (col, row) 格子中心的畫面座標（與 mouse.offline.spec.js 同一套）。
async function cellXY(page, col, row) {
  return page.evaluate(
    ({ c, r }) => {
      const v = window.__app.view;
      return {
        x: parseFloat(v.firstGridOffset.left) + v.chw * (c + 0.5),
        y: parseFloat(v.firstGridOffset.top) + v.chh * (r + 0.5),
      };
    },
    { c: col, r: row },
  );
}

test.describe('滑鼠回報給 PTT server（離線重放）', () => {
  if (!list) {
    test.skip('尚無 list cassette；先 yarn record:cassette', () => {});
  }

  test.beforeEach(async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableEasyReadingList: false,
      useMouseBrowsing: true,
      mouseLeftClick: true,
      mouseServerReport: true,
    });
    await replayListCassette(page, list);
  });

  test('主機開啟 tracking 後，點一下恰好送出一對 SGR', async ({ page }) => {
    test.setTimeout(90000);
    await feedRaw(page, ENABLE_CLICK);
    expect(
      await page.evaluate(() => window.__app.buf.mouseReport.isActive()),
    ).toBe(true);

    await startCapture(page);
    const { x, y } = await cellXY(page, 4, 9);
    await page.mouse.click(x, y);
    await page.waitForTimeout(100);

    // 恰好一對 press+release，座標是 1-based 的 (5, 10)。
    expect(await takeCapture(page)).toBe('\x1b[<0;5;10M\x1b[<0;5;10m');
  });

  test('主機沒開 tracking ⇒ 一個 byte 都不送（走回原本的滑鼠瀏覽）', async ({ page }) => {
    test.setTimeout(90000);
    expect(
      await page.evaluate(() => window.__app.buf.mouseReport.isActive()),
    ).toBe(false);

    await startCapture(page);
    const { x, y } = await cellXY(page, 4, 9);
    await page.mouse.click(x, y);
    await page.waitForTimeout(100);
    expect(await takeCapture(page)).not.toContain('\x1b[<');
  });

  test('pref 關閉時，即使主機開了 tracking 也不送', async ({ page }) => {
    test.setTimeout(90000);
    await feedRaw(page, ENABLE_CLICK);
    await page.evaluate(() =>
      window.__app.onPrefChange('mouseServerReport', false),
    );

    await startCapture(page);
    const { x, y } = await cellXY(page, 4, 9);
    await page.mouse.click(x, y);
    await page.waitForTimeout(100);
    expect(await takeCapture(page)).not.toContain('\x1b[<');
  });

  test('主機送關閉四連之後停止回報（含 ?1006l）', async ({ page }) => {
    test.setTimeout(90000);
    await feedRaw(page, ENABLE_CLICK);
    await feedRaw(page, DISABLE_ALL);
    expect(
      await page.evaluate(() => window.__app.buf.mouseReport.isActive()),
    ).toBe(false);

    await startCapture(page);
    const { x, y } = await cellXY(page, 4, 9);
    await page.mouse.click(x, y);
    await page.waitForTimeout(100);
    expect(await takeCapture(page)).not.toContain('\x1b[<');
  });

  test('滾輪回報成 64／65', async ({ page }) => {
    test.setTimeout(90000);
    await feedRaw(page, ENABLE_CLICK);
    const { x, y } = await cellXY(page, 0, 0);
    await page.mouse.move(x, y);

    await startCapture(page);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(100);
    expect(await takeCapture(page)).toContain('\x1b[<65;');

    await startCapture(page);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(100);
    expect(await takeCapture(page)).toContain('\x1b[<64;');
  });

  // 「選字仍然正常」那條**刻意不放在這裡**：拖曳任意格子座標會因為那片剛好是
  // 空白、或列節點在拖曳途中被重繪而靜默退化成空選取（實測本機 3 次紅 1 次、
  // CI 紅一次）。選字類斷言一律用 selection.offline.spec.js 的 sentinel word +
  // wordRect 技法，那裡也同時跑 firefox。見該檔「滑鼠回報開啟時：選字仍然正常」。
  test('原生行為不受影響：右鍵仍然叫得出本站選單，且不回報', async ({ page }) => {
    test.setTimeout(90000);
    await feedRaw(page, ENABLE_CLICK);

    await startCapture(page);
    const { x, y } = await cellXY(page, 30, 8);
    await page.mouse.click(x, y, { button: 'right' });
    await page.waitForTimeout(200);

    // 右鍵完全不回報（只回報左鍵）。
    expect(await takeCapture(page)).not.toContain('\x1b[<');
  });
});
