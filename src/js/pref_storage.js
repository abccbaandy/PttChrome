// Preference storage layer (localStorage). Extracted from PrefModal so that
// non-React modules (main.js, pref_sync.js) can read/write prefs without
// importing a component module.

export const DEFAULT_PREFS = {
  // general
  //dbcsDetect    : false,
  enablePicPreview: true,
  enableNotifications: true,
  enableEasyReading: false,
  // List easy reading (v4): accumulate the board article list across pages into
  // one scrollable ASCENDING list (older→newer, like native) so blacklisted rows
  // can be removed entirely (no blank gaps). Engages on entering a board list.
  // Default OFF while the feature matures (same policy as enableEasyReading).
  enableEasyReadingList: false,
  // Target number of VISIBLE (non-blacklisted) rows the background prefetch
  // accumulates before stopping; continuation is demand-driven (navigate near
  // an edge). 0 disables the background fill (current page + demand only).
  easyReadingListPrefetchCount: 200,
  endTurnsOnLiveUpdate: false,
  copyOnSelect: false,
  antiIdleTime: 0,
  lineWrap: 78,
  // Easy reading: pressing this key jumps to the post bottom and switches back to
  // native mode (so native in-post search '/' becomes usable). Toggle off to let the
  // key fall through to the native terminal instead. Key value is an e.key string.
  easyReadingEndSwitchNative: true,
  easyReadingEndSwitchKey: "F8",

  // Connection proxy: when on, connect through proxyUrl instead of DEFAULT_SITE so
  // users behind a block can reach PTT without installing anything. proxyUrl may be a
  // bare host (a wsstelnet:// scheme and /bbs path are filled in, see main.js) or a
  // full ws(s)telnet:// URL.
  // **空字串 = 用內建的公用 relay**（util.js#DEFAULT_PROXY_HOST，UI 拿它當
  // placeholder）。不把預設值寫進欄位，使用者才能把自訂位址整段刪掉回到預設，而不是
  // 刪成一個「開著卻沒有位址」的空設定。同理見 imgurProxyUrl。
  useProxy: false,
  proxyUrl: "",

  // imgur 圖片快取代理。**預設開**（與上面的 BBS proxy 相反）：imgur 的 CDN 把台灣
  // 流量導到美西，同一張圖 20 次取樣有 4～5 次卡住 9～24 s，代理實測 stall 0/20；
  // 多數人不會去翻設定，預設關等於功能沒人用。median 幾乎不變，賣點是「不再卡住」
  // 不是「更快」。額度的計費單位是**回源次數**（快取命中時 Worker 不執行），加上
  // PTT 熱門文重複率高 ⇒ 100k/day 的消耗遠低於直覺。額度用盡或 Worker 掛掉時
  // srcset 會自動退回 i.imgur.com（見 imgur_proxy.js#imgurCandidates），不會更差。
  // 隱私：代理由專案方持有，會看到「哪個 IP 在看哪張圖」（Worker 不留任何 log），
  // 設定 UI 有明確揭露文字。量測見 docs/imgur-latency-research.md。
  // 空字串 = 用專案方的 Worker（imgur_proxy.js#DEFAULT_IMGUR_PROXY_BASE，UI 拿它當
  // placeholder），理由同 proxyUrl。
  useImgurProxy: true,
  imgurProxyUrl: "",

  // mouse browsing
  useMouseBrowsing: false,
  mouseBrowsingHighlight: true,
  mouseBrowsingHighlightColor: 2,
  mouseLeftFunction: 0,
  mouseMiddleFunction: 0,
  mouseWheelFunction1: 1,
  mouseWheelFunction2: 2,
  mouseWheelFunction3: 3,

  // displays
  fontFitWindowWidth: false,
  fontFace: "MingLiu,SymMingLiu,monospace",
  fontSize: 20,
  termSize: { cols: 80, rows: 24 },
  termSizeMode: "fixed-term-size",
  bbsMargin: 0,

  // 裝置端 AI（Chrome Prompt API）總開關。所有 AI 子功能的生效條件都是
  // `enableAi && <子 pref>`（AND 於 term_view.js 匯總）——關掉即全部停用，但子
  // 選項的值原樣保留，重開就回到先前的組合。UI 在設定的 "ai" 分頁。
  enableAi: false,
  // 好讀「左圖右文」的裝置端 AI 校正。預設關：模型首次使用要下載數 GB，且只有
  // Chrome 有 —— 開啟（且總開關開）後文章頁才會多出 AI 浮動按鈕。
  enableCaptionAi: false,
  // 裸網域的裝置端 AI 複核。預設關，理由同 enableCaptionAi。開啟後只會**減少**
  // 誤連的連結（單向收縮），且依附 enableBareDomainLink。
  enableUrlAi: false,

  // enhanced add-on
  showFloorNumbers: true,
  mergeSameAuthorComments: true, // 好讀：連續同作者推文合併成一段
  highlightAuthorComments: true,
  enableAutoFixUrl: true, // detect & show a repaired link below a broken URL
  // 裸網域（無 scheme、無路徑，如 indiegametw.com）原位變成可點連結。
  enableBareDomainLink: true,
  enableXMentionLink: true, // auto-link @handle to x.com when the X account exists
  blacklist: "", // newline-separated user ids
  titleBlacklist: "", // newline-separated title keywords (board-list only)
  autoLogin: false,
  autoLoginUser: "",
  autoLoginPassword: "",
  // Base32 TOTP secret for PTT's 2FA (see src/js/totp.js). Empty means either
  // "no 2FA on this account" or "I'd rather type the 6 digits myself" — both
  // end the same way: auto-login fills in account+password and hands the
  // keyboard back at the verification prompt.
  autoLoginOtpSecret: "",
  autoLoginDupConn: "N", // 'Y' | 'N': answer when a duplicate login is detected
  autoLoginSkipWelcome: true,

  // local-only (never synced to cloud — see LOCAL_ONLY_PREF_KEYS in
  // pref_sync_logic.js; UI lives in the "local" prefs tab)
  // Work mode: CSS-only remap of the 16 ANSI colors to muted grays so the
  // screen passes as a mainstream dark-theme web page. Render-layer only.
  enableWorkMode: false
};

