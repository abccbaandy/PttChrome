// @unit-env browser
// P110 第三步：網頁連結預覽卡接進 ImagePreviewer（resolver＋渲染）。
// 純邏輯（合格連結、Worker 網址、回應驗證、limiter）在 link_card.test.js；這裡鎖：
//   - 哪些連結走卡片 resolver（能開圖的照舊開圖；代理或卡片開關關著 ⇒ 不抓，跟以前一樣什麼都不畫）
//   - 排到時已經沒人要（捲過去了）⇒ 不打 Worker，快取作廢、下次捲回來重抓
//   - 卡片是一條連結：點下去開的是文章裡的原始連結；外部標題只當文字（不解析 HTML）
import "../../src/css/main.css";
import { render } from "@testing-library/react";
import ImagePreviewer, {
  isLinkCardUrl,
  isPreviewableUrl,
  requestPreview,
} from "../../src/components/ImagePreviewer";
import { setImageProxyConfig, resetImageProxyConfig } from "../../src/js/image_proxy";
import {
  isLinkCardStale,
  markLinkCardWanted,
  setLinkPreviewCard,
} from "../../src/js/link_card";

const BASE = "https://proxy.example.workers.dev";
let seq = 0;
// requestPreview 以 href 做 page-lifetime 快取 ⇒ 每個 case 用沒看過的網址。
const freshHref = () => `https://news.example.com/a/${Date.now()}-${++seq}`;

function stubFetch(json, ok = true) {
  const calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
    calls.push(String(url));
    return Promise.resolve({ ok, json: () => Promise.resolve(json) });
  });
  return calls;
}

