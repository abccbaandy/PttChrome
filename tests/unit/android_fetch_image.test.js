// @unit-env browser
// P107 離線文章連圖片一起存（只做 APK）第二步：bridge 'fetchImage'＋能力旗標。
//   - 網頁端：只有 config.fetchImage（新版 APK 才宣告）時才問；舊 APK、失敗、回覆不成形一律 null（照舊只存連結）。
//   - 原生端沒有本機可跑的 JVM（CI 的 android.yml 才跑 ImageFetchTest），宣告與分支用靜態掃描守住。
import { androidCanFetchImage, androidFetchImage } from "../../src/js/android_bridge";
import activity from "../../android/app/src/main/java/io/github/abccbaandy/pttchrome/MainActivity.kt?raw";
import imageFetch from "../../android/app/src/main/java/io/github/abccbaandy/pttchrome/ImageFetch.kt?raw";
import networkConfig from "../../android/app/src/main/res/xml/network_security_config.xml?raw";

const SITE = "wstelnet://127.0.0.1:4321/bbs/tok";
const URL = "https://i.imgur.com/abc.jpg";

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

describe("web side", () => {
  test("not the APK ⇒ cannot fetch", async () => {
    expect(androidCanFetchImage()).toBe(false);
    expect(await androidFetchImage(URL)).toBe(null);
  });

  test("old APK (no capability flag) ⇒ null without asking", async () => {
    const { sent } = installAndroid();
    expect(androidCanFetchImage()).toBe(false);
    expect(await androidFetchImage(URL)).toBe(null);
    expect(sent).toEqual([]);
  });

  test("new APK ⇒ returns the encoded image", async () => {
    const { sent, respond } = installAndroid({ fetchImage: true });
    expect(androidCanFetchImage()).toBe(true);
    const p = androidFetchImage(URL);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ op: "fetchImage", url: URL });
    respond({ id: sent[0].id, ok: true, mime: "image/webp", data: "AQID", w: 1080, h: 720 });
    expect(await p).toEqual({ mime: "image/webp", data: "AQID", w: 1080, h: 720 });
  });

  test.each([
    [{ ok: false, error: "tooLarge" }],
    [{ ok: true, mime: "image/webp", data: "" }],
    [{ ok: true, data: "AQID" }],
    [{ ok: "yes", mime: "image/webp", data: "AQID" }],
  ])("failure or malformed reply %j ⇒ null", async (out) => {
    const { sent, respond } = installAndroid({ fetchImage: true });
    const p = androidFetchImage(URL);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    respond({ id: sent[0].id, ...out });
    expect(await p).toBe(null);
  });

  test("empty url ⇒ null without asking", async () => {
    const { sent } = installAndroid({ fetchImage: true });
    expect(await androidFetchImage("")).toBe(null);
    expect(sent).toEqual([]);
  });
});

describe("native side (static)", () => {
  test("config declares fetchImage and the listener replies off the main thread work", () => {
    expect(activity).toMatch(/\.put\("fetchImage",\s*true\)/);
    const i = activity.indexOf('"fetchImage" ->');
    expect(i).toBeGreaterThan(0);
    const branch = activity.slice(i, activity.indexOf("return@addWebMessageListener", i));
    expect(branch).toMatch(/withContext\(Dispatchers\.IO\)/);
    expect(branch).toMatch(/ImageFetch\.fetch\(id, url\)/);
    expect(branch).toMatch(/reply\.postMessage\(res\.toString\(\)\)/);
  });

  test("only https, no GIF, size limits, downscale to 1080 WebP", () => {
    expect(imageFetch).toMatch(/u\.scheme\.equals\("https", ignoreCase = true\)/);
    expect(imageFetch).toMatch(/type != "image\/gif"/);
    expect(imageFetch).toMatch(/const val MAX_BYTES = 8 \* 1024 \* 1024/);
    expect(imageFetch).toMatch(/const val MAX_WIDTH = 1080/);
    expect(imageFetch).toMatch(/WEBP_LOSSY/);
    // 正式呼叫不可關掉 https 檢查（requireHttps 只給 JVM 測試的本機 http server 用）。
    expect(imageFetch).toMatch(/requireHttps: Boolean = true/);
    expect(imageFetch).not.toMatch(/download\([^)]*requireHttps = false/);
  });

  test("cleartext stays off (http images are left as links, not fetched)", () => {
    expect(networkConfig).toMatch(/cleartextTrafficPermitted="false"/);
  });
});
