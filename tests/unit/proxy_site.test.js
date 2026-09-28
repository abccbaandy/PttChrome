import { DEFAULT_PROXY_HOST, proxySiteFromPrefs, resolveDefaultSite } from "../../src/js/util";

// proxySiteFromPrefs turns the proxy prefs (useProxy + proxyUrl) into a connect()
// target. main.js uses it between the ?site override and DEFAULT_SITE.
describe("proxySiteFromPrefs", () => {
  it("returns '' when proxy is off (falls back to DEFAULT_SITE upstream)", () => {
    expect(proxySiteFromPrefs({ useProxy: false, proxyUrl: "x.dev" })).toBe("");
  });

  it("returns '' when there are no prefs at all", () => {
    expect(proxySiteFromPrefs(undefined)).toBe("");
    expect(proxySiteFromPrefs({})).toBe("");
  });

  // 欄位空著 ＝ 用 placeholder 顯示的那個公用 relay。使用者把自訂位址整段刪掉時
  // 就回到預設，而不是變成「開了 proxy 卻沒有位址」。
  it("falls back to the default relay when the field is cleared", () => {
    const want = `wsstelnet://${DEFAULT_PROXY_HOST}/bbs`;
    expect(proxySiteFromPrefs({ useProxy: true, proxyUrl: "" })).toBe(want);
    expect(proxySiteFromPrefs({ useProxy: true, proxyUrl: "   " })).toBe(want);
    expect(proxySiteFromPrefs({ useProxy: true })).toBe(want);
  });

  it("wraps a bare host with wsstelnet:// scheme and /bbs path", () => {
    expect(proxySiteFromPrefs({ useProxy: true, proxyUrl: "ptt-proxy.example.dev" }))
      .toBe("wsstelnet://ptt-proxy.example.dev/bbs");
  });

  it("trims surrounding whitespace before wrapping", () => {
    expect(proxySiteFromPrefs({ useProxy: true, proxyUrl: "  host.dev  " }))
      .toBe("wsstelnet://host.dev/bbs");
  });

  it("keeps an explicit scheme but still appends /bbs when no path is given", () => {
    expect(proxySiteFromPrefs({ useProxy: true, proxyUrl: "wstelnet://host.dev" }))
      .toBe("wstelnet://host.dev/bbs");
  });

  it("leaves a full ws(s)telnet:// URL with a path untouched", () => {
    expect(proxySiteFromPrefs({ useProxy: true, proxyUrl: "wsstelnet://host.dev/bbs" }))
      .toBe("wsstelnet://host.dev/bbs");
    expect(proxySiteFromPrefs({ useProxy: true, proxyUrl: "wstelnet://host:8080/custom" }))
      .toBe("wstelnet://host:8080/custom");
  });

  it("appends /bbs to a bare host that carries a port but no path", () => {
    expect(proxySiteFromPrefs({ useProxy: true, proxyUrl: "host.dev:443" }))
      .toBe("wsstelnet://host.dev:443/bbs");
  });
});

// REGRESSION（手機用區網位址開 dev server 連不上／Origin 沒被改寫）：dev 的預設站台
// 以前寫死 wstelnet://localhost:8080/bbs，手機上的 localhost 是手機自己。
// 現在 vite.config.mjs 給的是 {pageHost} 佔位符，runtime 換成 location.host。
describe("resolveDefaultSite", () => {
  it("dev：換成頁面自己的 host（含 port），區網位址開站也打回同一台 dev server", () => {
    expect(resolveDefaultSite("wstelnet://{pageHost}/bbs", "192.168.1.20:8080")).toBe(
      "wstelnet://192.168.1.20:8080/bbs"
    );
    expect(resolveDefaultSite("wstelnet://{pageHost}/bbs", "localhost:8080")).toBe(
      "wstelnet://localhost:8080/bbs"
    );
  });

  it("prod：沒有佔位符就原樣回傳", () => {
    expect(resolveDefaultSite("wsstelnet://ws.ptt.cc/bbs", "example.github.io")).toBe(
      "wsstelnet://ws.ptt.cc/bbs"
    );
  });

  it("沒有 host 可用時退回 localhost:8080；沒有 site 回空字串", () => {
    expect(resolveDefaultSite("wstelnet://{pageHost}/bbs", "")).toBe("wstelnet://localhost:8080/bbs");
    expect(resolveDefaultSite(undefined, "x")).toBe("");
  });

  it("vite.config.mjs 的 dev 預設站台必須用佔位符，不可寫死 localhost", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const cfg = fs.readFileSync(path.join(__dirname, "..", "..", "vite.config.mjs"), "utf8");
    const line = cfg.split("\n").find((l) => l.includes("'process.env.DEFAULT_SITE'"));
    expect(line).toContain("{pageHost}");
    expect(line).not.toContain("localhost:8080");
  });
});
