// CSP 違規守護（scripts/csp.mjs、docs/security.md）：installReplay 對每個 offline 頁面裝。
// 正式版的 <meta> CSP 只在 build 注入 ⇒ 只有打包版（CI 的 E2E_SERVER=bundle）會真的擋；dev server
// 沒有 CSP，這裡永遠是空的。被擋的資源瀏覽器只在 console 印一行、不丟例外，功能就是默默不見
// （圖片預覽空白、登入按了沒反應），所以要主動收 securitypolicyviolation 讓 test 紅。
const TAG = '[csp-violation] ';
// csp.offline.spec.js 故意載入這個網域來確認 CSP 真的會擋：不算違規。
const PROBE_HOST = 'csp-probe.invalid';

function pageGuard({ tag, probeHost }) {
  document.addEventListener('securitypolicyviolation', (e) => {
    if (String(e.blockedURI).includes(probeHost)) return;
    console.error(
      tag +
        JSON.stringify({
          directive: e.effectiveDirective,
          blocked: e.blockedURI,
          source: e.sourceFile ? `${e.sourceFile}:${e.lineNumber}` : '',
        }),
    );
  });
}

async function installCspGuard(page) {
  const { expect } = require('@playwright/test');
  page.on('console', (msg) => {
    const text = msg.text();
    if (!text.startsWith(TAG)) return;
    try {
      expect.soft(JSON.parse(text.slice(TAG.length)), '被 CSP 擋下（scripts/csp.mjs 要放行，或改掉這個載入）').toBeUndefined();
    } catch {
      // test 已結束才收到（頁面收尾時）：沒有 testInfo 可記，忽略。
    }
  });
  await page.addInitScript(pageGuard, { tag: TAG, probeHost: PROBE_HOST });
}

module.exports = { installCspGuard, CSP_VIOLATION_TAG: TAG, CSP_PROBE_HOST: PROBE_HOST };
