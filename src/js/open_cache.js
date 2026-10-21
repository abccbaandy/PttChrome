// 開站快取的頁面端（docs/open-cache.md）：照 pref enableOpenCache 註冊或移除 public/sw.js。
//
//   開 ⇒ 等頁面 load 完才註冊（不跟開站搶頻寬）；已註冊過就是 no-op。
//   關 ⇒ 完全移除：unregister 本站的 SW＋刪掉它的 cache。這一頁仍由舊 SW 控制到下次開站為止，
//        之後就回到「瀏覽器自己逐檔確認」的原樣。
//
// dev server（DEVELOPER_MODE）不註冊：Vite 的檔名不帶 hash、HMR 也不能被快取擋住。
// 沒有 Service Worker 的環境（http 的區網 dev、隱私模式的部分瀏覽器）安靜略過。

// 跟 public/sw.js 的 CACHE_PREFIX 同一個字串（守護 tests/unit/open_cache_sw.test.js）。
export const OPEN_CACHE_PREFIX = "pttchrome-open-cache-";
export const OPEN_CACHE_SCRIPT = "sw.js";

let applied; // 上次套用的值：onValuesPrefChange 每次存設定都會把全部 pref 掃一遍

function whenLoaded(win, fn) {
  if (win.document.readyState === "complete") fn();
  else win.addEventListener("load", fn, { once: true });
}

function isOurs(reg, win) {
  const worker = reg.active || reg.waiting || reg.installing;
  const scriptURL = worker && worker.scriptURL;
  return !!scriptURL && scriptURL === new URL(OPEN_CACHE_SCRIPT, win.location.href).href;
}

export function removeOpenCache(win = window) {
  const nav = win.navigator;
  const jobs = [];
  if (nav.serviceWorker && nav.serviceWorker.getRegistrations) {
    jobs.push(
      nav.serviceWorker.getRegistrations().then((regs) =>
        Promise.all(regs.filter((r) => isOurs(r, win)).map((r) => r.unregister()))
      )
    );
  }
  if (win.caches) {
    jobs.push(
      win.caches.keys().then((names) =>
        Promise.all(names.filter((n) => n.startsWith(OPEN_CACHE_PREFIX)).map((n) => win.caches.delete(n)))
      )
    );
  }
  return Promise.all(jobs).catch((e) => console.warn("open cache: remove failed", e));
}

export function applyOpenCache(enabled, { win = window, developerMode = !!process.env.DEVELOPER_MODE } = {}) {
  enabled = !!enabled;
  if (applied === enabled) return;
  applied = enabled;
  if (developerMode) return;
  const nav = win.navigator;
  if (!nav.serviceWorker) return;
  if (!enabled) {
    removeOpenCache(win);
    return;
  }
  whenLoaded(win, () => {
    // 載完之前使用者剛好把開關關掉：不要再註冊回來。
    if (!applied) return;
    nav.serviceWorker
      .register(OPEN_CACHE_SCRIPT)
      .catch((e) => console.warn("open cache: register failed", e));
  });
}

export function _resetOpenCacheForTest() {
  applied = undefined;
}
