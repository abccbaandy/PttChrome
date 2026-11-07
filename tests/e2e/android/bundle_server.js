// android e2e 的開站伺服器：打包版（PTTCHROME_E2E_BUNDLE=1，保留 developer mode 探針）＋ vite preview。
//
// 為什麼不用 dev server：dev server 送的是未打包的 ES module，模擬器隔著 adb reverse 一個一個抓，
// 每條測試開站要 9～12s（11 條佔 android job 的一半，CI log 的 `[android] openScreen`）；
// 打包版只有幾個檔。build 本身約 2～3s，整輪一次（worker 層）。
//
// 逃生門 ANDROID_E2E_DEV_SERVER=1：照舊連 host 的 dev server（要看 HMR／改完不重 build 時）。
const path = require('path');

const ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR = 'dist-e2e';

function useDevServer(env = process.env) {
  return env.ANDROID_E2E_DEV_SERVER === '1';
}

// 回傳 { port, close }。
async function startBundleServer() {
  const vite = await import('vite');
  const configFile = path.join(ROOT, 'vite.config.mjs');
  const prev = process.env.PTTCHROME_E2E_BUNDLE;
  process.env.PTTCHROME_E2E_BUNDLE = '1';
  const t0 = Date.now();
  try {
    await vite.build({ root: ROOT, configFile, logLevel: 'warn' });
  } finally {
    if (prev === undefined) delete process.env.PTTCHROME_E2E_BUNDLE;
    else process.env.PTTCHROME_E2E_BUNDLE = prev;
  }
  // preview 的 command 是 serve ⇒ config 給的 outDir 是 dist，這裡指回 dist-e2e。
  const server = await vite.preview({
    root: ROOT,
    configFile,
    logLevel: 'warn',
    build: { outDir: OUT_DIR },
    preview: { host: '127.0.0.1', port: 4173, strictPort: false, open: false },
  });
  const port = server.httpServer.address().port;
  console.log(`[android] 開站用打包版：build＋preview ${((Date.now() - t0) / 1000).toFixed(1)}s，port ${port}`);
  return {
    port,
    close: () => new Promise((r) => server.httpServer.close(() => r())),
  };
}

module.exports = { startBundleServer, useDevServer, OUT_DIR };
