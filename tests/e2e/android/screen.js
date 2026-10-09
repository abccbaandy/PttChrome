// Android spec 共用的「開一個畫面」與「真觸控」helper（設計見 docs/android-e2e.md）。
// 觸控一律走 OS 的 input injection（`adb shell input …`），經過 Android 自己的觸控／IME／
// 返回鍵管線 —— 這正是桌機 CDP 做不出來的那段。
const { expect, webviewOrigin, envError } = require('./fixtures');
const ptt = require('../helpers/ptt');
const { findCassette, bootOffline, replayCassette } = require('../helpers/replay');
const { toDevicePoint } = require('./android_env');

const article = findCassette('article');

// 模擬器的觸控螢幕帶 STYLUS source ⇒ Chrome 回報 pointer: fine（實測，CDP 的
// setEmulatedMedia 蓋不掉）⇒ auto 判不成手機。用產品自己的逃生門 pref 強制手機版面；
// 觸控本身仍是真的。必須在 goto 前就位（開站即套版面）。
async function forceMobileLayout(page, prefs = {}) {
  await page.addInitScript(
    ({ KEY, extra }) => {
      const cur = JSON.parse(window.localStorage.getItem(KEY) || '{}');
      const values = Object.assign({}, cur.values, { mobileLayout: 'on', enableEasyReading: false }, extra);
      window.localStorage.setItem(KEY, JSON.stringify({ values }));
    },
    { KEY: ptt.PREF_KEY, extra: prefs }
  );
}

// 一般終端機畫面（預設不開好讀）。不開好讀 ⇒ 不需要「一屏 24 列」，模擬器用原生 Pixel 6
// 尺寸（49 列，cassette 的 24 列畫在上半部）——跟真手機同一個長條比例。
//
// opts.rows：要「server 的真實畫面」判讀對（pageState 等看底列）時，把視窗高壓成剛好
// cassette 的列數（列數＝(視窗高 − 工具列) / 16，見 docs/mobile.md「尺寸」）。49 列時 cassette
// 的狀態列落在第 24 列、底列是空的 ⇒ pageState 0，← 會被 nav_key_gate 正確地擋下。
// 寬度維持 screen.width ⇒ 觸控座標仍是 1:1（docs/android-e2e.md「CONFIRMED 事實」）。
async function openScreen(page, prefs = {}, opts = {}) {
  await forceMobileLayout(page, prefs);
  if (opts.rows) {
    const cdp = await page.context().newCDPSession(page);
    const { width, dpr } = await page.evaluate(() => ({ width: screen.width, dpr: devicePixelRatio }));
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: opts.rows * 16 + 48 + 8,
      deviceScaleFactor: dpr,
      mobile: true,
    });
  }
  await bootOffline(page, ptt);
  if (opts.rows) {
    await expect.poll(() => page.evaluate(() => window.__app.buf.rows)).toBe(opts.rows);
  }
  if (!(await page.evaluate(() => window.__app.mobile))) {
    throw envError('沒有進手機版面（mobileLayout pref 沒套上）');
  }
  await replayCassette(page, article, { easyReading: !!prefs.enableEasyReading });
  await expect.poll(() => page.evaluate(() => window.__app.buf.getRowText(0).trim().length)).toBeGreaterThan(0);
}

// capture 階段記下每個觸控 pointerdown（React listener 之前），給落點自檢用。
async function recordTouches(page) {
  await page.evaluate(() => {
    window.__down = [];
    window.addEventListener(
      'pointerdown',
      (ev) => window.__down.push({ x: ev.clientX, y: ev.clientY, type: ev.pointerType }),
      true
    );
  });
}

// 觸控落點自檢：頁面收到的最後一個觸控 pointerdown 必須在目標 4px 內 —— 對不上就是
// 座標換算錯（環境問題），不是被測行為。
async function checkLanding(page, pt, origin, nth) {
  await expect.poll(() => page.evaluate(() => window.__down.filter((d) => d.type === 'touch').length)).toBe(nth);
  const down = await page.evaluate(() => window.__down.filter((d) => d.type === 'touch').pop());
  if (Math.abs(down.x - pt.x) > 4 || Math.abs(down.y - pt.y) > 4) {
    throw envError(`觸控落點偏移：目標 ${JSON.stringify(pt)}，實際 ${JSON.stringify(down)}，WebView ${JSON.stringify(origin)}`);
  }
}

// 元素中心（CSS px）＋DPR。量不到（不在畫面上）⇒ null。
const centerOf = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, dpr: devicePixelRatio };
  }, selector);

// 終端機上一個「點了不會做任何事」的點：可視範圍內、底下沒有連結／按鈕的空白列。
// **不可以點 #mainContainer 中心**：cassette 的 24 列畫在上半部，中心常剛好落在文章網址
// 連結上 ⇒ 開新分頁（實測：之後的返回鍵是在關那個分頁，不是被測的 sentinel）。
const blankTerminalPoint = (page) =>
  page.evaluate(() => {
    const main = document.getElementById('mainContainer').getBoundingClientRect();
    const bar = document.querySelector('.mobileToolbarBar');
    const bottom = Math.min(main.bottom, bar ? bar.getBoundingClientRect().top : innerHeight) - 24;
    for (let y = bottom; y > main.top + 8; y -= 8) {
      const x = main.left + 24;
      const mc = document.getElementById('mainContainer');
      const el = document.elementFromPoint(x, y);
      if (!el || !mc.contains(el)) continue;
      if (el.closest('a, button, [link="true"], [data-own-control], img')) continue;
      if (el !== mc && (el.textContent || '').trim()) continue;
      return { x, y, dpr: devicePixelRatio };
    }
    return null;
  });

// 真 tap（OS 層 `input tap`）。target：selector（點元素中心）或 'blank-terminal'。需先 recordTouches。
async function tap(page, device, target) {
  const pt = target === 'blank-terminal' ? await blankTerminalPoint(page) : await centerOf(page, target);
  expect(pt, `${target} 不在畫面上`).not.toBeNull();
  const before = await page.evaluate(() => window.__down.filter((d) => d.type === 'touch').length);
  const origin = await webviewOrigin(device);
  const p = toDevicePoint(origin, pt.dpr, pt);
  await device.shell(`input tap ${p.x} ${p.y}`);
  await checkLanding(page, pt, origin, before + 1);
}

// 真按鍵（OS 層 `input keyevent`），例如 KEYCODE_BACK。
const keyevent = (device, code) => device.shell(`input keyevent ${code}`);

// app 送給 PTT 的 bytes（重放的假 WebSocket）。重放結束後才開始收。
async function collectSent(page) {
  await page.evaluate(() => {
    window.__sent = [];
    window.__stubWSSent = (s) => window.__sent.push(s);
  });
}
const sentText = (page) => page.evaluate(() => (window.__sent || []).join(''));

// 軟鍵盤蓋住的高度（CSS px）：layout viewport 底 − visual viewport 底。Chrome 預設
// resizes-visual：鍵盤升起只縮 visual viewport（產品的 keyboardInset 也是這樣量）。
const keyboardCover = (page) =>
  page.evaluate(() => {
    const vv = window.visualViewport;
    // Math.max 也把 -0 正規化成 0（toBe 用 Object.is）。
    return Math.max(0, Math.round(document.documentElement.clientHeight - (vv.offsetTop + vv.height)));
  });

module.exports = {
  article,
  openScreen,
  recordTouches,
  checkLanding,
  centerOf,
  tap,
  keyevent,
  collectSent,
  sentText,
  keyboardCover,
};
