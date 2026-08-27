// 離線重放的「圖片載入情境」（2026-08-27）。
//
// 為什麼需要這一層：`installOfflineNetwork` 原本把每一張圖都 `route.fulfill` 成記憶體裡的
// fixture PNG —— **秒回、零延遲**。那等同於「本地快取永遠命中」這一種情境，而真實世界至少
// 還有兩種：
//   * 圖床壞掉（404／301 轉址到已刪除位置）
//   * 讀圖超久（>5 秒；產品端**沒有任何載入 timeout**，只有 onError 驅動的 backoff 重試，
//     所以永遠 hang 的請求會永久停在 `.previewLoading`）
// 而「本機秒回」正是 50fa35c 那個 CI 偶發紅在本機永遠測不出來的原因：好讀長頁的行內預覽
// 是佔位盒（IntersectionObserver → mount → onLoad → ResizeObserver 撐高），圖回得慢，版面
// 就會在測試量完座標之後才位移。
//
// 所以這裡的目的**不是製造 flaky**，而是把偶發紅變成**必現紅**。因此三條硬性不變量：
//   1. 決定性：延遲是固定值、分桶是 URL 雜湊，沒有隨機、沒有時間相依、沒有順序相依。
//   2. 轉址鏈一跳即止：轉址終點帶標記前綴，一律判 broken，不可能無窮迴圈。
//   3. 壞圖的回應 body 必須**不是可解碼的圖片**。`<img>` 不看 HTTP status，只要 body 能
//      decode 就 onLoad —— docs/offline-replay-testing.md 記載的 imgur 假綠就是這樣來的。
//
// 純函式（imageScenarioFor / redirectTargetFor / resolveImageProfile / slowImageDelayMs）
// 守護在 tests/unit/offline_image_profile.test.js。
const fs = require('fs');
const path = require('path');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');

// profile ＝一整輪測試的設定；scenario ＝單一 URL 實際拿到的回應。
// 'mixed' 只是 profile，不是 scenario（它會被展開成其餘四者）；其餘四個 scenario 也
// 都能整輪套用當 profile —— 'redirect' 沒有對應的 Playwright project，只給
// image_load_conditions.offline.spec.js 逐條指定用（在 mixed 底下轉址桶是否落到這一卷
// 取決於素材，不能拿來當斷言前提）。
const IMAGE_PROFILES = ['cache', 'slow', 'broken', 'redirect', 'mixed'];
const IMAGE_SCENARIOS = ['cache', 'slow', 'broken', 'redirect'];

// 301 的終點一律帶這個前綴。imageScenarioFor 看到它就回 broken ⇒ 轉址最多跳一次。
//
// **實測（2026-08-27）：Chromium 不會跟隨 `route.fulfill` 吐出來的 301**（至少子資源
// 如此；探測方式是 route 一律回 301 → 新開一個 <img>，route handler 只被打到一次、
// <img> 直接 onerror）。所以 `redirect` 情境在頁面上的效果等同「圖拿不到」→ 走
// FallbackImage 的候選鏈 → `.previewError`，我們**驗不到**「跟隨轉址後再 404」。
// 這仍是真實世界的一種失敗形態（轉址壞掉），與純 404 走的是不同的 HTTP 狀態路徑，
// 所以留著；GONE_PREFIX 的終止保護也留著（純函式層零成本），萬一 Playwright／
// Chromium 哪天改成會跟隨，也不會變成無窮迴圈。
const GONE_PREFIX = '/__offline-gone__/';

// >5 秒（使用者要求的「讀圖超久」下界）。可用 env 覆寫供本機除錯，CI 不設。
const DEFAULT_SLOW_IMAGE_MS = 5200;

// mixed 的分桶順序。四個桶都要出現，否則 mixed 會退化成別的 profile。
const MIXED_BUCKETS = ['cache', 'slow', 'broken', 'redirect'];

