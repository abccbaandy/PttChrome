// imgur 原圖（jpeg/png）的傳輸在 imgur 端有 per-request 長尾：真 Chromium、獨立
// 快取、同一瞬間請求同一 URL 實測 0.8s / 2.5s / 8.8s。同一 hash 的 `.webp` 衍生檔
// 解析度完全相同、體積約 1/5，且量測中不出現長尾 → 一律優先要 webp，並把原副檔名
// 留作候選（走既有的 FallbackImage srcset 鏈），webp 不存在時自動退回，行為不退步。
// 背景與實測數據見 docs/media-preview-addons.md。
//
// 動圖（gif/gifv）刻意不轉 webp：imgur 動畫 webp 的行為未經實測驗證，不猜。

import { render } from "@testing-library/react";
import ImagePreviewer, {
  resolveSrcToImageUrl,
} from "../../src/components/ImagePreviewer";
import { clearImgurProbeCache } from "../../src/js/imgur_probe";
import {
  resetImgurProxyConfig,
  setImgurProxyConfig,
} from "../../src/js/imgur_proxy";

const resolve = (src) => resolveSrcToImageUrl({ src });
const B = "https://i.imgur.com";

// 副檔名未知 / gif 系的連結會先發兩發 HEAD 探測（見 src/js/imgur_probe.js）。
// 這裡把探測結果釘死，unit 一律不連網。
const headRes = (contentType, ok = true) => ({
  ok,
  headers: { get: () => contentType },
});
const stubProbe = ({ image = "image/jpeg", mp4 = null }) =>
  vi.stubGlobal(
    "fetch",
    vi.fn((url) =>
      Promise.resolve(
        /\.mp4$/.test(url)
          ? mp4
            ? headRes(mp4)
            : headRes("text/html", false) // 靜態圖：imgur 回 400 "Not an animated gif"
          : headRes(image),
      ),
    ),
  );

describe("imgur 單圖 resolver：webp 優先 + 原副檔名 fallback", () => {
  beforeEach(() => clearImgurProbeCache());
  afterEach(() => vi.unstubAllGlobals());

  test(".jpeg → 先要 webp，原副檔名留作候選", async () => {
    expect(await resolve(`${B}/ofT90A6.jpeg`)).toEqual({
      type: "image",
      src: `${B}/ofT90A6.webp`,
      srcset: [`${B}/ofT90A6.webp`, `${B}/ofT90A6.jpeg`],
    });
  });

  test(".png 同樣走 webp 優先", async () => {
    const r = await resolve(`${B}/abc123.png`);
    expect(r.src).toBe(`${B}/abc123.webp`);
    expect(r.srcset).toEqual([`${B}/abc123.webp`, `${B}/abc123.png`]);
  });

  // 迴歸守護（動圖會被靜音成一張圖）：imgur 對**圖片原檔**忽略 URL 副檔名，一律回
  // 儲存的原始格式——實測 `auVUJzV.jpg` 與 `.png` 都回 `image/gif` 10.85 MB 完整動畫。
  // 一旦改成 webp 就變成靜態單幀，而且 <img> 會 onload 成功、FallbackImage 根本不會
  // 退回。→ 探測到 gif 原檔時只能用原檔，不得產生 webp 候選。
  test("無副檔名 + 探測到 gif 原檔 → 用 .gif 原檔，不可改要 webp", async () => {
    stubProbe({ image: "image/gif" });
    expect(await resolve("https://imgur.com/auVUJzV")).toEqual({
      type: "image",
      src: `${B}/auVUJzV.gif`,
    });
  });

  // 探測確認是真靜態圖後才敢吃 webp（舊行為是「未知一律不碰」，等於放棄優化）。
  test("無副檔名 + 探測到靜態圖 → webp 優先，.jpg 留作候選", async () => {
    stubProbe({ image: "image/jpeg" });
    expect(await resolve("https://imgur.com/456CKaj")).toEqual({
      type: "image",
      src: `${B}/456CKaj.webp`,
      srcset: [`${B}/456CKaj.webp`, `${B}/456CKaj.jpg`],
    });
  });

  test("探測失敗（斷網／CORS）→ 退回既有的 .jpg 行為，不炸", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    expect(await resolve("https://imgur.com/abc123")).toEqual({
      type: "image",
      src: `${B}/abc123.jpg`,
    });
  });

  test("m. / i. 前綴一律正規化到 i.imgur.com（既有行為不變）", async () => {
    expect((await resolve("https://m.imgur.com/abc123.jpg")).src).toBe(
      `${B}/abc123.webp`,
    );
  });

  test("原本就是 .webp → 原樣使用，不產生重複候選", async () => {
    expect(await resolve(`${B}/abc123.webp`)).toEqual({
      type: "image",
      src: `${B}/abc123.webp`,
    });
  });

  // 回歸守護：別順手把動圖也改成 webp（imgur 的 webp 衍生對 gif 只回靜態單幀）。
  test(".gif（探測確認是 gif 原檔）不轉 webp", async () => {
    stubProbe({ image: "image/gif" });
    expect(await resolve(`${B}/abc123.gif`)).toEqual({
      type: "image",
      src: `${B}/abc123.gif`,
    });
  });

  test(".gifv（探測確認是 gif 原檔）→ .gif，同樣不轉 webp", async () => {
    stubProbe({ image: "image/gif" });
    expect(await resolve(`${B}/abc123.gifv`)).toEqual({
      type: "image",
      src: `${B}/abc123.gif`,
    });
  });
});

