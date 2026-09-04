// 「開燈」（隱藏文字）—— 離線重放，真瀏覽器、真 CSS、真渲染鏈。
//
// unit 量得到 class 與偵測旗標，量不到兩件事：
//   1. `.lightsOn .q0.b0` 的**實際顏色**，以及它與 `.work-mode-active .q0` 的層疊
//      （specificity (0,3,0) vs (0,2,0)）—— 只有真的跑過 CSSOM 才驗得出來；
//   2. 軌 B 點下去**第一段送出的 bytes 是不是只有 `\`**（兩個 byte 一次送出會被
//      pttbbs 的 typeahead 吞掉中間那一幀，見 docs/pttbbs-screen-protocol.md §2）。
//
// 畫面用 `feedRaw` 餵一份**合成的** 24 列文章幀，不用 cassette：隱藏文字的素材
// 是使用者自建的測試文，錄下來會帶進 PTT 帳號（cassette 一律 guest-only，見
// docs/offline-replay-testing.md 的隱私規則）。合成幀刻意同時放三種格子，逐格
// 依據見 docs/pttbbs-screen-protocol.md §14.2 的對照表。
//
// 注意合成幀裡的「半形隱藏字」在真實 PTT 上會被 server 擦成空白（軌 B），這裡放它
// 是為了驗**渲染層**；「server 會不會送出來」那一層是 tests/unit/hidden_text.test.js
// 的事，兩邊不重疊。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, feedRaw } = require('../helpers/replay');

const ESC = '\x1b';
// 中文測試（Big5：a4a4 a4e5 b4fa b8d5）—— DBCS 例外，真實 PTT 也會原樣送出（軌 A）。
const B5_HIDDEN_CJK = '\xa4\xa4\xa4\xe5\xb4\xfa\xb8\xd5';

// 一份完整的 24 列文章幀（pmore 預設格式化模式）。結尾把游標 park 在右下角（P6），
// 讓 client 認得這是一個完整回應。
function articleFrame() {
  const rows = [];
  const at = (row, text) => rows.push(`${ESC}[${row};1H${ESC}[K${text}`);
  at(1, ' 作者  someone (nick)                                             看板  Test');
  at(2, ' 標題  [測試] 開燈');
  at(3, ' 時間  Fri Sep  4 16:53:28 2026');
  at(5, 'plain body line');
  // 軌 A：fg===bg 且有字（隱藏中文）。
  at(7, `${ESC}[30m${B5_HIDDEN_CJK}${ESC}[m`);
  // 軌 B：fg===bg 且是空白 60 格（實測的隱藏網址就是這個形狀）。
  at(9, `${ESC}[30m${' '.repeat(60)}${ESC}[m`);
  // 誤報防線：ESC[1;30m 是 pmore grayout 的深灰（fg=8），不是隱藏文字。
  at(11, `${ESC}[1;30mgrayed out, not hidden${ESC}[m`);
  // 狀態列：開頭兩格 fg=7/bg=7（實錄的誤報來源），本體是正常反白狀態列。
  at(
    24,
    `${ESC}[0;47m  ${ESC}[0;44;37m瀏覽 第 1/1 頁 (100%)  目前顯示: 第 01~20 行  ` +
      `(y)回應(X%)推文(h)說明(←)離開  ${ESC}[m`
  );
  return `${ESC}[H${ESC}[2J` + rows.join('') + `${ESC}[24;80H`;
}

// 把 stub WebSocket 的送出紀錄接起來（installReplay 只在裝了 hook 時才記）。
async function recordSends(page) {
  await page.evaluate(() => {
    window.__lightsSent = [];
    window.__stubWSSent = (s) => window.__lightsSent.push(s);
  });
}

// 隱藏中文那一列上，第一個帶 q0 的字元 span 的實際顏色。
async function hiddenSpanColor(page) {
  return page.evaluate(() => {
    const line = document.querySelector(
      '#mainContainer [data-type="bbsline"][data-row="6"]'
    );
    if (!line) return null;
    for (const span of line.querySelectorAll('span')) {
      if (span.classList.contains('q0') && span.textContent.trim())
        return {
          classes: [...span.classList],
          color: getComputedStyle(span).color,
          textShadow: getComputedStyle(span).textShadow,
        };
    }
    return null;
  });
}

