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
