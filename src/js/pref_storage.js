// Preference storage layer (localStorage). Extracted from PrefModal so that
// non-React modules (main.js, pref_sync.js) can read/write prefs without
// importing a component module.

export const DEFAULT_PREFS = {
  // general
  //dbcsDetect    : false,
  enablePicPreview: true,
  enableNotifications: true,
  enableEasyReading: false,
  endTurnsOnLiveUpdate: false,
  copyOnSelect: false,
  antiIdleTime: 0,
  lineWrap: 78,

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
  highlightAuthorComments: true,
  blacklist: "", // newline-separated user ids
  autoLogin: false,
  autoLoginUser: "",
  autoLoginPassword: "",
  autoLoginDupConn: "N", // 'Y' | 'N': answer when a duplicate login is detected
  autoLoginSkipWelcome: true
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
// password once the browser credential store has been confirmed to hold it.
export const clearLegacyAutoLoginPassword = () => {
  const v = readValuesWithDefault();
  if (v.autoLoginPassword) writeValues({ ...v, autoLoginPassword: "" });
};
