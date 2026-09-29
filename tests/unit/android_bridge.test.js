// Android APK 殼 ↔ 網頁的 bridge（src/js/android_bridge.js）。原生端是
// androidx.webkit WebMessageListener：物件有 postMessage(string)，回覆以
// MessageEvent（data＝字串）送回。這裡用假物件模擬原生端。
import {
  isAndroidApp,
  androidSite,
  androidBridgeAvailable,
  requestAndroid,
  androidImeInset,
  onAndroidIme,
  IME_EVENT,
  _REQUEST_TIMEOUT_MS
} from "../../src/js/android_bridge";

// 回傳 { sent, respond }：sent＝網頁送出的訊息；respond(obj)＝模擬原生回覆。
function installAndroid({ site = "wstelnet://127.0.0.1:4321/bbs/tok" } = {}) {
  const listeners = [];
  const sent = [];
  window.__PTT_ANDROID__ = { version: "1", site };
  window.PttAndroid = {
    postMessage: str => sent.push(JSON.parse(str)),
    addEventListener: (type, fn) => {
      if (type === "message") listeners.push(fn);
    }
  };
  const respond = out =>
    listeners.forEach(fn => fn({ data: JSON.stringify(out) }));
  return { sent, respond };
}

afterEach(() => {
  delete window.__PTT_ANDROID__;
  delete window.PttAndroid;
  vi.useRealTimers();
});

describe("detection", () => {
  test("a normal browser page is not the Android app", () => {
    expect(isAndroidApp()).toBe(false);
    expect(androidSite()).toBe("");
    expect(androidBridgeAvailable()).toBe(false);
  });

  test("injected config exposes the native proxy site", () => {
    installAndroid();
    expect(isAndroidApp()).toBe(true);
    expect(androidSite()).toBe("wstelnet://127.0.0.1:4321/bbs/tok");
    expect(androidBridgeAvailable()).toBe(true);
  });

  test("config without the message channel is not a usable bridge", () => {
    window.__PTT_ANDROID__ = { site: "x" };
    expect(isAndroidApp()).toBe(true);
    expect(androidBridgeAvailable()).toBe(false);
  });
});

describe("requestAndroid", () => {
  test("rejects without a bridge", async () => {
    await expect(requestAndroid("getPassword")).rejects.toThrow(/unavailable/);
  });

  test("matches replies to requests by id, even out of order", async () => {
    const { sent, respond } = installAndroid();
    const a = requestAndroid("getPassword");
    const b = requestAndroid("storePassword", { user: "u", password: "p" });
    expect(sent.map(m => m.op)).toEqual(["getPassword", "storePassword"]);
    expect(sent[1]).toMatchObject({ user: "u", password: "p" });

    respond({ id: sent[1].id, ok: true });
    respond({ id: sent[0].id, ok: true, user: "guest1", password: "pw" });
    await expect(b).resolves.toEqual({ id: sent[1].id, ok: true });
    await expect(a).resolves.toMatchObject({ user: "guest1", password: "pw" });
  });

  test("ignores garbage and unknown ids", async () => {
    const { sent, respond } = installAndroid();
    const a = requestAndroid("getPassword");
    respond({ id: 99999, ok: true });
    respond("not json");
    respond({ id: sent[0].id, ok: false });
    await expect(a).resolves.toMatchObject({ ok: false });
  });

  test("times out when native never answers", async () => {
    vi.useFakeTimers();
    installAndroid();
    const a = requestAndroid("getPassword");
    const settled = expect(a).rejects.toThrow(/timeout/);
    vi.advanceTimersByTime(_REQUEST_TIMEOUT_MS + 1);
    await settled;
  });

  test("a replaced channel object (WebView recreated) still gets replies", async () => {
    installAndroid();
    const first = requestAndroid("getPassword");
    const { sent, respond } = installAndroid();
    const second = requestAndroid("getPassword");
    respond({ id: sent[0].id, ok: true, user: "x", password: "y" });
    await expect(second).resolves.toMatchObject({ user: "x" });
    first.catch(() => {});
  });
});

describe("IME inset notifications (native → page)", () => {
  test("tracks the reported keyboard height and notifies subscribers", () => {
    const seen = [];
    const off = onAndroidIme(v => seen.push(v));
    window.dispatchEvent(new CustomEvent(IME_EVENT, { detail: { inset: 312 } }));
    expect(androidImeInset()).toBe(312);
    window.dispatchEvent(new CustomEvent(IME_EVENT, { detail: { inset: 0 } }));
    window.dispatchEvent(new CustomEvent(IME_EVENT, { detail: { inset: -5 } }));
    expect(seen).toEqual([312, 0, 0]);
    off();
    window.dispatchEvent(new CustomEvent(IME_EVENT, { detail: { inset: 99 } }));
    expect(seen).toHaveLength(3);
  });
});