const PREF_STORAGE_KEY = "pttchrome.pref.v1";

export const readValuesWithDefault = () => {
  try {
    return {
      ...DEFAULT_PREFS,
      ...JSON.parse(window.localStorage.getItem(PREF_STORAGE_KEY)).values
    };
  } catch (e) {
    return {
      ...DEFAULT_PREFS
    };
  }
};

export const writeValues = values => {
  try {
    window.localStorage.setItem(
      PREF_STORAGE_KEY,
      JSON.stringify({
        values
      })
    );
  } catch (e) {}
  return values;
};

// Auto-login migration (see src/js/auto_login.js): wipe the legacy plaintext
// credentials once the browser credential store has been confirmed to hold
// them. The username goes too — it serves no purpose without the password
// (the browser store supplies both via cred.id/cred.password).
//
// The OTP secret is only dropped when `clearSecret` says the credential we got
// back really carried one. A stored credential that is still a bare password
// (not yet re-packed, see credential_pack.js) means the secret exists on this
// machine ONLY, so clearing it unconditionally would lose it for good.
export const clearLegacyAutoLoginCredential = ({ clearSecret = false } = {}) => {
  const v = readValuesWithDefault();
  const stale =
    v.autoLoginPassword || v.autoLoginUser || (clearSecret && v.autoLoginOtpSecret);
  if (!stale) return;
  writeValues({
    ...v,
    autoLoginUser: "",
    autoLoginPassword: "",
    autoLoginOtpSecret: clearSecret ? "" : v.autoLoginOtpSecret
  });
};
