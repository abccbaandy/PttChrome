// 開站快取的頁面端（src/js/open_cache.js）：照 pref 註冊／移除 Service Worker。
// SW 本身的行為由 tests/unit/open_cache_sw.test.js 守。
import {
  applyOpenCache,
  removeOpenCache,
  OPEN_CACHE_PREFIX,
  _resetOpenCacheForTest,
} from "../../src/js/open_cache";
import { DEFAULT_PREFS, NATIVE_SAFE_MODE_KEYS } from "../../src/js/pref_storage";

const PAGE = "https://example.test/PttChrome/";

function fakeWindow({ readyState = "complete", serviceWorker = true, regs = [], cacheNames = [] } = {}) {
  const loadListeners = [];
  const caches = {
    names: [...cacheNames],
    keys: vi.fn(async () => [...caches.names]),
    delete: vi.fn(async (n) => {
      caches.names = caches.names.filter((x) => x !== n);
      return true;
    }),
  };
  const sw = serviceWorker
    ? {
        register: vi.fn(async () => ({})),
        getRegistrations: vi.fn(async () => regs),
      }
    : undefined;
  return {
    document: { readyState },
    location: { href: PAGE + "#Gossiping/M.1.A.ABC" },
    navigator: { serviceWorker: sw },
    caches,
    addEventListener: (type, fn) => {
      if (type === "load") loadListeners.push(fn);
    },
    fireLoad() {
      this.document.readyState = "complete";
      loadListeners.splice(0).forEach((fn) => fn());
    },
  };
}

const reg = (scriptURL) => ({ active: { scriptURL }, unregister: vi.fn(async () => true) });

beforeEach(() => _resetOpenCacheForTest());

describe("open cache（頁面端）", () => {
  test("預設開；不送鍵 ⇒ 不在安全模式名單", () => {
    expect(DEFAULT_PREFS.enableOpenCache).toBe(true);
    expect(NATIVE_SAFE_MODE_KEYS).not.toContain("enableOpenCache");
  });

  test("開：等頁面 load 完才註冊 sw.js（不跟開站搶頻寬）", () => {
    const win = fakeWindow({ readyState: "loading" });
    applyOpenCache(true, { win, developerMode: false });
    expect(win.navigator.serviceWorker.register).not.toHaveBeenCalled();
    win.fireLoad();
    expect(win.navigator.serviceWorker.register).toHaveBeenCalledWith("sw.js");
  });

  test("每次存設定都會再呼叫一次：同一個值只套一次", () => {
    const win = fakeWindow();
    applyOpenCache(true, { win, developerMode: false });
    applyOpenCache(true, { win, developerMode: false });
    expect(win.navigator.serviceWorker.register).toHaveBeenCalledTimes(1);
  });

  test("dev server 不註冊", () => {
    const win = fakeWindow();
    applyOpenCache(true, { win, developerMode: true });
    expect(win.navigator.serviceWorker.register).not.toHaveBeenCalled();
  });

  test("沒有 Service Worker 的環境（http 區網 dev 等）安靜略過", () => {
    const win = fakeWindow({ serviceWorker: false });
    expect(() => applyOpenCache(true, { win, developerMode: false })).not.toThrow();
    expect(() => applyOpenCache(false, { win, developerMode: false })).not.toThrow();
  });

  test("關：只 unregister 本站的 sw.js、只刪本功能的 cache", async () => {
    const ours = reg(PAGE + "sw.js");
    const other = reg("https://example.test/PttChrome/other-sw.js");
    const win = fakeWindow({ regs: [ours, other], cacheNames: [OPEN_CACHE_PREFIX + "v1", "firebase-cache"] });
    applyOpenCache(false, { win, developerMode: false });
    await removeOpenCache(win);
    expect(ours.unregister).toHaveBeenCalled();
    expect(other.unregister).not.toHaveBeenCalled();
    expect(win.caches.names).toEqual(["firebase-cache"]);
    expect(win.navigator.serviceWorker.register).not.toHaveBeenCalled();
  });

  test("load 前就被關掉：不會再註冊回來", () => {
    const win = fakeWindow({ readyState: "loading" });
    applyOpenCache(true, { win, developerMode: false });
    applyOpenCache(false, { win, developerMode: false });
    win.fireLoad();
    expect(win.navigator.serviceWorker.register).not.toHaveBeenCalled();
  });

  test("關了再開：重新註冊", () => {
    const win = fakeWindow();
    applyOpenCache(true, { win, developerMode: false });
    applyOpenCache(false, { win, developerMode: false });
    applyOpenCache(true, { win, developerMode: false });
    expect(win.navigator.serviceWorker.register).toHaveBeenCalledTimes(2);
  });

  test("註冊失敗只記 log，不丟例外", async () => {
    const win = fakeWindow();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    win.navigator.serviceWorker.register.mockRejectedValueOnce(new Error("SecurityError"));
    applyOpenCache(true, { win, developerMode: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
