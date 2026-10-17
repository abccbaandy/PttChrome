// 開站資源 preload 在真瀏覽器上真的被用到（index.html 的 <link rel=preload>）。
//
// 為什麼要上 e2e：preload 跟實際請求對不上（as／crossorigin／fetch 選項不一致）時瀏覽器
// 不會報錯，只是**再抓一次**、原本的串行照舊 ⇒ 靜態守護（tests/unit/boot_preload.test.js）
// 只能鎖寫法，「真的只抓一次、而且是 preload 發起的」要看瀏覽器自己的 Resource Timing：
// 吃到 preload 的 fetch()／@font-face 不會另產生一筆 entry；沒吃到就多一筆 initiatorType
// 為 fetch／css 的 entry。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline } = require('../helpers/replay');

test('轉碼表與終端機字型各只下載一次，由 preload 發起', async ({ page }) => {
  await bootOffline(page, ptt);
  const entries = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((e) => ({ name: e.name, initiatorType: e.initiatorType })));
  for (const file of ['b2u_table', 'u2b_table', 'symmingliu']) {
    // `?import&url` 是 vite dev 把 `import x from '…bin?url'` 變成的 JS 模組（內容只有網址），
    // 不是檔案本身；正式 build 沒有這筆。
    const hits = entries.filter((e) => e.name.includes(file) && !/[?&]import\b/.test(e.name));
    expect(hits, file).toHaveLength(1);
    expect(hits[0].initiatorType, file).toBe('link');
  }
});
