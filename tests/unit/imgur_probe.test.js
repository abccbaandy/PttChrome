// imgur 資產型別探測（src/js/imgur_probe.js）。
// 背景：imgur 忽略 URL 副檔名只在「原始檔是圖片」時成立；影片型資產（現代 imgur 把
// 動畫存成 video/mp4）的任何圖片副檔名都只回單幀靜態縮圖 → 動圖被靜音。
import {
  classifyImgurAsset,
  probeImgurAsset,
  clearImgurProbeCache,
} from "../../src/js/imgur_probe";

const res = (contentType, ok = true) => ({
  ok,
  headers: { get: (n) => (n.toLowerCase() === "content-type" ? contentType : null) },
});

describe("classifyImgurAsset 決策表", () => {
  test("image/gif → gif（原檔會動，不可改要 webp）", () => {
    expect(classifyImgurAsset({ imageContentType: "image/gif", mp4Ok: true })).toBe("gif");
    expect(classifyImgurAsset({ imageContentType: "image/gif", mp4Ok: false })).toBe("gif");
  });

  test("非 gif 圖片 + mp4 可取 → video（影片型動圖）", () => {
    expect(classifyImgurAsset({ imageContentType: "image/jpeg", mp4Ok: true })).toBe(
      "video",
    );
  });

  test("非 gif 圖片 + 無 mp4 → static（可安心吃 webp）", () => {
    expect(classifyImgurAsset({ imageContentType: "image/png", mp4Ok: false })).toBe(
      "static",
    );
  });

  test("非圖片／缺 content-type → unknown（維持保守行為）", () => {
    expect(classifyImgurAsset({ imageContentType: "text/html", mp4Ok: true })).toBe(
      "unknown",
    );
    expect(classifyImgurAsset({ imageContentType: null, mp4Ok: false })).toBe("unknown");
  });

  test("content-type 帶 charset / 大小寫不影響判定", () => {
    expect(
      classifyImgurAsset({ imageContentType: "IMAGE/GIF; charset=binary", mp4Ok: false }),
    ).toBe("gif");
  });
});

describe("probeImgurAsset", () => {
  beforeEach(() => clearImgurProbeCache());

  const stub = (map) =>
    vi.fn((url) => {
      const r = map[url];
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    });

  test("影片型資產（.jpg 回 image/jpeg、.mp4 200）→ video", async () => {
    const fetchImpl = stub({
      "https://i.imgur.com/lP0NHpE.jpg": res("image/jpeg"),
      "https://i.imgur.com/lP0NHpE.mp4": res("video/mp4"),
    });
    expect(await probeImgurAsset("lP0NHpE", { fetchImpl })).toBe("video");
  });

  test("兩發都用 HEAD、都不帶 referer", async () => {
    const fetchImpl = stub({
      "https://i.imgur.com/x1.jpg": res("image/jpeg"),
      "https://i.imgur.com/x1.mp4": res("text/html", false),
    });
    await probeImgurAsset("x1", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init.method).toBe("HEAD");
      expect(init.referrerPolicy).toBe("no-referrer");
    }
  });

  test("gif 原檔（.jpg 回 image/gif）→ gif，即使 mp4 衍生存在", async () => {
    const fetchImpl = stub({
      "https://i.imgur.com/auVUJzV.jpg": res("image/gif"),
      "https://i.imgur.com/auVUJzV.mp4": res("video/mp4"),
    });
    expect(await probeImgurAsset("auVUJzV", { fetchImpl })).toBe("gif");
  });

  test("靜態圖（.mp4 回 400 Not an animated gif）→ static", async () => {
    const fetchImpl = stub({
      "https://i.imgur.com/456CKaj.jpg": res("image/jpeg"),
      "https://i.imgur.com/456CKaj.mp4": res("text/html", false),
    });
    expect(await probeImgurAsset("456CKaj", { fetchImpl })).toBe("static");
  });

  test("圖片探測失敗（斷網／CORS）→ unknown，不 reject", async () => {
    const fetchImpl = stub({
      "https://i.imgur.com/boom01.jpg": new Error("network"),
      "https://i.imgur.com/boom01.mp4": new Error("network"),
    });
    await expect(probeImgurAsset("boom01", { fetchImpl })).resolves.toBe("unknown");
  });

  test("同一 id 只探一輪（同一篇文章可能出現多次）", async () => {
    const fetchImpl = stub({
      "https://i.imgur.com/dupe01.jpg": res("image/jpeg"),
      "https://i.imgur.com/dupe01.mp4": res("text/html", false),
    });
    const a = probeImgurAsset("dupe01", { fetchImpl });
    const b = probeImgurAsset("dupe01", { fetchImpl });
    expect(a).toBe(b);
    await a;
    await probeImgurAsset("dupe01", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("fetch 同步丟例外也降級 unknown", async () => {
    const fetchImpl = vi.fn(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(probeImgurAsset("throw1", { fetchImpl })).resolves.toBe("unknown");
  });
});

// 探測走快取代理時，**只有 .jpg 那一發能改**。.mp4 若也送進代理會撞上白名單的 404
// → mp4Ok=false → 影片型動圖被誤判成 static → 動圖被靜音（回報案例 lP0NHpE）。
describe("probeImgurAsset：快取代理", () => {
  beforeEach(() => clearImgurProbeCache());

  const PROXY = { enabled: true, base: "https://proxy.example.dev" };

  const stub = (map) =>
    vi.fn((url) => {
      const r = map[url];
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    });

  test("代理開啟：.jpg 走代理、.mp4 仍直連 i.imgur.com", async () => {
    const fetchImpl = stub({
      "https://proxy.example.dev/lP0NHpE.jpg": res("image/jpeg"),
      "https://i.imgur.com/lP0NHpE.mp4": res("video/mp4"),
    });
    // 誤把 .mp4 也送進代理的話，這裡拿不到 mp4 回應 → 會變成 "static"。
    expect(
      await probeImgurAsset("lP0NHpE", { fetchImpl, proxyConfig: PROXY }),
    ).toBe("video");
    const urls = fetchImpl.mock.calls.map(([u]) => u);
    expect(urls).toContain("https://proxy.example.dev/lP0NHpE.jpg");
    expect(urls).toContain("https://i.imgur.com/lP0NHpE.mp4");
  });

  test("代理開啟不影響四種分類（gif / static / unknown）", async () => {
    const cases = [
      ["gifid1", "image/gif", res("video/mp4"), "gif"],
      ["statid", "image/png", res("text/html", false), "static"],
      ["htmlid", "text/html", res("text/html", false), "unknown"],
    ];
    for (const [id, jpgType, mp4Res, want] of cases) {
      const fetchImpl = stub({
        [`https://proxy.example.dev/${id}.jpg`]: res(jpgType),
        [`https://i.imgur.com/${id}.mp4`]: mp4Res,
      });
      expect(await probeImgurAsset(id, { fetchImpl, proxyConfig: PROXY })).toBe(
        want,
      );
    }
  });

  test("代理關閉：兩發都打 i.imgur.com（與整合前相同）", async () => {
    const fetchImpl = stub({
      "https://i.imgur.com/plain1.jpg": res("image/jpeg"),
      "https://i.imgur.com/plain1.mp4": res("text/html", false),
    });
    expect(
      await probeImgurAsset("plain1", {
        fetchImpl,
        proxyConfig: { enabled: false },
      }),
    ).toBe("static");
    for (const [u] of fetchImpl.mock.calls) {
      expect(u.startsWith("https://i.imgur.com/")).toBe(true);
    }
  });
});
