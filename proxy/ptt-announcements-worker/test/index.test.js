// Worker 殼的行為（mock 全域 fetch，不連網）。core.js 的邏輯在主專案
// tests/unit/ptt_announcements.test.js。
import { describe, test, expect, vi, afterEach } from "vitest";
import worker, { SUBREQUEST_LIMIT } from "../src/index.js";
import { ERROR_LABEL } from "../src/core.js";

afterEach(() => vi.unstubAllGlobals());

const json = (v, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

// ptt.cc 回 403（Actions runner 實際遇到的狀況），GitHub 正常。
const blockedPtt = (openErrorIssues = []) =>
  vi.fn(async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("https://www.ptt.cc/")) return new Response("Forbidden", { status: 403 });
    if (u.includes(`labels=${ERROR_LABEL}`)) return json(openErrorIssues);
    if (u.endsWith("/issues") && init.method === "POST") return json({ number: 99 }, 201);
    if (init.method === "PATCH") return json({});
    throw new Error(`unexpected ${init.method || "GET"} ${u}`);
  });

const env = { GITHUB_REPO: "o/r", GH_TOKEN: "t" };

describe("fetch（手動入口）", () => {
  test("沒設 MANUAL_TOKEN → 404，不碰網路", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const res = await worker.fetch(new Request("https://w.example/?dry_run=1"), env);
    expect(res.status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  test("token 不對 → 401，不碰網路", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const res = await worker.fetch(
      new Request("https://w.example/?dry_run=1", { headers: { authorization: "Bearer nope" } }),
      { ...env, MANUAL_TOKEN: "secret" },
    );
    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  test("dry_run 抓不到 feed → 502 並印出原因，不寫 GitHub", async () => {
    const spy = blockedPtt();
    vi.stubGlobal("fetch", spy);
    const res = await worker.fetch(
      new Request("https://w.example/?dry_run=1", { headers: { authorization: "Bearer secret" } }),
      { ...env, MANUAL_TOKEN: "secret" },
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("403");
    expect(spy.mock.calls.every(([u]) => String(u).startsWith("https://www.ptt.cc/"))).toBe(true);
  });
});

describe("scheduled（cron）", () => {
  const runCron = async () => {
    let p;
    await worker.scheduled({}, env, { waitUntil: (x) => (p = x) });
    return p;
  };

  test("失敗 → 開錯誤 issue，cron 本身也回報失敗", async () => {
    const spy = blockedPtt([]);
    vi.stubGlobal("fetch", spy);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(runCron()).rejects.toThrow("403");
    const created = spy.mock.calls.find(([u, i]) => String(u).endsWith("/issues") && i?.method === "POST");
    expect(created).toBeTruthy();
    const body = JSON.parse(created[1].body);
    expect(body.labels).toEqual([ERROR_LABEL]);
    expect(body.body).toContain("403");
    // GitHub 要求 User-Agent，Worker 的 fetch 預設不帶。
    expect(new Headers(created[1].headers).get("user-agent")).toMatch(/\S/);
  });

  test("已有 open 的錯誤 issue → 不重複開", async () => {
    const spy = blockedPtt([{ number: 5 }]);
    vi.stubGlobal("fetch", spy);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(runCron()).rejects.toThrow();
    expect(spy.mock.calls.some(([, i]) => i?.method === "POST")).toBe(false);
  });

  test("subrequest 上限留空間給狀態回報（免費方案 50）", () => {
    expect(SUBREQUEST_LIMIT).toBeLessThanOrEqual(50 - 3);
  });
});
