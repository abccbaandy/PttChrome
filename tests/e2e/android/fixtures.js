// Android 模擬器 e2e 的 fixture（project `android`，跑法 `yarn test:e2e:android`）。
// 設計與踩坑見 docs/android-e2e.md。
//
// worker 層（整輪一次）：選模擬器 → OS 層斷網 → 清 Chrome 狀態 → host 端 IPv4 轉送
// ＋ adb reverse ⇒ 手機內 http://localhost:8080 ＝ host 的 dev server。
// test 層：每條測試一個 launchBrowser() 的 context，`page` 覆寫成手機裡的 Chrome 分頁，
// 桌機瀏覽器完全不會被啟動。
const net = require('net');
const { spawnSync } = require('child_process');
const { test: base, expect, _android } = require('@playwright/test');
const { ENV_ERROR_TAG, pickEmulatorSerial, sdkTool } = require('./android_env');

const PORT = 8080;
const CHROME = 'com.android.chrome';

const envError = (msg) => new Error(`${ENV_ERROR_TAG} ${msg}`);

// launchBrowser 本身沒有逾時：Chrome 起不來時會一直等到整條測試 timeout，被算成真失敗。
const LAUNCH_TIMEOUT_MS = 60000;

// adb reverse 是往 host 的 **127.0.0.1** 連；Windows 上 vite 只綁 [::1]:8080
// （CLAUDE.md「跑起來」）⇒ 直接 reverse 到 8080 得到 ERR_EMPTY_RESPONSE。
// 中間墊一層 TCP 轉送：127.0.0.1:<隨機埠> → localhost:8080（autoSelectFamily 兩種都試）。
// 原始 TCP 轉送，WebSocket upgrade 照常通過。
function startBridge() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((c) => {
      const u = net.connect({ host: 'localhost', port: PORT, autoSelectFamily: true });
      c.pipe(u).pipe(c);
      const kill = () => { c.destroy(); u.destroy(); };
      c.on('error', kill);
      u.on('error', kill);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function adb(serial, args) {
  const r = spawnSync(sdkTool('adb'), ['-s', serial, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw envError(`adb ${args.join(' ')} 失敗：${r.stderr || r.error}`);
  return r.stdout;
}

const test = base.extend({
  android: [
    async ({}, use) => {
      const devices = await _android.devices();
      const serial = pickEmulatorSerial(devices.map((d) => d.serial()), process.env);
      if (!serial) {
        for (const d of devices) await d.close();
        throw envError(
          `找不到唯一的模擬器（adb 看到：${devices.map((d) => d.serial()).join(', ') || '無'}）。` +
            '用 yarn test:e2e:android 會自動開機；多台時設 ANDROID_SERIAL。'
        );
      }
      const device = devices.find((d) => d.serial() === serial);
      for (const d of devices) if (d !== device) await d.close();

      // OS 層斷網（offline project 的死路 proxy 在 launchBrowser 吃不到）。adb reverse 走
      // adbd，不受影響。網路要在**開瀏覽器前**就斷：系統的「No internet connection」列
      // 幾秒後才插進來，量座標時一律重讀 WebView 原點（webviewOrigin）。
      await device.shell('svc wifi disable; svc data disable');
      // 每輪從乾淨的 Chrome 開始：launchBrowser 每次開新分頁、context.close() 不關分頁，
      // 不清會一路累積。Playwright 自己會略過首次啟動畫面（實測 pm clear 後照常），但
      // **不會**略過 Android 13+ 的通知權限推廣對話框（"Chrome notifications make things
      // easier"）：它蓋住整個畫面、UIAutomator 找不到任何 Chrome 節點、觸控全打在對話框上。
      // 預先授權 ⇒ Chrome 不再問。
      await device.shell(
        `am force-stop ${CHROME}; pm clear ${CHROME}; pm grant ${CHROME} android.permission.POST_NOTIFICATIONS`
      );
      // 模擬器的 GPU 是軟體的（swiftshader_indirect；CI 也沒有實體 GPU）。映像內建的 Chrome 113
      // 的 GPU 程序在上面初始化就 SIGSEGV（`pc 0`，呼叫到 null 函式指標；`--disable-features=
      // EnableDrDc`、`--use-angle=swiftshader`、換 -gpu 模式都無效），每次啟動當 ~6 次後退回
      // 軟體繪圖，頁面與觸控選取照常。被測行為不受影響；會擋路的只有系統的「Chrome keeps
      // stopping」對話框（蓋住整個畫面，UIAutomator 讀不到 WebView）⇒ 關掉系統錯誤對話框。
      // 當機紀錄照樣進 crash buffer，失敗時附在 logcat-crash（只有 privileged_process＝GPU 才是這條）。
      // 這個設定即時生效，但只擋**之後**的：已經顯示的對話框不會收（CI 冷開機後 Pixel Launcher
      // 常在這之前就 ANR）⇒ 再廣播 CLOSE_SYSTEM_DIALOGS，錯誤／ANR 對話框收到就自己關。
      // 先設再關，兩步之間冒出的 ANR 才不會漏網。AOSP 依據見 docs/android-e2e.md。
      await device.shell(
        'settings put global hide_error_dialogs 1; logcat -b crash -c; ' +
          'am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS'
      );

      // AVD 常帶 hw.keyboard=yes（有實體鍵盤時 Android 預設不彈軟鍵盤）⇒ 軟鍵盤相關
      // 測試在那種 AVD 上永遠等不到鍵盤。強制「有實體鍵盤也顯示軟鍵盤」，跟真手機一致。
      await device.shell('settings put secure show_ime_with_hard_keyboard 1');

      const bridge = await startBridge();
      adb(serial, ['reverse', `tcp:${PORT}`, `tcp:${bridge.address().port}`]);
      try {
        await use({ device, serial });
      } finally {
        try { adb(serial, ['reverse', '--remove', `tcp:${PORT}`]); } catch (e) {}
        bridge.close();
        await device.shell('svc wifi enable; svc data enable').catch(() => {});
        await device.close();
      }
    },
    { scope: 'worker', timeout: 120000 },
  ],

  context: async ({ android }, use) => {
    let timer;
    const context = await Promise.race([
      android.device.launchBrowser({ baseURL: `http://localhost:${PORT}` }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(envError(`Chrome ${LAUNCH_TIMEOUT_MS / 1000}s 內沒起來（看 device-screen／logcat-crash）`)), LAUNCH_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    await use(context);
    await context.close();
  },

  page: async ({ context }, use) => {
    const page = context.pages()[0] || (await context.newPage());
    await use(page);
  },

  // 失敗時另存**整個螢幕**：預設的 screenshot 只拍得到網頁，蓋住畫面的系統／Chrome
  // 對話框、原生複製工具列都在網頁外面。
  deviceScreenOnFailure: [
    async ({ android }, use, testInfo) => {
      await use();
      if (testInfo.status !== testInfo.expectedStatus) {
        const file = testInfo.outputPath('device-screen.png');
        const ok = await android.device.screenshot({ path: file }).then(() => true, () => false);
        if (ok) await testInfo.attach('device-screen', { path: file, contentType: 'image/png' });
        // 「Chrome keeps stopping」這類系統當機對話框：哪個程序、為什麼，只在 crash buffer 裡。
        const crash = await android.device.shell('logcat -d -b crash').then(String, () => '');
        if (crash.trim()) await testInfo.attach('logcat-crash', { body: crash, contentType: 'text/plain' });
      }
    },
    { auto: true },
  ],
});

// WebView 在螢幕上的 bounds；連續兩次讀到相同值才算數（系統列可能正在插入）。
async function webviewOrigin(device) {
  let last = null;
  let out = null;
  await expect
    .poll(async () => {
      // 節點還沒進 UIAutomator 樹時，driver 回的是 NullPointerException 而不是「找不到」。
      const b = await device.info({ clazz: 'android.webkit.WebView' }).then((i) => i.bounds, () => null);
      if (!b) return false;
      const same = last && last.x === b.x && last.y === b.y;
      last = b;
      if (same) out = b;
      return !!same;
    }, { intervals: [500], timeout: 15000, message: `${ENV_ERROR_TAG} 讀不到穩定的 WebView 位置（畫面可能被系統／Chrome 對話框蓋住，看失敗截圖）` })
    .toBe(true);
  return out;
}

module.exports = { test, expect, webviewOrigin, envError };
