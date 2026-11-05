// @unit-env browser
// APK 的「改用另一個協議」（docs/ssh.md「APK」）：bridge 'setProtocol' ＋能力旗標。
//   - 網頁端：只有 config.setProtocol（新版 APK 才宣告）時才給這個選項；舊 APK 退回不顯示。
//     回來的新站台記在模組裡（原生注入的 config 是 Object.freeze 的，不能改），之後的重連用它。
//   - 原生端沒有本機可跑的 JVM（CI 的 android.yml 才跑），宣告／分支／設定用靜態掃描守住。
import {
  androidCanSetProtocol,
  androidSetProtocol,
  androidSite,
  _resetSwitchedSiteForTest,
} from "../../src/js/android_bridge";
import activity from "../../android/app/src/main/java/io/github/abccbaandy/pttchrome/MainActivity.kt?raw";
import service from "../../android/app/src/main/java/io/github/abccbaandy/pttchrome/ConnectionService.kt?raw";
import appConfig from "../../android/app/src/main/java/io/github/abccbaandy/pttchrome/AppConfig.kt?raw";
import settingsActivity from "../../android/app/src/main/java/io/github/abccbaandy/pttchrome/SettingsActivity.kt?raw";

const WS_SITE = "wstelnet://127.0.0.1:4321/bbs/tok";
const SSH_SITE = "wssh://127.0.0.1:4321/ssh/tok";

function installAndroid(extra = {}) {
  const listeners = [];
  const sent = [];
  window.__PTT_ANDROID__ = Object.freeze({ version: "1", site: WS_SITE, ...extra });
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
  _resetSwitchedSiteForTest();
});

describe("web side", () => {
  test("old APK (no capability flag) ⇒ cannot switch, sends nothing", async () => {
    const { sent } = installAndroid();
    expect(androidCanSetProtocol()).toBe(false);
    expect(await androidSetProtocol("ssh")).toBe("");
    expect(sent).toEqual([]);
  });

  test("new APK ⇒ setProtocol returns the new site; later reconnects use it (frozen config untouched)", async () => {
    const { sent, respond } = installAndroid({ setProtocol: true });
    expect(androidCanSetProtocol()).toBe(true);
    const p = androidSetProtocol("ssh");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ op: "setProtocol", protocol: "ssh" });
    respond({ id: sent[0].id, ok: true, site: SSH_SITE });
    expect(await p).toBe(SSH_SITE);
    expect(androidSite()).toBe(SSH_SITE);
    expect(window.__PTT_ANDROID__.site).toBe(WS_SITE);
  });

  test("native failure ⇒ '' and the site stays", async () => {
    const { sent, respond } = installAndroid({ setProtocol: true });
    const p = androidSetProtocol("ssh");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    respond({ id: sent[0].id, ok: false, error: "failed" });
    expect(await p).toBe("");
    expect(androidSite()).toBe(WS_SITE);
  });

  test("not the APK ⇒ cannot switch", () => {
    expect(androidCanSetProtocol()).toBe(false);
  });
});

describe("native side (static)", () => {
  test("config declares setProtocol and the listener handles it, writing App settings", () => {
    expect(activity).toMatch(/\.put\("setProtocol",\s*true\)/);
    const i = activity.indexOf('"setProtocol" ->');
    expect(i).toBeGreaterThan(0);
    const branch = activity.slice(i, activity.indexOf("return@addWebMessageListener", i));
    expect(branch).toMatch(/AppConfig\.isProtocol\(protocol\)/);
    expect(branch).toMatch(/settings\.protocol = protocol/);
    expect(branch).toMatch(/\.put\("site", s\.site\)/);
  });

  test("the injected site follows the protocol setting", () => {
    expect(service).toMatch(/settings\.protocol == AppConfig\.PROTOCOL_SSH\) proxy\.sshSite else proxy\.site/);
    expect(appConfig).toMatch(/const val PROTOCOL_SSH = "ssh"/);
    expect(appConfig).toMatch(/const val PROTOCOL_WEBSOCKET = "websocket"/);
  });

  test("protocol lives in the native settings page, and a change rebuilds the WebView", () => {
    expect(settingsActivity).toMatch(/settings\.protocol = if \(checked\) AppConfig\.PROTOCOL_SSH else AppConfig\.PROTOCOL_WEBSOCKET/);
    expect(activity).toMatch(/\(service\?\.site \?: siteInUse\) == siteInUse/);
  });
});