// 回報案例：https://imgur.com/lP0NHpE 自動開圖變成靜態圖。
// imgur 把上傳的動畫／影片存成 video/mp4，這類資產的**任何**圖片副檔名都只回單幀
// 靜態縮圖（實測 lP0NHpE.jpg 與 .gif 都是 200 image/jpeg 33469），而 <img> 會 onload
// 成功 → FallbackImage 不會退回 ⇒ 動圖被靜音。只有 .mp4（200 video/mp4）會動。
describe("imgur 影片型動圖：必須內嵌成 video 而非靜態圖", () => {
  beforeEach(() => clearImgurProbeCache());
  afterEach(() => vi.unstubAllGlobals());

  test("無副檔名 + 探測到 mp4 → video descriptor", async () => {
    stubProbe({ image: "image/jpeg", mp4: "video/mp4" });
    expect(await resolve("https://imgur.com/lP0NHpE")).toEqual({
      type: "video",
      src: `${B}/lP0NHpE.mp4`,
    });
  });

  test(".gifv 指到影片型資產時也要回 video（不可盲目改寫成 .gif）", async () => {
    stubProbe({ image: "image/jpeg", mp4: "video/mp4" });
    expect(await resolve(`${B}/lP0NHpE.gifv`)).toEqual({
      type: "video",
      src: `${B}/lP0NHpE.mp4`,
    });
  });

  // 症狀層：鎖「渲染成什麼元素」而非 descriptor 形狀。
  test("渲染成 <video>，畫面上不得出現 <img>", async () => {
    stubProbe({ image: "image/jpeg", mp4: "video/mp4" });
    const value = await resolve("https://imgur.com/lP0NHpE");
    const { container } = render(<ImagePreviewer.Inline value={value} />);
    expect(container.querySelector("video")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });
});

// 迴歸守護（真實回報：好讀模式自動開圖對 https://i.imgur.com/8MYpXhr.mp4 顯示
// 「圖片載入失敗，點擊重試」）：imgur 單圖 resolver 排在通用影片 resolver 之前，
// 影片直連被它吃掉後回 {type:"image"} → 塞進 <img> 永遠 decode 失敗。相簿路徑早就
// 有影片分流，只有單一連結漏掉。
describe("imgur 影片直連：必須產 video descriptor，不可當圖片載", () => {
  test(".mp4 → video，不是 image", async () => {
    expect(await resolve(`${B}/8MYpXhr.mp4`)).toEqual({
      type: "video",
      src: `${B}/8MYpXhr.mp4`,
    });
  });

  test("無 i. 前綴的 imgur.com/<id>.mp4 也正規化到 i.imgur.com 並回 video", async () => {
    expect(await resolve("https://imgur.com/abc123.mp4")).toEqual({
      type: "video",
      src: `${B}/abc123.mp4`,
    });
  });

  // 症狀層：鎖「渲染成什麼元素」而非 descriptor 形狀。
  test("渲染成 <video>，畫面上不得出現 <img>", async () => {
    const value = await resolve(`${B}/8MYpXhr.mp4`);
    const { container } = render(<ImagePreviewer.Inline value={value} />);
    expect(container.querySelector("video")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("imgur 相簿：展開的每張圖也走 webp 優先", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubAlbum = (links) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          json: () =>
            Promise.resolve({ data: { images: links.map((l) => ({ link: l })) } }),
        }),
      ),
    );

  test("相簿圖片項帶 webp srcset，影片項仍是 video", async () => {
    stubAlbum([`${B}/aaa111.jpeg`, `${B}/bbb222.mp4`, `${B}/ccc333.gif`]);
    const r = await resolve("https://imgur.com/a/hash12");
    expect(r.type).toBe("album");
    expect(r.images).toEqual([
      {
        type: "image",
        src: `${B}/aaa111.webp`,
        srcset: [`${B}/aaa111.webp`, `${B}/aaa111.jpeg`],
      },
      { type: "video", src: `${B}/bbb222.mp4` },
      { type: "image", src: `${B}/ccc333.gif` },
    ]);
  });

  test("API 失敗 → 空相簿，不炸", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("boom"))));
    expect(await resolve("https://imgur.com/gallery/hash12")).toEqual({
      type: "album",
      images: [],
    });
  });
});

