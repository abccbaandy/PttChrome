// 開站快取 Service Worker（public/sw.js）的行為守護。
//
// sw.js 是 classic script（public/ 原樣複製，不經 Vite），所以這裡用 node vm 原樣載入整份
// 檔案，給它假的 self／caches／fetch，再丟 install／activate／fetch 事件進去看它怎麼回。
// 鎖的是 P13 的合約（docs/open-cache.md）：
//   - 帶 hash 的 assets/ 檔：有存就直接用、一次網路都不打；沒存才下載並存起來。
//   - 網頁本身：一律先問網路（每次都是最新版），斷線／5xx 才退回存的那份。
//   - 其他請求一律不碰（不呼叫 respondWith）。
//   - 換 build 才清掉新網頁沒列出的舊檔。
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { OPEN_CACHE_PREFIX, OPEN_CACHE_SCRIPT } from "../../src/js/open_cache";

const ROOT = path.join(__dirname, "..", "..");
const SW_SRC = fs.readFileSync(path.join(ROOT, "public", OPEN_CACHE_SCRIPT), "utf8");
const SCOPE = "https://example.test/PttChrome/";

function htmlFor(assets) {
  return (
    "<!DOCTYPE html><html><head>" +
    assets
      .map((a) => (a.endsWith(".js") ? `<script type="module" crossorigin src="./${a}"></script>` : `<link rel="preload" href="./${a}" as="fetch" crossorigin>`))
      .join("") +
    '<link rel="manifest" href="./manifest.webmanifest"></head></html>'
  );
}

const BUILD_A = ["assets/index-AAAAAAAA.js", "assets/index-Cs5_aa-1.css", "assets/b2u_table-Dg8PWwy5.bin"];
const BUILD_B = ["assets/index-BBBBBBBB.js", "assets/index-Cs5_aa-1.css", "assets/b2u_table-Dg8PWwy5.bin"];

function makeResponse(body, { status = 200, type = "basic", vary = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    type,
    vary,
    body,
    text: async () => body,
    clone() {
      return makeResponse(body, { status, type, vary });
    },
  };
}

// 假 Cache Storage：以 URL 比對，並照真的 Cache API 尊重 `Vary: Origin`（除非 ignoreVary）——
// 頁面的 crossorigin 請求帶 Origin、SW 自己補抓的不帶，真瀏覽器上兩邊會對不上。
function makeCaches() {
  const stores = new Map();
  const keyOf = (req) => (typeof req === "string" ? req : req.url);
  const originOf = (req) => (typeof req === "string" ? null : req.headers.get("origin"));
  const lookup = (m, req, opts) => {
    const entry = m.get(keyOf(req));
    if (!entry) return undefined;
    if (entry.res.vary === "Origin" && !(opts && opts.ignoreVary) && entry.origin !== originOf(req)) return undefined;
    return entry.res;
  };
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      match: async (req, opts) => lookup(m, req, opts),
      put: async (req, res) => {
        m.set(keyOf(req), { origin: originOf(req), res });
      },
      delete: async (req) => m.delete(keyOf(req)),
      keys: async () => [...m.keys()].map((url) => ({ url })),
    };
  };
  return {
    stores,
    open,
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    match: async (req, opts) => {
      for (const [name, m] of stores) {
        if (opts && opts.cacheName && opts.cacheName !== name) continue;
        const hit = lookup(m, req, opts);
        if (hit) return hit;
      }
      return undefined;
    },
  };
}

function loadSw({ server }) {
  const listeners = {};
  const caches = makeCaches();
  const fetched = [];
  const fetch = async (req) => {
    const url = typeof req === "string" ? req : req.url;
    fetched.push(url);
    return server(url);
  };
  const self = {
    registration: { scope: SCOPE, navigationPreload: { enable: vi.fn(async () => {}) } },
    clients: { claim: vi.fn(async () => {}) },
    skipWaiting: vi.fn(),
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
  };
  const ctx = vm.createContext({
    self,
    caches,
    fetch,
    Response: function (body) {
      return makeResponse(body);
    },
    Promise,
    console,
  });
  vm.runInContext(SW_SRC, ctx, { filename: "sw.js" });

  async function dispatch(type, init = {}) {
    const waits = [];
    let responded;
    const event = {
      ...init,
      waitUntil: (p) => waits.push(p),
      respondWith: (p) => {
        responded = p;
      },
    };
    listeners[type](event);
    const response = responded ? await responded : undefined;
    // waitUntil 可能在 respondWith 的 promise 裡才被呼叫 ⇒ 等到不再增加為止。
    for (let i = 0; i < waits.length; i++) await waits[i];
    return { responded: !!responded, response };
  }

  // 頁面發出的 cors 請求（crossorigin 的 script／preload）在 Chromium 上帶 Origin。
  const request = (url, { mode = "cors", method = "GET", range } = {}) => ({
    url,
    mode,
    method,
    headers: {
      get: (h) => {
        if (h === "range") return range || null;
        if (h === "origin") return mode === "cors" ? "https://example.test" : null;
        return null;
      },
    },
  });

  const cached = async () => {
    const m = caches.stores.get(OPEN_CACHE_PREFIX + "v1");
    return m ? [...m.keys()].map((u) => u.slice(SCOPE.length)).sort() : [];
  };

  return { self, caches, fetched, dispatch, request, cached, listeners };
}

