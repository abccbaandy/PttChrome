// Playwright webServer（E2E_SERVER=bundle，playwright.config.js）：打包版＋vite preview 開在 8080。
// 打包版＝PTTCHROME_E2E_BUNDLE=1（保留 developer mode 探針，輸出 dist-e2e/，絕不部署），
// 跟 android e2e 同一份（tests/e2e/android/bundle_server.js）。dev server 每條測試開站都要逐一載入
// 未打包的模組；本機量 offline-mobile 31 條：dev 83s、打包版 64s。
//
// 只給 offline 用：live／record 照舊連 dev server（它的 /bbs proxy 是連真 PTT 的唯一通道）。
// 跑到收到 SIGTERM／SIGINT 為止（Playwright teardown 送 SIGTERM）。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startBundleServer } = require('../tests/e2e/android/bundle_server.js');

const server = await startBundleServer({ host: 'localhost', port: 8080, strictPort: true, tag: 'e2e' });
const stop = async () => {
  await server.close();
  // vite 的 watcher／timer 可能還掛著事件迴圈：收完 socket 就結束。
  process.exit(0);
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
