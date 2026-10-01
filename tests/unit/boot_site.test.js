// @vitest-environment jsdom
// 開站 connect() 目標的優先序（src/js/boot_site.js）。
// 重點守護：Android APK 的本機 proxy 只在讀取端覆寫，**不寫回 prefs**。
// 第三方 demo 曾把 useProxy/proxyUrl 寫進 localStorage，prefs 經 pref_sync
// 同步到桌機後，桌機就改去連 127.0.0.1 而連不上。
import { bootSite } from "../../src/js/boot_site";
import { proxySiteFromPrefs, defaultSite } from "../../src/js/util";
import { DEFAULT_PREFS, readValuesWithDefault } from "../../src/js/pref_storage";
import { siteToWsUrl } from "../../src/js/connection_probe";

const ANDROID = "wstelnet://127.0.0.1:4321/bbs/tok";

afterEach(() => {
  delete window.__PTT_ANDROID__;
  window.localStorage.clear();
});

test("browser without proxy → default site", () => {
  expect(bootSite({ ...DEFAULT_PREFS }, "")).toBe(defaultSite());
});

test("browser with proxy pref → proxy", () => {
  const prefs = { ...DEFAULT_PREFS, useProxy: true, proxyUrl: "relay.example" };
  expect(bootSite(prefs, "")).toBe(proxySiteFromPrefs(prefs));
});

test("Android app → native proxy, even over the user proxy pref", () => {
  window.__PTT_ANDROID__ = { site: ANDROID };
  const prefs = { ...DEFAULT_PREFS, useProxy: true, proxyUrl: "relay.example" };
  expect(bootSite(prefs, "")).toBe(ANDROID);
});

test("?site override still wins (dev only)", () => {
  window.__PTT_ANDROID__ = { site: ANDROID };
  expect(bootSite({ ...DEFAULT_PREFS }, "wstelnet://x/bbs")).toBe("wstelnet://x/bbs");
});

test("Android app never writes the native proxy into prefs", () => {
  window.__PTT_ANDROID__ = { site: ANDROID };
  const before = window.localStorage.getItem("pttchrome.pref.v1");
  bootSite(readValuesWithDefault(), "");
  expect(window.localStorage.getItem("pttchrome.pref.v1")).toBe(before);
  const v = readValuesWithDefault();
  expect(v.useProxy).toBe(false);
  expect(v.proxyUrl).toBe("");
});

// 本機 proxy 只收 /bbs/<token>（android/…/WsProtocol.kt#evaluate），少了 token 就 404。
// App.connect 用 siteToWsUrl 組 WebSocket URL，多段路徑必須完整保留。
test("the native proxy token survives the site → WebSocket URL conversion", () => {
  expect(siteToWsUrl(ANDROID)).toBe("ws://127.0.0.1:4321/bbs/tok");
});
