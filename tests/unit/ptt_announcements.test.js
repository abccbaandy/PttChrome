// PttCurrent 公告 bot 核心（proxy/ptt-announcements-worker/src/core.js）的守護（無網路）。fixture 是 2026-10-02 抓的真
// PttCurrent feed 與兩篇系統公告（一般使用者的帳號／內文已換成佔位字）：
//   M.1790827526.A.744：純文字標頭、無推文
//   M.1789902495.A.1C6：article-metaline 標頭、有一則推文
import fs from "node:fs";
import path from "node:path";
import {
  parseFeed,
  isOfficialAnnouncement,
  parseArticle,
  parseMarker,
  renderMarker,
  renderIssueBody,
  planActions,
  pickFireTargets,
  renderFireText,
  FetchError,
  SEED_HANDLED,
  LABEL,
  QUEUED_LABEL,
  sync,
  ConfigError,
  FEED_URL,
} from "../../proxy/ptt-announcements-worker/src/core.js";

const dir = path.join(__dirname, "fixtures", "ptt_announcements");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const FEED = read("PttCurrent.xml");
const A744 = read("M.1790827526.A.744.html");
const A1C6 = read("M.1789902495.A.1C6.html");

const entries = parseFeed(FEED);

// 只改 main-content 裡的內文（同一句也出現在 head 的 og:description）。
const editBody = (html) => {
  const i = html.indexOf('id="main-content"');
  return html.slice(0, i) + html.slice(i).replace("全站各列表式介面", "全站各列表式界面");
};
const official = entries.filter(isOfficialAnnouncement);

// 每篇官方公告都給一份全文（plan 需要）；沒有 fixture 的用假內文。
const allArticles = () => {
  const out = {};
  for (const e of official) {
    out[e.aid] = { title: e.title, time: "", body: `fake ${e.aid}`, bodyHash: "0".repeat(16) };
  }
  out["M.1790827526.A.744"] = parseArticle(A744);
  out["M.1789902495.A.1C6"] = parseArticle(A1C6);
  return out;
};
const toIssues = (actions) =>
  actions.map((a, i) => ({
    number: i + 1,
    title: a.title,
    body: a.body,
    state: a.closed ? "closed" : "open",
    labels: [{ name: LABEL }],
  }));