// 快取代理（proxy/imgur-worker）開啟後的候選清單。硬約束有二：
//   1. 原址永遠留在候選清單後面 —— Worker 掛掉／額度用盡（Error 1027）時
//      FallbackImage 自動退回現況，代理不會變成單點故障。
//   2. 影片一律不代理 —— 代理白名單擋影片會回 404，等於自製一個載入失敗。
describe("imgur 快取代理：代理優先、原址墊底", () => {
  const PROXY = "https://proxy.example.dev";

  beforeEach(() => {
    clearImgurProbeCache();
    setImgurProxyConfig({ enabled: true, base: PROXY });
  });
  afterEach(() => {
    resetImgurProxyConfig();
    vi.unstubAllGlobals();
  });

  test("靜態圖：代理 webp 第一順位，原址 webp／jpg 墊底", async () => {
    stubProbe({ image: "image/jpeg" });
    expect(await resolve("https://imgur.com/456CKaj")).toEqual({
      type: "image",
      src: `${PROXY}/456CKaj.webp`,
      srcset: [`${PROXY}/456CKaj.webp`, `${B}/456CKaj.webp`, `${B}/456CKaj.jpg`],
    });
  });

  test("明寫副檔名的靜態圖同樣代理優先", async () => {
    expect(await resolve(`${B}/ofT90A6.jpeg`)).toEqual({
      type: "image",
      src: `${PROXY}/ofT90A6.webp`,
      srcset: [`${PROXY}/ofT90A6.webp`, `${B}/ofT90A6.webp`, `${B}/ofT90A6.jpeg`],
    });
  });

  test("gif 原檔：代理 .gif 優先，仍不得產生 webp 候選", async () => {
    stubProbe({ image: "image/gif" });
    expect(await resolve("https://imgur.com/auVUJzV")).toEqual({
      type: "image",
      src: `${PROXY}/auVUJzV.gif`,
      srcset: [`${PROXY}/auVUJzV.gif`, `${B}/auVUJzV.gif`],
    });
  });

  test("探測失敗（unknown）也代理，但保留 i.imgur.com fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    expect(await resolve("https://imgur.com/abc123")).toEqual({
      type: "image",
      src: `${PROXY}/abc123.jpg`,
      srcset: [`${PROXY}/abc123.jpg`, `${B}/abc123.jpg`],
    });
  });

  // 這兩條是本組最重要的守護：影片一旦被送進代理就是 404。
  test("影片直連不代理", async () => {
    expect(await resolve(`${B}/8MYpXhr.mp4`)).toEqual({
      type: "video",
      src: `${B}/8MYpXhr.mp4`,
    });
  });

  test("探測到影片型動圖不代理", async () => {
    stubProbe({ image: "image/jpeg", mp4: "video/mp4" });
    expect(await resolve("https://imgur.com/lP0NHpE")).toEqual({
      type: "video",
      src: `${B}/lP0NHpE.mp4`,
    });
  });

  test("相簿展開的每張圖也吃到代理，影片項不受影響", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          json: () =>
            Promise.resolve({
              data: {
                images: [{ link: `${B}/aaa111.jpeg` }, { link: `${B}/bbb222.mp4` }],
              },
            }),
        }),
      ),
    );
    const r = await resolve("https://imgur.com/a/hash12");
    expect(r.images).toEqual([
      {
        type: "image",
        src: `${PROXY}/aaa111.webp`,
        srcset: [`${PROXY}/aaa111.webp`, `${B}/aaa111.webp`, `${B}/aaa111.jpeg`],
      },
      { type: "video", src: `${B}/bbb222.mp4` },
    ]);
  });

  // 症狀層：實際渲染出來的 <img> src 要是代理位址，且 referrerPolicy 不能掉。
  test("渲染出的 <img> 指向代理且仍不帶 referer", async () => {
    stubProbe({ image: "image/jpeg" });
    const value = await resolve("https://imgur.com/456CKaj");
    const { container } = render(<ImagePreviewer.Inline value={value} />);
    const img = container.querySelector("img");
    expect(img.getAttribute("src")).toBe(`${PROXY}/456CKaj.webp`);
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
  });
});

// imgur 對 `Referer: *.ptt.cc` 直接回 403（實測：https://www.ptt.cc/... 與
// https://term.ptt.cc/ 皆 403、0 bytes；無 referer 則 200）。referrerPolicy 一旦被
// 拿掉就是整批不出圖，故釘一條測試守護。verb.tw 反過來需要 referer，不可加。
describe("referrerPolicy 守護（拿掉 = imgur 403 整批不出圖）", () => {
  const Inline = ImagePreviewer.Inline;
  const imgOf = (value) =>
    render(<Inline value={value} />).container.querySelector("img");

  test("imgur 圖必須帶 referrerpolicy=no-referrer", () => {
    expect(imgOf({ src: `${B}/abc123.webp` }).getAttribute("referrerpolicy"))
      .toBe("no-referrer");
  });

  test("verb.tw 必須不帶（該圖床需要 referer）", () => {
    expect(
      imgOf({ src: "https://i.verb.tw/abc123.jpg" }).getAttribute(
        "referrerpolicy",
      ),
    ).toBeNull();
  });
});
