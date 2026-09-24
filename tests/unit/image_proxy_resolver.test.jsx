// twimg／catbox 經圖片快取代理（proxy/imgur-worker）的 resolver 契約。
//
// 硬約束與 imgur 那組相同（見 imgur_webp_resolver.test.jsx 的代理段）：
//   1. 原址永遠墊在候選清單後面 —— Worker 掛掉／額度用盡時 FallbackImage 自動退回。
//   2. 影片一律不代理 —— Worker 擋影片回 404（Cloudflare ToS）。
//   3. 代理關閉時 descriptor 與整合前**逐字相同**。
// 各站開關獨立：關掉某一站只影響該站。
import { resolveSrcToImageUrl } from "../../src/components/ImagePreviewer";
import { resetImageProxyConfig, setImageProxyConfig } from "../../src/js/image_proxy";

const resolve = (src) => resolveSrcToImageUrl({ src });
const PROXY = "https://proxy.example.dev";
const TW = "https://pbs.twimg.com/media/HSWhvjqbMAIr5Ux";
const TW_DIRECT = [`${TW}.jpg:orig`, `${TW}.png:orig`, `${TW}.jpg:large`, `${TW}.jpg`];
const CB = "https://files.catbox.moe";

afterEach(() => resetImageProxyConfig());

describe("代理關閉：輸出與整合前逐字相同", () => {
  test("twimg 四候選", async () => {
    expect(await resolve(`${TW}.jpg`)).toEqual({
      type: "image",
      src: `${TW}.jpg:orig`,
      srcset: TW_DIRECT,
    });
  });

  test("catbox 走泛用圖片形狀（無 srcset）", async () => {
    expect(await resolve(`${CB}/rdpjcp.png`)).toEqual({
      type: "image",
      src: `${CB}/rdpjcp.png`,
    });
  });
});

describe("代理開啟", () => {
  beforeEach(() => setImageProxyConfig({ enabled: true, base: PROXY }));

  test("twimg：代理 orig 第一，直連四候選墊後", async () => {
    expect(await resolve(`${TW}.jpg`)).toEqual({
      type: "image",
      src: `${PROXY}/twimg/orig/HSWhvjqbMAIr5Ux.jpg`,
      srcset: [`${PROXY}/twimg/orig/HSWhvjqbMAIr5Ux.jpg`, ...TW_DIRECT],
    });
  });

  test("twimg query 寫法（?format=png&name=small）也代理 orig", async () => {
    const out = await resolve(`${TW}?format=png&name=small`);
    expect(out.src).toBe(`${PROXY}/twimg/orig/HSWhvjqbMAIr5Ux.png`);
    expect(out.srcset).toContain(`${TW}.png:orig`);
  });

  test("catbox 圖：[代理, 原址]", async () => {
    expect(await resolve(`${CB}/rdpjcp.png`)).toEqual({
      type: "image",
      src: `${PROXY}/catbox/rdpjcp.png`,
      srcset: [`${PROXY}/catbox/rdpjcp.png`, `${CB}/rdpjcp.png`],
    });
  });

  test("catbox 影片直連不代理", async () => {
    expect(await resolve(`${CB}/abc123.mp4`)).toEqual({
      type: "video",
      src: `${CB}/abc123.mp4`,
    });
  });

  test("catbox 以外的直連圖不受影響", async () => {
    expect(await resolve("https://i.urusai.cc/abc.png")).toEqual({
      type: "image",
      src: "https://i.urusai.cc/abc.png",
    });
  });
});

describe("各站開關獨立", () => {
  test("關 twimg：twimg 回直連、catbox 照樣代理", async () => {
    setImageProxyConfig({ enabled: true, base: PROXY, sites: { twimg: false } });
    expect((await resolve(`${TW}.jpg`)).srcset).toEqual(TW_DIRECT);
    expect((await resolve(`${CB}/rdpjcp.png`)).src).toBe(`${PROXY}/catbox/rdpjcp.png`);
  });

  test("關 catbox：catbox 回泛用形狀、twimg 照樣代理", async () => {
    setImageProxyConfig({ enabled: true, base: PROXY, sites: { catbox: false } });
    expect(await resolve(`${CB}/rdpjcp.png`)).toEqual({ type: "image", src: `${CB}/rdpjcp.png` });
    expect((await resolve(`${TW}.jpg`)).src).toBe(`${PROXY}/twimg/orig/HSWhvjqbMAIr5Ux.jpg`);
  });

  test("總開關關閉：各站開關全開也不代理", async () => {
    setImageProxyConfig({
      enabled: false,
      base: PROXY,
      sites: { twimg: true, catbox: true },
    });
    expect((await resolve(`${TW}.jpg`)).srcset).toEqual(TW_DIRECT);
    expect((await resolve(`${CB}/rdpjcp.png`)).src).toBe(`${CB}/rdpjcp.png`);
  });
});

