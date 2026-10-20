import { zh_TW } from './zh_TW_messages';

// 英文語系不在開站必載（docs/build-modernization.md「主 bundle 拆檔」）：中文使用者
// 用不到它。i18n() 是同步 API，所以開站前由 main.jsx 的 loadResources 先 await
// loadI18n()；之後 setupI18n() 照舊同步。unit 測試由 tests/unit/setup.js 預先註冊。
const locale = {
  'zh_tw': zh_TW
};
const loaders = {
  'en_us': () => import('./en_US_messages').then((m) => m.en_US)
};

let i18n_val = {};

export function i18n(str) {
  if (i18n_val[str]) {
    return i18n_val[str].message;
  } else {
    console.log('missing i18n '+str);
  }
}

export function registerLocale(lang, messages) {
  locale[lang] = messages;
}

// 把 getLang() 選到的語系載進來。載入失敗就退回中文（畫面有字總比整頁空白好）。
export function loadI18n() {
  const lang = getLang();
  if (locale[lang] || !loaders[lang]) return Promise.resolve();
  return loaders[lang]().then(
    (messages) => registerLocale(lang, messages),
    (e) => {
      console.log('loadI18n failed (falling back to zh_tw): ' + e);
      registerLocale(lang, zh_TW);
    }
  );
}

export function setupI18n(callback) {
  i18n_val = locale[getLang()] || zh_TW;
}

export function getLang() {
  let langs = navigator.languages ||
    [navigator.language || navigator.userLanguage || ''];
  for (let lang of langs) {
    lang = lang.toLowerCase().replace('-', '_');
    if (lang in locale || lang in loaders) {
      return lang;
    }
  }
  return 'en_us';
}