test("import CLI 不得觸發網路", async () => {
  const spy = vi.spyOn(globalThis, "fetch");
  const mod = await import("../../scripts/ptt-announcements.mjs");
  expect(mod).toBeTruthy();
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

describe("parseFeed / isOfficialAnnouncement", () => {
  test("20 筆 entry、只收 系統＋[開發資訊] 的 12 篇", () => {
    expect(entries).toHaveLength(20);
    expect(official).toHaveLength(12);
    expect(official.every((e) => e.author === "系統")).toBe(true);
    expect(official[0].aid).toBe("M.1790827526.A.744");
  });

  test("[問題]／[建議] 不收；非「系統」作者冒用 [開發資訊] 也不收", () => {
    const others = entries.filter((e) => !isOfficialAnnouncement(e));
    expect(others.some((e) => e.title.startsWith("[問題]"))).toBe(true);
    expect(others.some((e) => e.title.startsWith("[建議]"))).toBe(true);
    expect(isOfficialAnnouncement({ ...official[0], author: "someone" })).toBe(false);
  });

  test("feed 回 HTML（Cloudflare challenge）→ 丟 FetchError，不回空清單", () => {
    const html = "<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>";
    expect(() => parseFeed(html)).toThrow(FetchError);
    expect(() => parseFeed("")).toThrow(FetchError);
  });

  test("Atom 但零 entry 也算失敗", () => {
    expect(() =>
      parseFeed('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>'),
    ).toThrow(FetchError);
  });
});

describe("parseArticle", () => {
  test("純文字標頭：標題取全文那行（不是 feed 標題）", () => {
    const a = parseArticle(A744);
    expect(a.title).toBe("[開發資訊] 介面調整: 列表模式導入動態分欄架構");
    expect(a.time).toBe("Thu Oct  1 11:15:00 CST 2026");
    expect(a.body.startsWith("PTT 終端機畫面解析注意事項")).toBe(true);
    expect(a.body).not.toContain("發信站");
  });

  test("article-metaline 標頭也解得出來；推文不進內文", () => {
    const a = parseArticle(A1C6);
    expect(a.title).toBe("[開發資訊] 介面調整: 標題列與主選單底部狀態列改版");
    expect(a.time).toBe("Sun Sep 20 19:07:36 CST 2026");
    expect(a.body.startsWith("PTT 終端機畫面解析注意事項")).toBe(true);
    expect(a.body).toContain("請及早測試 & 更新"); // entity 已解
    expect(a.body).not.toContain("someuser");
    expect(a.body).not.toContain("<");
  });

  test("推文不影響 hash（feed <updated> 會被推文改，所以只能比內文）", () => {
    const pushed = A744.replace(
      /(<span class="f2">※ 發信站[\s\S]*?<\/span>)/,
      (m) =>
        `${m}<div class="push"><span class="hl push-tag">推 </span><span class="f3 hl push-userid">x</span><span class="f3 push-content">: 改內文</span></div>`,
    );
    expect(pushed).not.toBe(A744);
    expect(parseArticle(pushed).bodyHash).toBe(parseArticle(A744).bodyHash);
  });

  test("內文改一個字 → hash 變", () => {
    const edited = editBody(A744);
    expect(edited).not.toBe(A744);
    expect(parseArticle(edited).bodyHash).not.toBe(parseArticle(A744).bodyHash);
  });

  test("找不到 main-content → FetchError", () => {
    expect(() => parseArticle("<html>over18</html>")).toThrow(FetchError);
  });
});

describe("marker / issue body", () => {
  test("標記 round-trip，且在 body 第一行", () => {
    const a = parseArticle(A744);
    const body = renderIssueBody({ aid: "M.1790827526.A.744", url: "u", article: a });
    expect(body.split("\n")[0]).toBe(renderMarker("M.1790827526.A.744", a.bodyHash));
    expect(parseMarker(body)).toEqual({ aid: "M.1790827526.A.744", bodyHash: a.bodyHash });
    expect(parseMarker("隨便一個 issue")).toBeNull();
  });

  test("<pre> 內跳脫 </pre>、script 標籤與 &", () => {
    const article = { title: "t", time: "", body: "a </pre> <script>x</script> & b", bodyHash: "1".repeat(16) };
    const body = renderIssueBody({ aid: "M.1.A.1", url: "u", article });
    const pre = body.slice(body.indexOf("<pre>") + 5, body.lastIndexOf("</pre>"));
    expect(pre).toBe("a &lt;/pre&gt; &lt;script&gt;x&lt;/script&gt; &amp; b");
    expect(body.match(/<\/pre>/g)).toHaveLength(1);
  });

  test("超長內文截斷並附說明，總長在 GitHub 上限內", () => {
    const article = { title: "t", time: "", body: "字".repeat(70000), bodyHash: "1".repeat(16) };
    const body = renderIssueBody({ aid: "M.1.A.1", url: "u", article });
    expect(body.length).toBeLessThan(65536);
    expect(body).toContain("已截斷");
  });
});

describe("planActions", () => {
  test("空 repo：12 篇全部 create，seed 表內的建成 closed，只有 VCOL 那篇 open", () => {
    const actions = planActions(entries, allArticles(), []);
    expect(actions).toHaveLength(12);
    expect(actions.every((a) => a.kind === "create")).toBe(true);
    const open = actions.filter((a) => !a.closed);
    expect(open.map((a) => a.aid)).toEqual(["M.1790827526.A.744"]);
    expect(Object.keys(SEED_HANDLED)).toHaveLength(11);
    // 舊的先建，issue 編號跟發布順序一致
    expect(actions[0].aid).toBe("M.1789835163.A.633");
    expect(actions.at(-1).aid).toBe("M.1790827526.A.744");
  });

  test("已有標記的 AID 不重複 create；closed issue 也算已存在", () => {
    const issues = toIssues(planActions(entries, allArticles(), []));
    expect(issues.some((i) => i.state === "closed")).toBe(true);
    expect(planActions(entries, allArticles(), issues)).toEqual([]);
  });

  test("內文改了 → update 原 issue，帶新舊 hash", () => {
    const issues = toIssues(planActions(entries, allArticles(), []));
    const articles = allArticles();
    articles["M.1790827526.A.744"] = parseArticle(editBody(A744));
    const actions = planActions(entries, articles, issues);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "update", aid: "M.1790827526.A.744", number: 12 });
    expect(actions[0].oldHash).not.toBe(actions[0].newHash);
    expect(parseMarker(actions[0].body).bodyHash).toBe(actions[0].newHash);
  });

  test("缺全文 → 丟錯，不可以默默跳過", () => {
    expect(() => planActions(entries, {}, [])).toThrow(FetchError);
  });
});

