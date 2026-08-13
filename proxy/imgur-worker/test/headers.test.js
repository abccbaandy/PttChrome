// 回應標頭是本 Worker 對 app 端的第二個契約（第一個是 RE_ASSET 白名單）。
// app 端的「連結旁代理狀態徽章」完全靠 Timing-Allow-Origin + Server-Timing 判定；
// 少一個就變成「分不出代理服務的還是 fail-open 302 導回 imgur 的」→ 徽章全滅。
import { describe, test, expect } from "vitest";
import { passthroughHeaders } from "../src/index.js";

const upstream = (h = {}) => ({ headers: new Headers(h) });
const NOW_MS = 1770000000000;

describe("passthroughHeaders", () => {
  test("帶 Timing-Allow-Origin: *（沒有它前端讀不到跨網域計時細節）", () => {
    const h = passthroughHeaders(upstream(), { cacheable: true, nowMs: NOW_MS });
    expect(h.get("timing-allow-origin")).toBe("*");
  });

  test("Server-Timing 為 pttproxy;desc=<epoch 秒>", () => {
    const h = passthroughHeaders(upstream(), { cacheable: true, nowMs: NOW_MS });
    expect(h.get("server-timing")).toBe(`pttproxy;desc=${NOW_MS / 1000}`);
  });

  // 命中時 Worker 不執行 ⇒ 吐的是建立快取當下的舊值。這兩個標頭必須同源於同一個
  // 時間點，否則 curl 驗證（看 x-imgur-proxy-fetched-at）與前端判定會對不起來。
  test("Server-Timing 與 x-imgur-proxy-fetched-at 指向同一時刻", () => {
    const h = passthroughHeaders(upstream(), { cacheable: true, nowMs: NOW_MS });
    const stamp = Number(h.get("server-timing").split("desc=")[1]);
    expect(new Date(h.get("x-imgur-proxy-fetched-at")).getTime()).toBe(stamp * 1000);
  });

  // 既有契約不可被這次改動破壞。
  test("cacheable:true → immutable 一年；false → no-store", () => {
    expect(
      passthroughHeaders(upstream(), { cacheable: true, nowMs: NOW_MS }).get(
        "cache-control",
      ),
    ).toBe("public, max-age=31536000, immutable");
    expect(
      passthroughHeaders(upstream(), { cacheable: false, nowMs: NOW_MS }).get(
        "cache-control",
      ),
    ).toBe("no-store");
  });

  test("CORS 與上游標頭轉發不變", () => {
    const h = passthroughHeaders(
      upstream({ "content-type": "image/webp", "content-length": "123" }),
      { cacheable: true, nowMs: NOW_MS },
    );
    expect(h.get("access-control-allow-origin")).toBe("*");
    expect(h.get("access-control-expose-headers")).toBe("content-type, content-length");
    expect(h.get("content-type")).toBe("image/webp");
    expect(h.get("content-length")).toBe("123");
    expect(h.get("x-imgur-proxy")).toBe("1");
  });

  test("未傳 nowMs 時退回 Date.now()", () => {
    const h = passthroughHeaders(upstream(), { cacheable: true });
    const stamp = Number(h.get("server-timing").split("desc=")[1]);
    expect(Math.abs(stamp - Date.now() / 1000)).toBeLessThan(5);
  });
});
