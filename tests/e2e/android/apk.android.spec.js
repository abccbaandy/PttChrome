// Android APK（WebView 殼，docs/android-app.md）在模擬器上的真觸控／真按鍵。
// 守的是只有殼才有、手機 Chrome 那組（mobile_input）測不到的原生那層：
//   1. 系統返回鍵走 MainActivity 的 OnBackPressedCallback：WebView 能 goBack 就交給網頁
//      （history sentinel → guard → 送鍵出口），退到底只把 App 丟到背景、不結束（結束＝斷線）；
//   2. 文章裡的網址（target=_blank）走 onCreateWindow 交給外部瀏覽器，BBS 畫面不被換掉；
//   3. 軟鍵盤疊在 WebView 上、不縮 WebView（縮了＝改列數、重送 NAWS），高度由原生
//      'pttandroid:ime' 告訴網頁 ⇒ 工具列與終端機底列浮在鍵盤上；鍵盤開著按返回只收鍵盤。
// 網頁是 host 的 dev server（APK 的 dev server 模式，fixtures.js#apk），PTT 連線是離線重放
// （stub 攔 APK 本機 proxy 那條 ws://127.0.0.1:<port>/bbs/<token>）。
// 密碼管理員／Google 登入 bridge 沒有測：模擬器上沒有 Google 帳號與已存密碼。
const { test, expect } = require('./fixtures');
const { parseResumedPackage } = require('./android_env');
const {
  article,
  byKey,
  rectOf,
  lastRowBottom,
  waitOnSentinel,
  recordBackGuard,
  backGuardDiag,
  openScreen,
  recordTouches,
  tap,
  keyevent,
  collectSent,
  sentText,
} = require('./screen');

// 左鍵關掉：真 tap 落在終端機上時不可以自己送鍵（左側退出帶、邊緣翻頁）。
const PREFS = { mouseLeftClick: false };
const CHROME = 'com.android.chrome';

const resumedPackage = (device) => device.shell('dumpsys activity activities').then((b) => parseResumedPackage(String(b)));
// 同一份文件、同一條連線：Activity／WebView 被重建的話，舊的 page 會關掉（evaluate 丟錯）或旗標不見。
const sameDocument = (page) =>
  page.evaluate(() => !!window.__sameDocument && window.__app.isConnected()).catch(() => false);
// 原生回報、網頁套上的鍵盤高度（CSS px）。
const kbInset = (page) =>
  page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--kb-inset')) || 0);

async function bringBack(apk) {
  // singleTask ⇒ 叫回既有的那個 Activity（不新建、不重載）。
  await apk.device.shell(`am start -n ${apk.activity}`);
  await expect.poll(() => resumedPackage(apk.device), { timeout: 15000 }).toBe(apk.pkg);
}