// 假的 GitHub Pages：網頁列出 build 的檔，其餘 assets 照名字回內容。
function pages(build, { pageStatus = 200 } = {}) {
  const state = { build, pageStatus, down: false };
  const server = async (url) => {
    if (state.down) throw new TypeError("Failed to fetch");
    const rel = url.slice(SCOPE.length);
    if (rel === "" || rel === "index.html") return makeResponse(htmlFor(state.build), { status: state.pageStatus });
    // vite preview 這類伺服器回 `Vary: Origin`（GitHub Pages 是 Accept-Encoding）。
    if (rel.startsWith("assets/")) return makeResponse("content of " + rel, { vary: "Origin" });
    return makeResponse("not found", { status: 404 });
  };
  return { state, server };
}

async function installed(build = BUILD_A) {
  const site = pages(build);
  const sw = loadSw({ server: site.server });
  await sw.dispatch("install");
  await sw.dispatch("activate");
  sw.fetched.length = 0;
  return { ...sw, site };
}

describe("open cache service worker", () => {
  test("沿用頁面端的 cache 前綴：開關關掉時頁面端刪得到", () => {
    expect(SW_SRC).toContain(`'${OPEN_CACHE_PREFIX}'`);
  });

  test("install：照網頁列出的帶 hash 檔先存一份（manifest 這類不帶 hash 的不存）", async () => {
    const sw = await installed();
    expect(await sw.cached()).toEqual([...BUILD_A, "__pttchrome_open_cache_build__"].sort());
    expect(sw.self.skipWaiting).toHaveBeenCalled();
  });

  test("activate：開 navigation preload、接管目前頁面、清掉舊版本的 cache", async () => {
    const site = pages(BUILD_A);
    const sw = loadSw({ server: site.server });
    await sw.caches.open(OPEN_CACHE_PREFIX + "v0");
    await sw.caches.open("someone-else");
    await sw.dispatch("activate");
    expect(sw.self.registration.navigationPreload.enable).toHaveBeenCalled();
    expect(sw.self.clients.claim).toHaveBeenCalled();
    expect(await sw.caches.keys()).toEqual(["someone-else"]);
  });

  test("帶 hash 的檔有存就直接用：一次網路都不打", async () => {
    const sw = await installed();
    const { responded, response } = await sw.dispatch("fetch", { request: sw.request(SCOPE + BUILD_A[0]) });
    expect(responded).toBe(true);
    expect(response.body).toBe("content of " + BUILD_A[0]);
    expect(sw.fetched).toEqual([]);
  });

  test("沒存過的帶 hash 檔（lazy chunk）：下載一次並存起來，第二次不再下載", async () => {
    const sw = await installed();
    const lazy = SCOPE + "assets/PrefModal-ClDIQ7Zl.js";
    await sw.dispatch("fetch", { request: sw.request(lazy) });
    await sw.dispatch("fetch", { request: sw.request(lazy) });
    expect(sw.fetched).toEqual([lazy]);
  });

  test("下載失敗（404）不存：下次還會再問", async () => {
    const url = SCOPE + "assets/gone-ZZZZZZZZ.js";
    const failing = loadSw({ server: async () => makeResponse("nope", { status: 404 }) });
    const first = await failing.dispatch("fetch", { request: failing.request(url) });
    expect(first.response.status).toBe(404);
    await failing.dispatch("fetch", { request: failing.request(url) });
    expect(failing.fetched).toEqual([url, url]);
  });

  test.each([
    ["manifest", SCOPE + "manifest.webmanifest"],
    ["sw.js 自己", SCOPE + "sw.js"],
    ["source map（多段副檔名）", SCOPE + "assets/index-AAAAAAAA.js.map"],
    ["不帶 hash 的 assets 檔", SCOPE + "assets/logo.png"],
    ["scope 外的同站網址", "https://example.test/other/assets/index-AAAAAAAA.js"],
    ["跨站圖床", "https://i.imgur.com/abcdefg.jpg"],
  ])("不碰：%s", async (_name, url) => {
    const sw = await installed();
    const { responded } = await sw.dispatch("fetch", { request: sw.request(url) });
    expect(responded).toBe(false);
  });

  test("非 GET、Range 請求不碰", async () => {
    const sw = await installed();
    const url = SCOPE + BUILD_A[0];
    expect((await sw.dispatch("fetch", { request: sw.request(url, { method: "POST" }) })).responded).toBe(false);
    expect((await sw.dispatch("fetch", { request: sw.request(url, { range: "bytes=0-1" }) })).responded).toBe(false);
  });

  test("網頁本身一律先問網路：伺服器換了新版，這次開站就拿到新版", async () => {
    const sw = await installed();
    sw.site.state.build = BUILD_B;
    const { response } = await sw.dispatch("fetch", {
      request: sw.request(SCOPE, { mode: "navigate" }),
      preloadResponse: Promise.resolve(undefined),
    });
    expect(response.body).toContain(BUILD_B[0]);
    expect(sw.fetched[0]).toBe(SCOPE);
  });

  test("有 navigation preload 的回應就用它，不再另打一次", async () => {
    const sw = await installed();
    const preloaded = makeResponse(htmlFor(BUILD_A));
    const { response } = await sw.dispatch("fetch", {
      request: sw.request(SCOPE + "?site=x", { mode: "navigate" }),
      preloadResponse: Promise.resolve(preloaded),
    });
    expect(response).toBe(preloaded);
    expect(sw.fetched).toEqual([]);
  });

  test("換 build：補存新檔、清掉新網頁沒列出的舊檔，沒變的檔不重抓", async () => {
    const sw = await installed();
    sw.site.state.build = BUILD_B;
    await sw.dispatch("fetch", { request: sw.request(SCOPE + "assets/PrefModal-ClDIQ7Zl.js") });
    sw.fetched.length = 0;
    await sw.dispatch("fetch", { request: sw.request(SCOPE, { mode: "navigate" }) });
    expect(sw.fetched).toEqual([SCOPE, SCOPE + BUILD_B[0]]);
    expect(await sw.cached()).toEqual(["", ...BUILD_B, "__pttchrome_open_cache_build__"].sort());
  });

  test("同一個 build 重開：不清 lazy chunk", async () => {
    const sw = await installed();
    const lazy = "assets/PrefModal-ClDIQ7Zl.js";
    await sw.dispatch("fetch", { request: sw.request(SCOPE + lazy) });
    await sw.dispatch("fetch", { request: sw.request(SCOPE, { mode: "navigate" }) });
    expect(await sw.cached()).toContain(lazy);
  });

  test("斷線：退回存的那份網頁", async () => {
    const sw = await installed();
    await sw.dispatch("fetch", { request: sw.request(SCOPE, { mode: "navigate" }) });
    sw.site.state.down = true;
    const { response } = await sw.dispatch("fetch", { request: sw.request(SCOPE + "index.html", { mode: "navigate" }) });
    expect(response.body).toContain(BUILD_A[0]);
  });

  test("Pages 回 5xx：退回存的那份；4xx 照原樣給", async () => {
    const sw = await installed();
    await sw.dispatch("fetch", { request: sw.request(SCOPE, { mode: "navigate" }) });
    sw.site.state.pageStatus = 503;
    const down = await sw.dispatch("fetch", { request: sw.request(SCOPE, { mode: "navigate" }) });
    expect(down.response.status).toBe(200);
    sw.site.state.pageStatus = 404;
    const missing = await sw.dispatch("fetch", { request: sw.request(SCOPE, { mode: "navigate" }) });
    expect(missing.response.status).toBe(404);
  });

  test("從沒存過網頁又斷線：照樣丟出網路錯誤（交給瀏覽器的離線頁）", async () => {
    const site = pages(BUILD_A);
    site.state.down = true;
    const sw = loadSw({ server: site.server });
    await expect(sw.dispatch("fetch", { request: sw.request(SCOPE, { mode: "navigate" }) })).rejects.toThrow("Failed to fetch");
  });

  test("scope 底下其他導航（不是網頁本身）不碰", async () => {
    const sw = await installed();
    const { responded } = await sw.dispatch("fetch", { request: sw.request(SCOPE + "icon-512.png", { mode: "navigate" }) });
    expect(responded).toBe(false);
  });
});
