// fetch handler 的回源行為（mock 全域 fetch，不連網）。
import { describe, test, expect, vi, afterEach } from "vitest";
import worker from "../src/index.js";

const imageResponse = () =>
  new Response("x", { status: 200, headers: { "content-type": "image/png" } });

afterEach(() => vi.unstubAllGlobals());

describe("回源請求", () => {
  // files.catbox.moe 對無 User-Agent 的請求直接斷線，Workers 的 fetch 預設又不帶 UA
  // ⇒ 實測 Cloudflare 回 520、整條 catbox 代理全數 fail-open 成 302。
  test.each([
    ["/L976tXr.jpg"],
    ["/twimg/orig/HSWhvjqbMAIr5Ux.jpg"],
    ["/catbox/rdpjcp.png"],
  ])("%s 回源帶 User-Agent", async (path) => {
    const spy = vi.fn(() => Promise.resolve(imageResponse()));
    vi.stubGlobal("fetch", spy);
    const res = await worker.fetch(new Request(`https://w.example${path}`));
    expect(res.status).toBe(200);
    const headers = new Headers(spy.mock.calls[0][1].headers);
    expect(headers.get("user-agent")).toMatch(/\S/);
    // 不帶 referer：imgur 對 *.ptt.cc 回 403。
    expect(headers.get("referer")).toBe(null);
  });

  test("上游失敗 → 302 回對應站台原址（fail-open）", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("", { status: 520 }))));
    const res = await worker.fetch(new Request("https://w.example/catbox/rdpjcp.png"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://files.catbox.moe/rdpjcp.png");
  });

  test("上游回非圖片 → 302 回原址", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response("<html>", { headers: { "content-type": "text/html" } })),
      ),
    );
    const res = await worker.fetch(
      new Request("https://w.example/twimg/orig/HSWhvjqbMAIr5Ux.jpg"),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://pbs.twimg.com/media/HSWhvjqbMAIr5Ux?format=jpg&name=orig",
    );
  });
});

// twimg 的 `name=orig` 只提供原始上傳格式（jpg 或 png 其一），其他尺寸才會轉檔。
// PTT 推文裡的 `.jpg` 是貼文者寫的，不保證是原始格式 ⇒ 原圖是 png 時
// `format=jpg&name=orig` 回 404，舊行為 302 回同一個 404 原址，前端逐候選重試。
describe("twimg orig 格式猜錯", () => {
  const MIME = { jpg: "image/jpeg", png: "image/png" };
  const twimgStub = (okFormat) =>
    vi.fn((url) =>
      Promise.resolve(
        new URL(url).searchParams.get("format") === okFormat
          ? new Response("x", { status: 200, headers: { "content-type": MIME[okFormat] } })
          : new Response("", { status: 404 }),
      ),
    );

  test.each([
    ["/twimg/orig/HTboysvbgAAWRv5.jpg", "png"],
    ["/twimg/orig/HTZ760TakAAmwS7.png", "jpg"],
  ])("%s 原圖是 %s → 換格式回源，200 且可快取", async (path, okFormat) => {
    const spy = twimgStub(okFormat);
    vi.stubGlobal("fetch", spy);
    const res = await worker.fetch(new Request(`https://w.example${path}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(MIME[okFormat]);
    expect(res.headers.get("cache-control")).toMatch(/immutable/);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  // 原始格式只有 jpg／png；webp 搭 orig 上游一律 404 ⇒ 兩者都要試（先 jpg）。
  test.each([["jpg"], ["png"]])("/twimg/orig/<id>.webp 原圖是 %s → 200", async (okFormat) => {
    const spy = twimgStub(okFormat);
    vi.stubGlobal("fetch", spy);
    const res = await worker.fetch(new Request("https://w.example/twimg/orig/HTboysvbgAAWRv5.webp"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(MIME[okFormat]);
  });

  test("兩種格式都 404 → 302 回原本請求的格式", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("", { status: 404 }))));
    const res = await worker.fetch(new Request("https://w.example/twimg/orig/HTboysvbgAAWRv5.jpg"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://pbs.twimg.com/media/HTboysvbgAAWRv5?format=jpg&name=orig",
    );
  });

  // 限流／5xx 不是格式問題，再打一次只會加重上游負擔。
  test("非 404 失敗不換格式重試", async () => {
    const spy = vi.fn(() => Promise.resolve(new Response("", { status: 429 })));
    vi.stubGlobal("fetch", spy);
    const res = await worker.fetch(new Request("https://w.example/twimg/orig/HTboysvbgAAWRv5.jpg"));
    expect(res.status).toBe(302);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("非 orig 尺寸不換格式（twimg 會轉檔，404 就是真的不存在）", async () => {
    const spy = vi.fn(() => Promise.resolve(new Response("", { status: 404 })));
    vi.stubGlobal("fetch", spy);
    await worker.fetch(new Request("https://w.example/twimg/large/HTboysvbgAAWRv5.jpg"));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
