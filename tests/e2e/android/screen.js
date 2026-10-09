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
async function openScreen(page, prefs = {}) {
  await forceMobileLayout(page, prefs);
  await bootOffline(page, ptt);
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

// 真 tap（OS 層 `input tap`）。需先 recordTouches。
async function tap(page, device, selector) {
  const pt = await centerOf(page, selector);
  expect(pt, `${selector} 不在畫面上`).not.toBeNull();
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
    return Math.round(document.documentElement.clientHeight - (vv.offsetTop + vv.height));
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
