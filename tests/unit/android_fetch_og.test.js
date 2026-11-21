// @unit-env browser
// P110 網頁連結預覽卡第四步：APK 的 bridge 'fetchOg'＋能力旗標。
//   - 網頁端：只有 config.fetchOg（新版 APK 才宣告）時才問；舊 APK、失敗一律 null（照舊走 Worker）。
//   - 原生端沒有本機可跑的 JVM（CI 的 android.yml 才跑 OgFetchTest），宣告與分支、安全邊界用靜態掃描守住。
import { androidCanFetchOg, androidFetchOg } from "../../src/js/android_bridge";
import activity from "../../android/app/src/main/java/io/github/abccbaandy/pttchrome/MainActivity.kt?raw";
import ogFetch from "../../android/app/src/main/java/io/github/abccbaandy/pttchrome/OgFetch.kt?raw";
import workerOg from "../../proxy/imgur-worker/src/og.js?raw";

const SITE = "wstelnet://127.0.0.1:4321/bbs/tok";
const URL = "https://news.example.com/a/1";

function installAndroid(extra = {}) {
  const listeners = [];
  const sent = [];
  window.__PTT_ANDROID__ = Object.freeze({ version: "1", site: SITE, ...extra });
  window.PttAndroid = {
    postMessage: (str) => sent.push(JSON.parse(str)),
    addEventListener: (type, fn) => {
      if (type === "message") listeners.push(fn);
    },
  };
  const respond = (out) => listeners.forEach((fn) => fn({ data: JSON.stringify(out) }));
  return { sent, respond };
}

afterEach(() => {
  delete window.__PTT_ANDROID__;
  delete window.PttAndroid;
});

describe("網頁端", () => {
  test("不是 APK ⇒ 不能問", async () => {
    expect(androidCanFetchOg()).toBe(false);
    expect(await androidFetchOg(URL)).toBe(null);
  });

  test("舊 APK（沒有旗標）⇒ 不問、回 null", async () => {
    const { sent } = installAndroid({ fetchImage: true });
    expect(androidCanFetchOg()).toBe(false);
    expect(await androidFetchOg(URL)).toBe(null);
    expect(sent).toEqual([]);
  });

  test("新 APK ⇒ 回原生給的分享資訊（含 none）", async () => {
    const { sent, respond } = installAndroid({ fetchOg: true });
    expect(androidCanFetchOg()).toBe(true);
    const p = androidFetchOg(URL);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ op: "fetchOg", url: URL });
    respond({ id: sent[0].id, ok: true, title: "標題", site: "新聞網", image: "", url: URL });
    expect(await p).toMatchObject({ title: "標題", site: "新聞網" });

    const q = androidFetchOg(URL);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    respond({ id: sent[1].id, ok: true, none: true });
    expect(await q).toMatchObject({ none: true });
  });

  test("原生失敗 ⇒ null", async () => {
    const { sent, respond } = installAndroid({ fetchOg: true });
    const p = androidFetchOg(URL);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    respond({ id: sent[0].id, ok: false, error: "address" });
    expect(await p).toBe(null);
  });
});

describe("原生端（靜態）", () => {
  test("宣告 fetchOg，網路在 IO 執行緒、同時最多 2 個", () => {
    expect(activity).toMatch(/\.put\("fetchOg",\s*true\)/);
    const i = activity.indexOf('"fetchOg" ->');
    expect(i).toBeGreaterThan(0);
    const branch = activity.slice(i, activity.indexOf("return@addWebMessageListener", i));
    expect(branch).toMatch(/withContext\(Dispatchers\.IO\)/);
    expect(branch).toMatch(/ogFetchSlots\.withPermit/);
    expect(activity).toMatch(/ogFetchSlots = Semaphore\(2\)/);
    expect(branch).toMatch(/OgFetch\.fetch\(url\)/);
  });

  test("安全邊界：只收 https、擋內網位址、不自動跟轉址、正式呼叫不可關 strict", () => {
    expect(ogFetch).toMatch(/u\.scheme\.equals\("https", ignoreCase = true\)/);
    expect(ogFetch).toMatch(/fun isPublicAddress/);
    expect(ogFetch).toMatch(/addrs\.any \{ !isPublicAddress\(it\) \}/);
    expect(ogFetch).toMatch(/instanceFollowRedirects = false/);
    expect(ogFetch).toMatch(/strict: Boolean = true/);
    expect(activity).not.toMatch(/OgFetch\.fetch\([^)]*strict = false/);
  });

  test("上限跟 Worker 一樣（兩邊一起改）", () => {
    const num = (src, re) => Number((re.exec(src) || [])[1]?.replace(/_/g, ""));
    expect(num(ogFetch, /MAX_REDIRECTS = (\d+)/)).toBe(num(workerOg, /MAX_REDIRECTS = (\d+)/));
    expect(num(ogFetch, /MAX_HTML_BYTES = ([\d_]+)/)).toBe(num(workerOg, /MAX_HTML_BYTES = (\d+)/));
    expect(num(ogFetch, /MAX_TITLE = (\d+)/)).toBe(num(workerOg, /MAX_TITLE = (\d+)/));
    expect(num(ogFetch, /MAX_SITE = (\d+)/)).toBe(num(workerOg, /MAX_SITE = (\d+)/));
    // ReDoS 守護：<meta 掃描不跨過下一個 <。
    expect(ogFetch).toMatch(/<meta\\\\b\[\^<>\]\*>/);
  });
});
