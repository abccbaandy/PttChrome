// @unit-env browser
// APK 回報「行動數據／計費網路」（android_bridge.js 'networkState'＋'pttandroid:network'）。
//   - 網頁端：只有 config.networkState（新版 APK 才宣告）時才問；舊 APK 一律當不是行動網路、什麼都不送。
//     先綁事件再問現況；回覆路上若已收到較新的事件，以事件為準。
//   - 原生端沒有本機可跑的 JVM 測試（判準的 JVM 測試是 NetworkWatchTest，CI 的 android.yml 才跑），
//     宣告／分支／權限用靜態掃描守住。
import {
  androidCanReportNetwork,
  NETWORK_EVENT,
  watchAndroidMeteredNetwork,
} from "../../src/js/android_bridge";
import activity from "../../android/app/src/main/java/io/github/abccbaandy/pttchrome/MainActivity.kt?raw";
import watch from "../../android/app/src/main/java/io/github/abccbaandy/pttchrome/NetworkWatch.kt?raw";
import manifest from "../../android/app/src/main/AndroidManifest.xml?raw";

function installAndroid(extra = {}) {
  const listeners = [];
  const sent = [];
  window.__PTT_ANDROID__ = Object.freeze({ version: "1", site: "", ...extra });
  window.PttAndroid = {
    postMessage: (str) => sent.push(JSON.parse(str)),
    addEventListener: (type, fn) => {
      if (type === "message") listeners.push(fn);
    },
  };
  const respond = (out) => listeners.forEach((fn) => fn({ data: JSON.stringify(out) }));
  return { sent, respond };
}

const fire = (metered) =>
  window.dispatchEvent(new CustomEvent(NETWORK_EVENT, { detail: { metered } }));

let stop = () => {};
afterEach(() => {
  stop();
  stop = () => {};
  delete window.__PTT_ANDROID__;
  delete window.PttAndroid;
});

describe("web side", () => {
  test("不是 APK ⇒ 不回報、不呼叫", () => {
    const fn = vi.fn();
    stop = watchAndroidMeteredNetwork(fn);
    fire(true);
    expect(fn).not.toHaveBeenCalled();
  });

  test("舊 APK（沒宣告 networkState）⇒ 不問、不聽", () => {
    const { sent } = installAndroid();
    expect(androidCanReportNetwork()).toBe(false);
    const fn = vi.fn();
    stop = watchAndroidMeteredNetwork(fn);
    fire(true);
    expect(sent).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  test("新 APK ⇒ 問一次現況，之後跟著事件走", async () => {
    const { sent, respond } = installAndroid({ networkState: true });
    const fn = vi.fn();
    stop = watchAndroidMeteredNetwork(fn);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ op: "networkState" });
    respond({ id: sent[0].id, ok: true, metered: true });
    await vi.waitFor(() => expect(fn).toHaveBeenLastCalledWith(true));
    fire(false);
    expect(fn).toHaveBeenLastCalledWith(false);
  });

  test("回覆還在路上就收到事件 ⇒ 以較新的事件為準", async () => {
    const { sent, respond } = installAndroid({ networkState: true });
    const fn = vi.fn();
    stop = watchAndroidMeteredNetwork(fn);
    fire(false);
    respond({ id: sent[0].id, ok: true, metered: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(fn.mock.calls).toEqual([[false]]);
  });

  test("取消訂閱後事件不再傳進來", () => {
    installAndroid({ networkState: true });
    const fn = vi.fn();
    watchAndroidMeteredNetwork(fn)();
    fire(true);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("native side (static)", () => {
  test("宣告能力旗標、處理 networkState、變了就發事件", () => {
    expect(activity).toMatch(/\.put\("networkState", true\)/);
    expect(activity).toMatch(/"networkState" -> \{/);
    expect(activity).toMatch(/\.put\("metered", networkWatch\.metered\)/);
    expect(activity).toContain("'pttandroid:network'");
    // 生命週期跟 Activity：註冊與解除都在。
    expect(activity).toMatch(/networkWatch\.start\(\)/);
    expect(activity).toMatch(/networkWatch\.stop\(\)/);
  });

  test("看預設網路、判準含計費（不只 cellular）", () => {
    expect(watch).toMatch(/registerDefaultNetworkCallback/);
    expect(watch).toMatch(/NET_CAPABILITY_NOT_METERED/);
    expect(watch).toMatch(/TRANSPORT_CELLULAR/);
  });

  test("manifest 有 ACCESS_NETWORK_STATE（registerDefaultNetworkCallback 需要）", () => {
    expect(manifest).toMatch(/android\.permission\.ACCESS_NETWORK_STATE/);
  });
});
