// 開站時 connect() 的目標。優先序：
//   1. ?site 覆寫（預設關閉，見 vite.config.mjs ALLOW_SITE_IN_QUERY；呼叫端決定要不要傳）
//   2. Android APK 的原生本機 proxy（android_bridge.js）
//   3. 使用者在設定頁開的 proxy（prefs.useProxy）
//   4. 內建 DEFAULT_SITE
// 第 2 條只在讀取端生效，**不寫回 prefs**：prefs 經 pref_sync 同步到桌機，寫進去
// 桌機就會去連 127.0.0.1。守護 tests/unit/boot_site.test.js。
import { defaultSite, proxySiteFromPrefs } from './util';
import { androidSite } from './android_bridge';

export function bootSite(prefs, siteOverride) {
  return siteOverride || androidSite() || proxySiteFromPrefs(prefs) || defaultSite();
}
