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

const resolve = (src) => resolveSrcToImageUrl({ src });
const B = "https://i.imgur.com";

describe("imgur 單圖 resolver：webp 優先 + 原副檔名 fallback", () => {
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

  // 迴歸守護（動圖會被靜音成一張圖）：imgur **忽略 URL 副檔名**，一律回儲存的原始
  // 格式——實測 `auVUJzV.jpg` 與 `auVUJzV.png` 都回 `image/gif` 10.85 MB 完整動畫，
  // `ofT90A6.png`/`.gif` 都回 `image/jpeg`。所以無副檔名時補的 `.jpg` 其實拿得到原
  // 檔（動圖仍會動），一旦改成 webp 就變成靜態單幀，而且 <img> 會 onload 成功、
  // FallbackImage 根本不會退回。→ 副檔名未知時一律不碰。
  test("無副檔名（imgur.com/<id>）→ 維持 .jpg 原檔，不可改要 webp", async () => {
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

  // 回歸守護：別順手把動圖也改成 webp（動畫 webp 未驗證）。
  test(".gif 不轉 webp", async () => {
    expect(await resolve(`${B}/abc123.gif`)).toEqual({
      type: "image",
      src: `${B}/abc123.gif`,
    });
  });

  test(".gifv → .gif，同樣不轉 webp", async () => {
    expect(await resolve(`${B}/abc123.gifv`)).toEqual({
      type: "image",
      src: `${B}/abc123.gif`,
    });
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