beforeEach(() => {
  setImageProxyConfig({ enabled: true, base: BASE });
  setLinkPreviewCard(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  resetImageProxyConfig();
  setLinkPreviewCard(true);
});

describe("哪些連結走預覽卡", () => {
  test("一般網頁 ⇒ 卡片（也算可預覽：行動網路下給「點了才抓」鈕）", () => {
    const href = freshHref();
    expect(isLinkCardUrl(href)).toBe(true);
    expect(isPreviewableUrl(href)).toBe(true);
  });

  test.each([
    ["直連圖片", "https://example.com/a.jpg"],
    ["直連影片", "https://example.com/a.mp4"],
    ["imgur", "https://imgur.com/abcdefg"],
    ["PTT 自己", "https://www.ptt.cc/bbs/Test/M.1.A.2.html"],
  ])("%s ⇒ 不是卡片（照舊）", (_n, href) => {
    expect(isLinkCardUrl(href)).toBe(false);
  });

  test("卡片開關關掉 ⇒ 跟以前一樣不可預覽（不抓、不畫）", () => {
    setLinkPreviewCard(false);
    const href = freshHref();
    expect(isLinkCardUrl(href)).toBe(false);
    expect(isPreviewableUrl(href)).toBe(false);
  });

  test("圖片代理關掉 ⇒ 也不抓（不想把瀏覽紀錄送過去）", () => {
    setImageProxyConfig({ enabled: false });
    expect(isPreviewableUrl(freshHref())).toBe(false);
  });
});

describe("請求", () => {
  test("有人要 ⇒ 打 Worker /og，回卡片描述（點了開的是原始連結）", async () => {
    const href = freshHref();
    const calls = stubFetch({ title: "新聞標題", site: "某新聞", image: "https://img.example.com/x.jpg", url: "https://evil.example/" });
    markLinkCardWanted(href, 1);
    try {
      const d = await requestPreview(href);
      expect(calls).toEqual([`${BASE}/og?url=${encodeURIComponent(href)}`]);
      expect(d).toMatchObject({ type: "card", href, title: "新聞標題", site: "某新聞" });
    } finally {
      markLinkCardWanted(href, -1);
    }
  });

  test("REGRESSION 排到時已經沒人要（捲過去了）⇒ 不打 Worker；快取作廢，捲回來重新抓", async () => {
    const href = freshHref();
    const calls = stubFetch({ title: "T" });
    await expect(requestPreview(href)).rejects.toSatisfy(isLinkCardStale);
    expect(calls).toEqual([]);
    markLinkCardWanted(href, 1);
    try {
      await expect(requestPreview(href)).resolves.toMatchObject({ type: "card", title: "T" });
      expect(calls).toHaveLength(1);
    } finally {
      markLinkCardWanted(href, -1);
    }
  });

  test("Worker 錯誤／沒有標題 ⇒ 不放卡（reject）", async () => {
    const a = freshHref();
    const b = freshHref();
    markLinkCardWanted(a, 1);
    markLinkCardWanted(b, 1);
    try {
      stubFetch({ none: true });
      await expect(requestPreview(a)).rejects.toThrow();
      vi.restoreAllMocks();
      stubFetch({}, false);
      await expect(requestPreview(b)).rejects.toThrow();
    } finally {
      markLinkCardWanted(a, -1);
      markLinkCardWanted(b, -1);
    }
  });
});

describe("卡片渲染", () => {
  const mount = (value) => {
    const host = document.createElement("div");
    host.style.width = "640px";
    document.body.appendChild(host);
    const r = render(<ImagePreviewer.Inline value={value} />, { container: host });
    return { host, unmount: () => (r.unmount(), host.remove()) };
  };

  test("整張是一條開新分頁的連結，標題與網站名都在", () => {
    const { host, unmount } = mount({
      type: "card",
      href: "https://news.example.com/a/1",
      title: "新聞標題",
      site: "某新聞",
      image: "",
    });
    try {
      const a = host.querySelector("a.linkCard");
      expect(a.getAttribute("href")).toBe("https://news.example.com/a/1");
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toContain("noreferrer");
      expect(a.querySelector(".linkCardTitle").textContent).toBe("新聞標題");
      expect(a.querySelector(".linkCardSite").textContent).toBe("某新聞");
      expect(a.querySelector("img")).toBeNull();
    } finally {
      unmount();
    }
  });

  // 桌機的終端機列是 white-space:pre（會繼承）：卡片沒自己改回 normal ⇒ 長標題不折行、第二行被裁掉。
  test("REGRESSION 放在 white-space:pre 的終端機裡，長標題照樣折成兩行", () => {
    const { host, unmount } = mount({
      type: "card",
      href: "https://news.example.com/a/4",
      title: "很長的新聞標題".repeat(12),
      site: "S",
      image: "",
    });
    try {
      host.style.whiteSpace = "pre";
      const t = host.querySelector(".linkCardTitle");
      const lh = parseFloat(getComputedStyle(t).lineHeight);
      expect(t.scrollWidth).toBeLessThanOrEqual(t.clientWidth);
      expect(t.clientHeight).toBeGreaterThan(lh * 1.5);
    } finally {
      unmount();
    }
  });

  test("外部標題只當文字：<img onerror> 不會變成元素", () => {
    const { host, unmount } = mount({
      type: "card",
      href: "https://news.example.com/a/2",
      title: '<img src=x onerror="window.__pwned=1">',
      site: "<b>x</b>",
      image: "",
    });
    try {
      expect(host.querySelector(".linkCardTitle img")).toBeNull();
      expect(host.querySelector(".linkCardSite b")).toBeNull();
      expect(host.querySelector(".linkCardTitle").textContent).toContain("<img");
    } finally {
      unmount();
    }
  });

  test("縮圖載不到 ⇒ 收起縮圖、只留文字；卡片高度不變", async () => {
    const { host, unmount } = mount({
      type: "card",
      href: "https://news.example.com/a/3",
      title: "T",
      site: "S",
      image: "https://127.0.0.1:9/nope.jpg",
    });
    try {
      const card = host.querySelector("a.linkCard");
      const h = card.getBoundingClientRect().height;
      expect(h).toBeGreaterThan(0);
      await vi.waitFor(() => expect(host.querySelector("img.linkCardThumb")).toBeNull(), { timeout: 4000 });
      expect(card.getBoundingClientRect().height).toBe(h);
    } finally {
      unmount();
    }
  });
});
