// 網頁連結預覽卡（P110）前端純邏輯：哪些連結要卡、開關、Worker 回應驗證、並行上限。
import {
  linkCardEligible,
  linkCardResolveUrl,
  linkCardDescriptor,
  createLimiter,
  LINK_CARD_MAX_TITLE,
} from "../../src/js/link_card.js";
import { DEFAULT_IMGUR_PROXY_BASE } from "../../src/js/image_proxy.js";

describe("linkCardEligible", () => {
  test.each([
    "https://www.ettoday.net/news/20261119/1234.htm",
    "http://blog.example.com/post?id=3",
    "https://drive.google.com/file/d/abc/view",
  ])("要卡：%s", (href) => {
    expect(linkCardEligible(href)).toBe(true);
  });

  test.each([
    ["https://www.ptt.cc/bbs/Gossiping/M.1.A.2.html", "PTT 自己的文章連結（點了在終端機開）"],
    ["https://term.ptt.cc/", "PTT 子網域"],
    ["ftp://example.com/x", "非 http(s)"],
    ["javascript:alert(1)", "javascript:"],
    ["https://127.0.0.1/", "IP"],
    ["https://[::1]/", "IPv6"],
    ["https://localhost/", "單一標籤"],
    ["https://nas.local/", "內網尾碼"],
    ["https://example.com:8080/", "非預設埠"],
    ["https://u:p@example.com/", "帶帳密"],
    ["", "空"],
    ["https://example.com/" + "a".repeat(3000), "太長"],
  ])("不卡：%s（%s）", (href) => {
    expect(linkCardEligible(href)).toBe(false);
  });

  test("看起來像 ptt.cc 但不是的網域照卡", () => {
    expect(linkCardEligible("https://notptt.cc.example.com/")).toBe(true);
    expect(linkCardEligible("https://myptt.cc/")).toBe(true);
  });
});

describe("linkCardResolveUrl", () => {
  const on = { enabled: true, base: "" };
  test("兩個開關都開：預設 Worker＋編碼過的網址", () => {
    expect(linkCardResolveUrl("https://example.com/a?b=1&c=2", on, true)).toBe(
      `${DEFAULT_IMGUR_PROXY_BASE}/og?url=${encodeURIComponent("https://example.com/a?b=1&c=2")}`,
    );
  });
  test("使用者自填的代理位址", () => {
    expect(linkCardResolveUrl("https://example.com/", { enabled: true, base: "my.workers.dev/" }, true)).toBe(
      "https://my.workers.dev/og?url=https%3A%2F%2Fexample.com%2F",
    );
  });
  test("預覽卡開關關、代理總開關關、不合格連結 ⇒ null", () => {
    expect(linkCardResolveUrl("https://example.com/", on, false)).toBeNull();
    expect(linkCardResolveUrl("https://example.com/", { enabled: false }, true)).toBeNull();
    expect(linkCardResolveUrl("https://example.com/", null, true)).toBeNull();
    expect(linkCardResolveUrl("https://www.ptt.cc/bbs/a.html", on, true)).toBeNull();
  });
});

describe("linkCardDescriptor", () => {
  const href = "https://www.example.com/news/1";
  test("正常回應：點卡片開的是文章裡的原始連結，不是 Worker 回的 url", () => {
    expect(
      linkCardDescriptor({ title: "標題", site: "範例", image: "https://img.example.com/a.jpg", url: "https://evil.example/" }, href),
    ).toEqual({ type: "card", href, title: "標題", site: "範例", image: "https://img.example.com/a.jpg" });
  });
  test("沒有標題、none、錯誤、非物件 ⇒ null", () => {
    for (const j of [{ none: true }, { error: "upstream" }, { title: "   " }, { title: 3 }, null, "x", []]) {
      expect(linkCardDescriptor(j, href)).toBeNull();
    }
  });
  test("縮圖只收 https；javascript:／http／帶帳密 ⇒ 空", () => {
    for (const image of ["javascript:alert(1)", "http://img.example.com/a.jpg", "https://u:p@x.example/a.jpg", 5]) {
      expect(linkCardDescriptor({ title: "t", image }, href).image).toBe("");
    }
  });
  test("網站名缺 ⇒ 用網域（去 www.）；標題截長、控制字元收掉", () => {
    const d = linkCardDescriptor({ title: "a\u0000\n b" + "字".repeat(LINK_CARD_MAX_TITLE) }, href);
    expect(d.site).toBe("example.com");
    expect(d.title.startsWith("a b")).toBe(true);
    expect(Array.from(d.title).length).toBe(LINK_CARD_MAX_TITLE);
  });
});

describe("檢查者補的邊界", () => {
  test("內網尾碼跟 Worker（proxy/imgur-worker/src/og.js）對齊", () => {
    expect(linkCardEligible("https://wiki.intranet/")).toBe(false);
    expect(linkCardEligible("https://git.corp/")).toBe(false);
  });
  test(":443 算預設埠、大寫加尾點的 PTT 網域照樣不卡", () => {
    expect(linkCardEligible("https://example.com:443/")).toBe(true);
    expect(linkCardEligible("HTTPS://WWW.PTT.CC./bbs/")).toBe(false);
  });
  test("標題的 bidi 控制字元拿掉（不能把顯示順序反過來）", () => {
    const d = linkCardDescriptor({ title: "a‮b⁦c‏d" }, "https://example.com/");
    expect(d.title).toBe("abcd");
  });
  test("descriptor 自己也檢查原始連結：javascript: 不出卡", () => {
    expect(linkCardDescriptor({ title: "t" }, "javascript:alert(1)")).toBeNull();
  });
  test("limiter 的 n 不合理（0、NaN）當成 1", async () => {
    for (const n of [0, NaN, -3]) {
      const limit = createLimiter(n);
      let running = 0;
      let peak = 0;
      const task = () => {
        peak = Math.max(peak, ++running);
        return Promise.resolve().then(() => running--);
      };
      await Promise.all([limit(task), limit(task)]);
      expect(peak).toBe(1);
    }
  });
});

describe("createLimiter", () => {
  test("同時最多 n 個，完成一個才開下一個，照順序", async () => {
    const limit = createLimiter(2);
    const started = [];
    const resolvers = [];
    const tasks = [0, 1, 2, 3].map((i) =>
      limit(() => {
        started.push(i);
        return new Promise((r) => resolvers.push(() => r(i)));
      }),
    );
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    resolvers[0]();
    await tasks[0];
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    resolvers[1]();
    resolvers[2]();
    await Promise.all([tasks[1], tasks[2]]);
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2, 3]);
    resolvers[3]();
    expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3]);
  });
  test("失敗（含同步丟例外）也會放出名額", async () => {
    const limit = createLimiter(1);
    await expect(limit(() => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(
      limit(() => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    expect(await limit(() => Promise.resolve(7))).toBe(7);
  });
});
