import { DEFAULT_PROXY_HOST, proxySiteFromPrefs } from "../../src/js/util";

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
