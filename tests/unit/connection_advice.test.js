// 連線失敗提示的決策表：判斷結果＋建議清單（src/js/connection_probe.js#adviseConnectFailure，
// docs/ssh.md「失敗提示」）。建議都是使用者手動按才生效；被 PTT 封鎖時呼叫端不診斷（App.onClose），
// 那條守在 connection_alert_diagnosis.test.jsx。
import { adviseConnectFailure } from "../../src/js/connection_probe";

const WS_DEFAULT = "wsstelnet://ws.ptt.cc/bbs";
const PROXY = "wsstelnet://relay.dev/bbs";
const SSH = "wsssh://relay.example/ssh";
const ANDROID_WS = "wstelnet://127.0.0.1:4321/bbs/tok";
const ANDROID_SSH = "wssh://127.0.0.1:4321/ssh/tok";

const advise = (o) =>
  adviseConnectFailure({
    defaultSite: WS_DEFAULT,
    proxySite: PROXY,
    probe: async () => false,
    canSwitch: true,
    ...o,
  });

describe("WebSocket failed", () => {
  test("Origin blocked ⇒ proxy and switch to SSH", async () => {
    expect(await advise({ site: WS_DEFAULT, opened: false, probe: async () => true })).toEqual({
      verdict: "origin",
      suggestions: ["proxy", "useSsh"],
    });
  });

  test("PTT unreachable ⇒ switch to SSH only", async () => {
    expect(await advise({ site: WS_DEFAULT, opened: false })).toEqual({
      verdict: "unreachable",
      suggestions: ["useSsh"],
    });
  });

  test("already on the telnet proxy ⇒ no probe, still offer SSH", async () => {
    const probe = vi.fn();
    expect(await advise({ site: PROXY, opened: false, probe })).toEqual({ verdict: null, suggestions: ["useSsh"] });
    expect(probe).not.toHaveBeenCalled();
  });

  test("dropped after it was open ⇒ no switch (it worked)", async () => {
    expect(await advise({ site: WS_DEFAULT, opened: true })).toEqual({ verdict: "disconnected", suggestions: [] });
  });

  test("this page can't run SSH (not a secure context) ⇒ no SSH suggestion", async () => {
    expect((await advise({ site: WS_DEFAULT, opened: false, canSwitch: false })).suggestions).toEqual([]);
  });
});

describe("SSH failed", () => {
  test.each([
    ["relay", "sshRelay", ["useWebsocket", "checkRelay"]],
    ["tcp", "sshUnreachable", ["useWebsocket"]],
    ["hostkey", "sshHostKey", ["useWebsocket"]],
    ["unsupported", "sshUnsupported", ["useWebsocket"]],
    ["protocol", "sshProtocol", ["useWebsocket"]],
    ["auth", "sshProtocol", ["useWebsocket"]],
  ])("close reason %s ⇒ %s", async (closeReason, verdict, suggestions) => {
    const probe = vi.fn();
    expect(await advise({ site: SSH, opened: false, closeReason, probe })).toEqual({ verdict, suggestions });
    expect(probe).not.toHaveBeenCalled();
  });

  test("dropped after it was open ⇒ no switch", async () => {
    expect(await advise({ site: SSH, opened: true, closeReason: "closed" })).toEqual({
      verdict: "disconnected",
      suggestions: [],
    });
  });
});

describe("Android APK (native local proxy)", () => {
  test("WebSocket failed ⇒ no Origin probe; switch to SSH when the APK supports it", async () => {
    const probe = vi.fn();
    expect(await advise({ site: ANDROID_WS, opened: false, android: true, probe })).toEqual({
      verdict: null,
      suggestions: ["useSsh"],
    });
    expect(probe).not.toHaveBeenCalled();
  });

  test("old APK without the capability flag ⇒ nothing to suggest", async () => {
    expect(await advise({ site: ANDROID_WS, opened: false, android: true, canSwitch: false })).toEqual({
      verdict: null,
      suggestions: [],
    });
  });

  test("SSH failed ⇒ switch to WebSocket; no relay address to check (it's native)", async () => {
    expect(await advise({ site: ANDROID_SSH, opened: false, android: true, closeReason: "relay" })).toEqual({
      verdict: "sshRelay",
      suggestions: ["useWebsocket"],
    });
  });
});
