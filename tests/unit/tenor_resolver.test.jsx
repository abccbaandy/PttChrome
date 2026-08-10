// 回報案例：https://tenor.com/bgOd4.gif 自動開圖打不開，點連結只會跳到網頁。
//
// 症狀成因：該 URL 以 .gif 結尾但其實是 HTML 頁（301 → /view/<slug>-<id>），
// 被 imageUrlResolvers 最末的「任意直連圖片」規則吃掉 → 塞進 <img> 永遠 decode
// 失敗 → FallbackImage 重試耗盡後顯示「圖片載入失敗」。
// 修法：tenor resolver 必須排在泛用副檔名規則**之前**，並經 Worker 解出真實媒體位址。
// tenor 頁面沒有 CORS、/view/ 又是 x-frame-options: DENY，前端自己解不了。

import { render } from "@testing-library/react";
import ImagePreviewer, {
  resolveSrcToImageUrl,
} from "../../src/components/ImagePreviewer";
import {
  resetImgurProxyConfig,
  setImgurProxyConfig,
  DEFAULT_IMGUR_PROXY_BASE,
} from "../../src/js/imgur_proxy";

const resolve = (src) => resolveSrcToImageUrl({ src });
const SHORT = "https://tenor.com/bgOd4.gif";
const MP4 = "https://media.tenor.com/TjWRuqajuC0AAAPo/faker-hug.mp4";
const GIF = "https://media1.tenor.com/m/TjWRuqajuC0AAAAd/faker-hug.gif";

const stubWorker = (body, ok = true) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok, json: () => Promise.resolve(body) })),
  );

describe("tenor 分享連結 resolver", () => {
  beforeEach(() => setImgurProxyConfig({ enabled: true }));
  afterEach(() => {
    vi.unstubAllGlobals();
    resetImgurProxyConfig();
  });

  // 這條是本 bug 的核心守護：泛用 .gif resolver 不得先攔截 tenor 連結。
  test("短連結 → 解析成 mp4 的 video descriptor（不是把網頁當圖載）", async () => {
    stubWorker({ mp4: MP4, gif: GIF, width: 640, height: 390 });
    expect(await resolve(SHORT)).toEqual({ type: "video", src: MP4, gif: true });
  });

  test("view 完整連結同樣可解", async () => {
    stubWorker({ mp4: MP4 });
    expect(
      await resolve("https://tenor.com/view/faker-hug-smile-happy-shy-gif-16360306"),
    ).toEqual({ type: "video", src: MP4, gif: true });
  });

  test("打的是 Worker 的 /tenor 端點，且短碼大小寫原樣（bgOd4 ≠ bgod4，是兩張圖）", async () => {
    stubWorker({ mp4: MP4 });
    await resolve(SHORT);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${DEFAULT_IMGUR_PROXY_BASE}/tenor?url=${encodeURIComponent(SHORT)}`,
      expect.anything(),
    );
  });

  test("Worker 只回得出 gif → 退成 image descriptor", async () => {
    stubWorker({ gif: GIF });
    expect(await resolve(SHORT)).toEqual({ type: "image", src: GIF });
  });

  test.each([
    [() => stubWorker({ error: "no media" }, false), "Worker 回 4xx"],
    [() => stubWorker({}), "回 200 但沒有媒體欄位"],
    [
      () => vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline")))),
      "斷網",
    ],
  ])("解析失敗 → reject（不預覽，不留破圖）：%# %s", async (setup) => {
    setup();
    await expect(resolve(SHORT)).rejects.toThrow();
  });

  // 使用者關掉 imgur 快取代理 = 不想把瀏覽紀錄送給專案方 Worker ⇒ tenor 一併停用。
  // 但**仍不可退回泛用 .gif 規則**，否則又變回破圖。
  test("代理關閉 → reject，不得退回把網頁當圖載", async () => {
    resetImgurProxyConfig();
    stubWorker({ mp4: MP4 });
    await expect(resolve(SHORT)).rejects.toThrow();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  // media*.tenor.com 是直連檔，交給既有的泛用 resolver，不該多打一次 Worker。
  test("直連 media.tenor.com 不走 Worker", async () => {
    stubWorker({ mp4: MP4 });
    expect(await resolve(GIF)).toEqual({ type: "image", src: GIF });
    expect(await resolve(MP4)).toEqual({ type: "video", src: MP4 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// 症狀層：鎖「渲染成什麼元素、怎麼播」而非 descriptor 形狀。
describe("tenor 內嵌播放：GIF 語意", () => {
  beforeEach(() => setImgurProxyConfig({ enabled: true }));
  afterEach(() => {
    vi.unstubAllGlobals();
    resetImgurProxyConfig();
  });

  test("渲染成自動循環靜音的 <video>，無控制列，且畫面上不得出現 <img>", async () => {
    stubWorker({ mp4: MP4 });
    const value = await resolve(SHORT);
    const { container } = render(<ImagePreviewer.Inline value={value} />);
    const v = container.querySelector("video");
    expect(v).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(v.autoplay).toBe(true);
    expect(v.loop).toBe(true);
    // muted 要是 **property** 為真，瀏覽器才允許自動播放（只寫 JSX 屬性不保證）。
    expect(v.muted).toBe(true);
    expect(v.hasAttribute("controls")).toBe(false);
    expect(v.getAttribute("playsinline")).not.toBeNull();
  });

  // 一般影片（imgur mp4 等）維持原本「有控制列、不自動播」的行為，別被 gif 模式波及。
  test("非 tenor 的影片仍保有控制列且不自動播", () => {
    const { container } = render(
      <ImagePreviewer.Inline value={{ type: "video", src: "https://x/y.mp4" }} />,
    );
    const v = container.querySelector("video");
    expect(v.hasAttribute("controls")).toBe(true);
    expect(v.autoplay).toBe(false);
    expect(v.loop).toBe(false);
  });
});
