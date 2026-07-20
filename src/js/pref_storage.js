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
  // full ws(s)telnet:// URL. Default off; the default host is a public CF Worker relay.
  useProxy: false,
  proxyUrl: "ptt-proxy.ptt-relay-8xquy.workers.dev",

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

  // enhanced add-on
  showFloorNumbers: true,
  mergeSameAuthorComments: true, // 好讀：連續同作者推文合併成一段
  highlightAuthorComments: true,
  enableAutoFixUrl: true, // detect & show a repaired link below a broken URL
  enableXMentionLink: true, // auto-link @handle to x.com when the X account exists
  blacklist: "", // newline-separated user ids
  titleBlacklist: "", // newline-separated title keywords (board-list only)
  autoLogin: false,
  autoLoginUser: "",
  autoLoginPassword: "",
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
export const clearLegacyAutoLoginCredential = () => {
  const v = readValuesWithDefault();
  if (v.autoLoginPassword || v.autoLoginUser) {
    writeValues({ ...v, autoLoginUser: "", autoLoginPassword: "" });
  }
};