// 同一組 class 在**沒有** .lightsOn 時的顏色（離線探針，不動畫面）。
async function baseColor(page, classes) {
  return page.evaluate((cls) => {
    const probe = document.createElement('span');
    probe.className = cls.join(' ');
    probe.textContent = 'x';
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, classes);
}

async function boot(page, prefs) {
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, Object.assign({ enableEasyReading: false }, prefs));
  await recordSends(page);
  await feedRaw(page, articleFrame());
  await page.waitForFunction(
    () => !!document.querySelector('#mainContainer #lightsOnBtn'),
    null,
    { timeout: 15000 }
  );
}

test.describe('開燈（離線）', () => {
  test('偵測到隱藏文字 → 按鈕出現；點下去真的把字提亮（真 CSSOM）', async ({ page }) => {
    await boot(page);

    const before = await hiddenSpanColor(page);
    expect(before).not.toBe(null);
    expect(before.classes).toContain('b0');
    const base = await baseColor(page, before.classes);
    expect(before.color).toBe(base); // 還沒開燈：與一般 q0 同色（＝黑底黑字，看不見）

    await page.click('#lightsOnBtn');
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.getElementById('mainContainer').classList.contains('lightsOn')
        )
      )
      .toBe(true);

    const after = await hiddenSpanColor(page);
    // 同一個節點、同一組 class —— 只有容器多了 .lightsOn（軌 A 不重建任何一列）。
    expect(after.classes).toEqual(before.classes);
    expect(after.color).not.toBe(base);
    expect(after.textShadow).not.toBe('none');

    // 再點一次關燈：回到原色。
    await page.click('#lightsOnBtn');
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.getElementById('mainContainer').classList.contains('lightsOn')
        )
      )
      .toBe(false);
    expect((await hiddenSpanColor(page)).color).toBe(base);
  });

  test('上班模式的靜音調色盤蓋不掉開燈（specificity (0,3,0) > (0,2,0)）', async ({
    page,
  }) => {
    await boot(page, { enableWorkMode: true });
    const before = await hiddenSpanColor(page);
    const workBase = await baseColor(page, before.classes);
    await page.click('#lightsOnBtn');
    const after = await hiddenSpanColor(page);
    expect(after.color).not.toBe(workBase);
  });

  test('軌 B：點下去第一段送出的 bytes 只有 `\\`（絕不可以連數字鍵一起送）', async ({
    page,
  }) => {
    await boot(page);
    await page.evaluate(() => (window.__lightsSent.length = 0));
    await page.click('#lightsOnBtn');
    await expect
      .poll(() => page.evaluate(() => window.__lightsSent.join('')))
      .toBe('\\');

    // 再餵一次**文章**幀（不是設定頁）：queue 的 expect 判 false ⇒ 命令仍在飛、
    // 數字鍵永遠不出去（`3` 落回文章按鍵是 pmore 的「跳至第 3 頁」，會把使用者
    // 彈到別的地方）。用畫面事件當判準，不用 sleep。
    await feedRaw(page, articleFrame());
    await expect
      .poll(() => page.evaluate(() => window.__app.commandQueue.inFlightKind))
      .toBe('lights-pref');
    expect(await page.evaluate(() => window.__lightsSent.join(''))).toBe('\\');
  });

  test('沒有隱藏文字的畫面不出現按鈕', async ({ page }) => {
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: false });
    await feedRaw(
      page,
      `${ESC}[H${ESC}[2J${ESC}[1;1H 作者  someone (nick)                    看板  Test` +
        `${ESC}[5;1Hplain body only` +
        `${ESC}[24;1H${ESC}[0;44;37m  瀏覽 第 1/1 頁 (100%)  目前顯示: 第 01~20 行  ` +
        `(y)回應(X%)推文(h)說明(←)離開${ESC}[m${ESC}[24;80H`
    );
    // 先等這一幀真的畫上去（pageState 3 ＝浮動按鈕的判定前提），再斷言按鈕不存在。
    await page.waitForFunction(() => window.__app.buf.pageState === 3, null, {
      timeout: 15000,
    });
    expect(await page.locator('#lightsOnBtn').count()).toBe(0);
  });
});