// FNV-1a 32-bit。挑它只因為短、無依賴、且對 URL 這種長度相近的字串散得開；
// 換掉雜湊會改變 mixed 的分桶結果 ⇒ unit 有鎖住實際分桶，改了會紅。
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; ++i) {
    h ^= str.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// URL → 這一次要回什麼。profile 非 mixed 時 scenario 與 profile 同名（cache/slow/broken）。
function imageScenarioFor(rawUrl, profile) {
  const url = String(rawUrl);
  // 不變量 2：轉址終點永遠是死路，不再進分桶。
  if (url.indexOf(GONE_PREFIX) >= 0) return 'broken';
  if (profile === 'mixed') return MIXED_BUCKETS[fnv1a(url) % MIXED_BUCKETS.length];
  return IMAGE_SCENARIOS.indexOf(profile) >= 0 ? profile : 'cache';
}

// 301 的 Location。同 host（跨 host 會多一次 CORS/預檢的變數），副檔名保持 .png 讓它
// 仍被 classifyOfflineRequest 判成 image ⇒ 進得了攔截層，才有機會回 404。
function redirectTargetFor(rawUrl) {
  let origin;
  try {
    origin = new URL(String(rawUrl)).origin;
  } catch (e) {
    origin = 'https://offline.invalid';
  }
  return origin + GONE_PREFIX + (fnv1a(String(rawUrl)) % 1000) + '.png';
}

function slowImageDelayMs(env) {
  const raw = Number((env || {}).OFFLINE_SLOW_IMAGE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SLOW_IMAGE_MS;
}

// project 名 → profile。用 project 名而非 env 傳遞，是為了不引入 cross-env
//（Yarn v4 的 portable shell 雖支援行內 env，但 Playwright 的 --project 才是這裡的真來源）。
function profileFromProjectName(name) {
  const m = /^offline-(slow|broken|mixed)$/.exec(String(name || ''));
  return m ? m[1] : null;
}

// 優先序：env（本機除錯的逃生門）> project 名 > 'cache'（現行行為）。
function resolveImageProfile({ env, projectName } = {}) {
  const fromEnv = ((env || {}).OFFLINE_IMAGE_PROFILE || '').trim();
  if (IMAGE_PROFILES.indexOf(fromEnv) >= 0) return fromEnv;
  return profileFromProjectName(projectName) || 'cache';
}

let previewPngCache = null;
function previewPng() {
  if (!previewPngCache) {
    previewPngCache = fs.readFileSync(path.join(FIXTURE_DIR, 'preview.png'));
  }
  return previewPngCache;
}

// scenario → route.fulfill 的參數。抽成純函式好在 unit 鎖住「broken 的 body 不是圖」。
// 回 null ＝這個 scenario 需要先等（slow），由呼叫端處理延遲後再問一次。
function imageResponseFor(scenario, rawUrl) {
  switch (scenario) {
    case 'broken':
      // 不變量 3：空 body + text/plain。給任何可解碼的內容都會讓 <img> onLoad 成功。
      return { status: 404, contentType: 'text/plain', body: '' };
    case 'redirect':
      return {
        status: 301,
        headers: { location: redirectTargetFor(rawUrl) },
        contentType: 'text/plain',
        body: '',
      };
    case 'slow':
    case 'cache':
    default:
      return { status: 200, contentType: 'image/png', body: previewPng() };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 把一筆圖片請求依情境回應。
// `slow` 會真的等 delayMs 才 fulfill —— 頁面在這段期間關掉的話 fulfill 會 reject
//（`Target closed`），一律吞掉：那不是測試失敗，是收尾順序。
async function fulfillImageRequest(route, { scenario, rawUrl, delayMs }) {
  if (scenario === 'slow' && delayMs > 0) await sleep(delayMs);
  try {
    await route.fulfill(imageResponseFor(scenario, rawUrl));
  } catch (e) {
    // page/context 已關閉；靜默收工。
  }
}

// ---------------------------------------------------------------------------
// 在途圖片請求計數。`waitPreviewsSettled` 的終局判定之一：頁面上看不到 `.previewLoading`
// **而且** Node 這端沒有任何圖片請求還壓在 route handler 裡（slow 情境下這兩件事差 5 秒）。
// 放在這裡而不是 replay.js，是為了讓 helpers/layout.js 不必反過來 require replay.js
// （會形成循環）。
const inflightByPage = new WeakMap();

function beginImageRequest(page) {
  inflightByPage.set(page, (inflightByPage.get(page) || 0) + 1);
}

function endImageRequest(page) {
  inflightByPage.set(page, Math.max(0, (inflightByPage.get(page) || 0) - 1));
}

function imageInflight(page) {
  return inflightByPage.get(page) || 0;
}

// 這個 page 這一輪用的 profile（供 spec 判斷「這個 profile 下圖片本來就載不到」）。
const profileByPage = new WeakMap();
const setPageImageProfile = (page, profile) => profileByPage.set(page, profile);
const pageImageProfile = (page) => profileByPage.get(page) || 'cache';

// broken profile 下圖片必定載不到；mixed 下只有一部分載得到。斷言「圖有高度」的
// spec 用它決定要不要跑。
const profileLoadsEveryImage = (profile) => profile === 'cache' || profile === 'slow';

module.exports = {
  DEFAULT_SLOW_IMAGE_MS,
  beginImageRequest,
  endImageRequest,
  imageInflight,
  pageImageProfile,
  profileLoadsEveryImage,
  setPageImageProfile,
  FIXTURE_DIR,
  GONE_PREFIX,
  IMAGE_PROFILES,
  IMAGE_SCENARIOS,
  MIXED_BUCKETS,
  fnv1a,
  fulfillImageRequest,
  imageResponseFor,
  imageScenarioFor,
  previewPng,
  profileFromProjectName,
  redirectTargetFor,
  resolveImageProfile,
  slowImageDelayMs,
};
