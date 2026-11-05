// 開站時 connect() 的目標。優先序：
//   1. ?site 覆寫（預設關閉，見 vite.config.mjs ALLOW_SITE_IN_QUERY；呼叫端決定要不要傳）
//   2. Android APK 的原生本機 proxy（android_bridge.js；協議由原生設定決定，網頁不必知道）
//   3. 協議選 SSH（prefs.connectionProtocol，本機 pref、不同步）：SSH relay（docs/ssh.md）
//      這個頁面跑不了 SSH（非 secure context，WebCrypto 不存在）就當沒選
//   4. 使用者在設定頁開的 proxy（prefs.useProxy，telnet over WebSocket）
//   5. 內建 DEFAULT_SITE
// 第 2 條只在讀取端生效，**不寫回 prefs**：prefs 經 pref_sync 同步到桌機，寫進去
// 桌機就會去連 127.0.0.1。守護 tests/unit/boot_site.test.js。
import { defaultSite, proxySiteFromPrefs, sshSiteFromPrefs } from './util';
import { androidSite } from './android_bridge';
import { sshSupported } from './transport';

export function bootSite(prefs, siteOverride) {
  return (
    siteOverride ||
    androidSite() ||
    (sshSupported() && sshSiteFromPrefs(prefs)) ||
    proxySiteFromPrefs(prefs) ||
    defaultSite()
  );
}