test.describe('Android APK：返回鍵、外部連結、軟鍵盤（真觸控／真按鍵）', () => {
  test.skip(!article, '尚無 article cassette');

  test('返回鍵：退到底只丟到背景、不斷線；疊了 sentinel 之後交給網頁的 guard', async ({ apk }) => {
    test.setTimeout(150000);
    const { device, page } = apk;
    await openScreen(page, PREFS, { reload: true });
    await recordTouches(page);
    await page.evaluate(() => {
      window.__sameDocument = true;
    });
    expect(await resumedPackage(device)).toBe(apk.pkg);

    // 還沒有任何 user activation ⇒ 沒有 sentinel ⇒ WebView 不能 goBack ⇒ moveTaskToBack。
    expect(await page.evaluate(() => !!(history.state && history.state.pttchromeBackGuard))).toBe(false);
    await keyevent(device, 'KEYCODE_BACK');
    await expect.poll(() => resumedPackage(device), { timeout: 15000 }).not.toBe(apk.pkg);
    await bringBack(apk);
    expect(await sameDocument(page)).toBe(true);

    // 疊了 sentinel ⇒ 返回交給網頁：guard 接住、交給送鍵出口、補回 sentinel，App 留在前景。
    // （原生 Pixel 6 尺寸下 cassette 畫面是 pageState 0，← 照實被擋，見 mobile_input 的說明。）
    await tap(page, device, 'blank-terminal');
    await waitOnSentinel(page);
    await recordBackGuard(page);
    await keyevent(device, 'KEYCODE_BACK');
    await expect
      .poll(() => page.evaluate(() => window.__diag.navs.length), { message: '返回沒有交給網頁的 guard' })
      .toBe(1)
      .catch(async (e) => {
        throw new Error(`${e.message}\n現場：${await backGuardDiag(page)}，前景：${await resumedPackage(device)}`);
      });
    await waitOnSentinel(page, { timeout: 10000 });
    expect(await page.evaluate(() => window.__diag.navs)).toEqual(['ArrowLeft']);
    expect(await resumedPackage(device)).toBe(apk.pkg);
    expect(await sameDocument(page)).toBe(true);
  });

  test('文章裡的網址：交給外部瀏覽器，BBS 畫面留著', async ({ apk }) => {
    test.setTimeout(150000);
    const { device, page } = apk;
    await openScreen(page, PREFS, { reload: true });
    await recordTouches(page);
    const href = await page.evaluate(() => {
      window.__sameDocument = true;
      const vh = innerHeight;
      for (const a of document.querySelectorAll('#mainContainer a[href^="http"]')) {
        const r = a.getBoundingClientRect();
        if (a.querySelector('img') || !r.width || r.top < 0 || r.bottom > vh) continue;
        a.setAttribute('data-e2e-link', '');
        return a.href;
      }
      return null;
    });
    expect(href, 'cassette 畫面上沒有可點的網址').not.toBeNull();
    const before = page.url();

    await tap(page, device, '[data-e2e-link]');
    await expect.poll(() => resumedPackage(device), { timeout: 20000 }).toBe(CHROME);
    expect(page.url()).toBe(before);

    await bringBack(apk);
    expect(await sameDocument(page)).toBe(true);
    expect(page.url()).toBe(before);
  });

  test('⌨ 軟鍵盤：WebView 不縮、原生回報高度、工具列與底列在鍵盤上；返回只收鍵盤', async ({ apk }) => {
    test.setTimeout(150000);
    const { device, page } = apk;
    await openScreen(page, PREFS, { reload: true });
    await recordTouches(page);
    const size0 = await page.evaluate(() => ({ h: innerHeight, rows: window.__app.buf.rows }));

    await tap(page, device, byKey('__keys'));
    await expect(page.locator('#mobileKeypad')).toBeVisible();
    await tap(page, device, byKey('__keyboard'));
    await expect.poll(() => kbInset(page), { timeout: 10000 }).toBeGreaterThan(100);
    expect(await page.evaluate(() => window.__app.softKeyboard)).toBe(true);

    // 鍵盤疊在上面、WebView 沒被縮（縮了就是 layout resize ⇒ 改列數）。
    expect(await page.evaluate(() => ({ h: innerHeight, rows: window.__app.buf.rows }))).toEqual(size0);
    // 工具列下緣貼齊鍵盤上緣、面板在工具列上、終端機底列在面板上。
    await expect
      .poll(async () => Math.abs((await rectOf(page, '.mobileToolbarBar')).bottom - (size0.h - (await kbInset(page)))))
      .toBeLessThanOrEqual(1);
    const bar = await rectOf(page, '.mobileToolbarBar');
    const panel = await rectOf(page, '#mobileKeypad');
    expect(panel.bottom).toBeLessThanOrEqual(bar.top + 0.5);
    await expect.poll(() => lastRowBottom(page)).toBeLessThanOrEqual(panel.top + 0.5);

    // 返回鍵：IME 吃掉、只收鍵盤（原生回報 0 ⇒ softKeyboard 歸零），不送 ←、App 留在前景。
    await collectSent(page);
    await keyevent(device, 'KEYCODE_BACK');
    await expect.poll(() => kbInset(page), { timeout: 10000 }).toBe(0);
    await expect.poll(() => page.evaluate(() => window.__app.softKeyboard)).toBe(false);
    expect(await resumedPackage(device)).toBe(apk.pkg);
    // 柵欄：送出的 bytes 依序，返回鍵若被當成 ← 送了會排在 Escape 前面。
    await tap(page, device, byKey('Escape'));
    await expect.poll(() => sentText(page)).toContain('\x1b');
    expect(await sentText(page)).toBe('\x1b');
  });
});
