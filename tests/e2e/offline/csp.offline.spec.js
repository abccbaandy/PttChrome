// 正式版 <meta> CSP（scripts/csp.mjs、docs/security.md）在真瀏覽器的兩件事：
//   1) 打包版開站整條 boot（含行內「下載程式中…」script）在 CSP 下沒有任何違規，app 照常連上。
//      違規本身由 installReplay 掛的 csp_guard 對**每一條** offline spec 收（任何一條碰到被擋的載入都會紅），
//      這裡多驗 meta 真的在、而且真的會擋（不然 guard 永遠收不到東西，等於沒守）。
//   2) 本站以外的 script 會被擋並觸發 securitypolicyviolation。
// CSP 只在 build 注入 ⇒ 只在打包版（CI 的 E2E_SERVER=bundle）有意義；dev server 下 skip。
const { test, expect } = require('@playwright/test');
const { installReplay, waitConnected } = require('../helpers/replay');
const { CSP_PROBE_HOST } = require('../helpers/csp_guard');

test.describe('CSP（打包版）', () => {
  test.skip(process.env.E2E_SERVER !== 'bundle', 'CSP 只在 vite build 注入（scripts/csp.mjs），dev server 沒有');

  test('開站沒有違規、本站以外的 script 會被擋', async ({ page }) => {
    await installReplay(page);
    await page.goto('/');
    await waitConnected(page);

    const policy = await page.evaluate(
      () => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '',
    );
    expect(policy).toContain("script-src 'self' 'sha256-");

    // 行內 boot script（中文介面把「Downloading…」換成「下載程式中…」）靠 hash 放行；
    // 被擋的話 csp_guard 會讓這條紅（boot 完 #bootLoading 就拆掉了，畫面上驗不到）。

    const violation = await page.evaluate(
      (host) =>
        new Promise((resolve) => {
          document.addEventListener('securitypolicyviolation', (e) => resolve(e.effectiveDirective), { once: true });
          const s = document.createElement('script');
          s.src = `https://${host}/x.js`;
          document.head.appendChild(s);
        }),
      CSP_PROBE_HOST,
    );
    expect(violation).toBe('script-src-elem');
  });
});