describe("pickFireTargets", () => {
  test("只挑 open＋ptt-announcement＋沒 claude-queued", () => {
    const L = (...n) => n.map((name) => ({ name }));
    const issues = [
      { number: 3, title: "c", state: "open", labels: L(LABEL) },
      { number: 1, title: "a", state: "open", labels: L(LABEL, QUEUED_LABEL) },
      { number: 2, title: "b", state: "closed", labels: L(LABEL) },
      { number: 4, title: "d", state: "open", labels: L("other") },
      { number: 5, title: "e", state: "open", labels: L(LABEL), pull_request: {} },
      { number: 0, title: "z", state: "open", labels: L(LABEL) },
    ];
    expect(pickFireTargets(issues).map((i) => i.number)).toEqual([0, 3]);
    const text = renderFireText("o/r", pickFireTargets(issues));
    expect(text).toContain("#3 c https://github.com/o/r/issues/3");
  });
});

// ---- sync 整輪流程：假的 ptt.cc＋GitHub＋routine，全在記憶體 ----

const FIRE_URL = "https://fire.example/fire";
function fakeWorld() {
  const w = {
    pages: {},
    issues: [],
    fires: [],
    fireStatus: 200,
    writes: 0,
  };
  for (const e of official) {
    w.pages[e.url] =
      `<div id="main-content" class="bbs-screen bbs-content">作者  [系統] 看板  PttCurrent\n標題  ${e.title}\n` +
      `時間  Mon Sep 21 00:00:00 CST 2026\n\nfake ${e.aid}\n<span class="f2">※ 發信站: 批踢踢實業坊(ptt.cc)\n</span></div>`;
  }
  w.pages["https://www.ptt.cc/bbs/PttCurrent/M.1790827526.A.744.html"] = A744;
  w.pages["https://www.ptt.cc/bbs/PttCurrent/M.1789902495.A.1C6.html"] = A1C6;
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status });
  const find = (n) => w.issues.find((i) => i.number === Number(n));
  w.fetch = vi.fn(async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.href === FEED_URL) return new Response(FEED, { status: 200 });
    if (u.host === "www.ptt.cc") return new Response(w.pages[u.href] ?? "", { status: w.pages[u.href] ? 200 : 404 });
    if (u.href === FIRE_URL) {
      w.fires.push(body.text);
      return w.fireStatus === 200
        ? json({ type: "routine_fire", claude_code_session_url: `https://claude.ai/code/s${w.fires.length}` })
        : json({ error: "x" }, w.fireStatus);
    }
    expect(u.host).toBe("api.github.com");
    expect(new Headers(init.headers).get("user-agent")).toMatch(/\S/);
    if (method !== "GET") w.writes++;
    let m;
    if (method === "GET" && u.pathname === "/repos/o/r/issues") {
      const label = u.searchParams.get("labels");
      const st = u.searchParams.get("state");
      const page = Number(u.searchParams.get("page"));
      const hit = w.issues.filter((i) => i.labels.includes(label) && (st === "all" || i.state === st));
      return json(page === 1 ? hit.map((i) => ({ ...i, labels: i.labels.map((name) => ({ name })) })) : []);
    }
    if (method === "POST" && u.pathname === "/repos/o/r/issues") {
      const iss = { number: w.issues.length + 1, title: body.title, body: body.body, state: "open", labels: [...body.labels], comments: [] };
      w.issues.push(iss);
      return json(iss, 201);
    }
    if (method === "PATCH" && (m = u.pathname.match(/^\/repos\/o\/r\/issues\/(\d+)$/))) {
      Object.assign(find(m[1]), body);
      return json(find(m[1]));
    }
    if (method === "POST" && (m = u.pathname.match(/^\/repos\/o\/r\/issues\/(\d+)\/comments$/))) {
      find(m[1]).comments.push(body.body);
      return json({}, 201);
    }
    if (method === "POST" && (m = u.pathname.match(/^\/repos\/o\/r\/issues\/(\d+)\/labels$/))) {
      const iss = find(m[1]);
      for (const l of body.labels) if (!iss.labels.includes(l)) iss.labels.push(l);
      return json([]);
    }
    if (method === "DELETE" && (m = u.pathname.match(/^\/repos\/o\/r\/issues\/(\d+)\/labels\/(.+)$/))) {
      const iss = find(m[1]);
      if (!iss.labels.includes(m[2])) return json({}, 404);
      iss.labels = iss.labels.filter((l) => l !== m[2]);
      return json([]);
    }
    throw new Error(`unexpected ${method} ${u.href}`);
  });
  w.run = (opts = {}) =>
    sync({
      fetch: w.fetch,
      env: { GITHUB_REPO: "o/r", GH_TOKEN: "t", CLAUDE_ROUTINE_FIRE_URL: FIRE_URL, CLAUDE_ROUTINE_TOKEN: "rt" },
      ...opts,
    });
  return w;
}
const VCOL = "[開發資訊] 介面調整: 列表模式導入動態分欄架構";

describe("sync 整輪", () => {
  test("seed：12 篇建好（11 closed），不 fire", async () => {
    const w = fakeWorld();
    await w.run({ seed: true });
    expect(w.issues).toHaveLength(12);
    expect(w.issues.filter((i) => i.state === "open").map((i) => i.title)).toEqual([VCOL]);
    expect(w.fires).toEqual([]);
  });

  test("seed 後正常跑：fire 一次、貼 claude-queued、留 session 網址；再跑一次 0 寫入 0 fire", async () => {
    const w = fakeWorld();
    await w.run({ seed: true });
    await w.run();
    expect(w.fires).toHaveLength(1);
    expect(w.fires[0]).toContain(VCOL);
    const vcol = w.issues.find((i) => i.title === VCOL);
    expect(vcol.labels).toContain(QUEUED_LABEL);
    expect(vcol.comments.join("\n")).toContain("https://claude.ai/code/s1");
    const writes = w.writes;
    await w.run();
    expect(w.writes).toBe(writes);
    expect(w.fires).toHaveLength(1);
  });

  test("忘了 seed 直接跑：舊公告照樣 closed，只叫 Claude 看 VCOL", async () => {
    const w = fakeWorld();
    await w.run();
    expect(w.issues.filter((i) => i.state === "open")).toHaveLength(1);
    expect(w.fires).toHaveLength(1);
    expect(w.fires[0]).not.toContain("SGR");
  });

  test("subrequest 額度不夠：分兩輪做完，不重複建、只 fire 一次", async () => {
    const w = fakeWorld();
    const r1 = await w.run({ subrequestLimit: 30 });
    expect(r1.deferred.length).toBeGreaterThan(0);
    expect(w.fires).toHaveLength(0);
    expect(w.fetch.mock.calls.length).toBeLessThanOrEqual(30);
    w.fetch.mockClear();
    await w.run({ subrequestLimit: 30 });
    expect(w.fetch.mock.calls.length).toBeLessThanOrEqual(30);
    expect(w.issues).toHaveLength(12);
    expect(new Set(w.issues.map((i) => parseMarker(i.body).aid)).size).toBe(12);
    expect(w.fires).toHaveLength(1);
    expect(w.issues.find((i) => i.title === VCOL).labels).toContain(QUEUED_LABEL);
  });

  test("公告被修改：更新 body、reopen、拿掉 claude-queued、重新 fire", async () => {
    const w = fakeWorld();
    await w.run();
    const url = "https://www.ptt.cc/bbs/PttCurrent/M.1790827526.A.744.html";
    const vcol = w.issues.find((i) => i.title === VCOL);
    vcol.state = "closed"; // Claude 處理完關掉了
    w.pages[url] = editBody(A744);
    await w.run();
    expect(vcol.state).toBe("open");
    expect(vcol.body).toContain("全站各列表式界面");
    expect(w.fires).toHaveLength(2);
    expect(vcol.labels).toContain(QUEUED_LABEL);
    expect(vcol.comments.some((c) => c.includes("已修改"))).toBe(true);
    // 推文不算修改
    const before = w.pages[url];
    w.pages[url] = before.replace(/(※ 發信站[\s\S]*?<\/span>)/, (m) => `${m}<div class="push">推 x: y</div>`);
    expect(w.pages[url]).not.toBe(before);
    await w.run();
    expect(w.fires).toHaveLength(2);
  });

  test("fire 失敗 → 丟錯、不貼 claude-queued；下一輪重試", async () => {
    const w = fakeWorld();
    w.fireStatus = 500;
    await expect(w.run()).rejects.toThrow("500");
    expect(w.issues.find((i) => i.title === VCOL).labels).not.toContain(QUEUED_LABEL);
    w.fireStatus = 200;
    await w.run();
    expect(w.fires).toHaveLength(2);
    expect(w.issues.find((i) => i.title === VCOL).labels).toContain(QUEUED_LABEL);
  });

  test("有待處理 issue 但缺 routine secret → ConfigError（issue 已建好）", async () => {
    const w = fakeWorld();
    await expect(
      sync({ fetch: w.fetch, env: { GITHUB_REPO: "o/r", GH_TOKEN: "t" } }),
    ).rejects.toThrow(ConfigError);
    expect(w.issues).toHaveLength(12);
  });

  test("feed 被擋（403）→ 丟錯，不碰 GitHub", async () => {
    const w = fakeWorld();
    const blocked = vi.fn(async () => new Response("Forbidden", { status: 403 }));
    await expect(sync({ fetch: blocked, env: { GITHUB_REPO: "o/r", GH_TOKEN: "t" } })).rejects.toThrow(FetchError);
    expect(blocked).toHaveBeenCalledTimes(1);
    expect(w.issues).toHaveLength(0);
  });
});

describe("routine secret 手貼容錯", () => {
  test.each([
    ["rt"],
    ["  rt\n"],
    ['"rt"'],
    ["Bearer rt"],
    ["'Bearer rt' "],
  ])("token %j → 送出 Bearer rt", async (token) => {
    const w = fakeWorld();
    const calls = [];
    const spy = vi.fn((url, init) => {
      if (String(url).startsWith(FIRE_URL)) calls.push({ url: String(url), auth: new Headers(init.headers).get("authorization") });
      return w.fetch(url, init);
    });
    await sync({
      fetch: spy,
      env: { GITHUB_REPO: "o/r", GH_TOKEN: "t", CLAUDE_ROUTINE_FIRE_URL: ` ${FIRE_URL}\n`, CLAUDE_ROUTINE_TOKEN: token },
    });
    expect(calls).toEqual([{ url: FIRE_URL, auth: "Bearer rt" }]);
  });
});
