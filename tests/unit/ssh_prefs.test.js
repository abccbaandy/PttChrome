// SSH 協議的偏好（docs/ssh.md）：relay 位址的正規化、協議與 relay 位址都不同步、不進備份。
// 為什麼本機專屬：自架 relay 是 ws://127.0.0.1＋這台機器的 token，同步到別台就連不上。
import { sshSiteFromPrefs, defaultSshSite, DEFAULT_SSH_RELAY_HOST } from "../../src/js/util";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";
import { LOCAL_ONLY_PREF_KEYS, sanitizeForCloud, mergeCloudPrefs } from "../../src/js/pref_sync_logic";
import { buildExportPayload, mergeImportedPrefs } from "../../src/js/pref_backup";
import { parseSite } from "../../src/js/transport";

const ssh = (sshRelayUrl) => sshSiteFromPrefs({ connectionProtocol: "ssh", sshRelayUrl });

describe("sshSiteFromPrefs", () => {
  test("websocket protocol (default) → ''", () => {
    expect(sshSiteFromPrefs({ ...DEFAULT_PREFS })).toBe("");
    expect(DEFAULT_PREFS.connectionProtocol).toBe("websocket");
  });

  test("empty → the public relay", () => {
    expect(ssh("")).toBe(defaultSshSite());
    expect(ssh("   ")).toBe(defaultSshSite());
    expect(defaultSshSite()).toBe("wsssh://" + DEFAULT_SSH_RELAY_HOST + "/ssh");
  });

  test.each([
    ["relay.example", "wsssh://relay.example/ssh"],
    ["wss://relay.example/ssh", "wsssh://relay.example/ssh"],
    ["ws://127.0.0.1:8022/ssh/tok", "wssh://127.0.0.1:8022/ssh/tok"],
    ["wssh://127.0.0.1:8022/ssh/tok", "wssh://127.0.0.1:8022/ssh/tok"],
    ["wsssh://relay.example", "wsssh://relay.example/ssh"],
  ])("%s → %s", (input, site) => {
    expect(ssh(input)).toBe(site);
    expect(parseSite(site).protocol).toBe("ssh");
  });
});

describe("protocol prefs never leave this machine", () => {
  const local = { ...DEFAULT_PREFS, connectionProtocol: "ssh", sshRelayUrl: "wssh://127.0.0.1:8022/ssh/tok" };

  test("local-only keys", () => {
    expect(LOCAL_ONLY_PREF_KEYS).toEqual(expect.arrayContaining(["connectionProtocol", "sshRelayUrl"]));
  });

  test("not uploaded, and a cloud doc cannot override them", () => {
    const up = sanitizeForCloud(local);
    expect(up).not.toHaveProperty("connectionProtocol");
    expect(up).not.toHaveProperty("sshRelayUrl");
    const merged = mergeCloudPrefs(DEFAULT_PREFS, local, {
      connectionProtocol: "websocket",
      sshRelayUrl: "wsssh://evil.example/ssh",
    });
    expect(merged.connectionProtocol).toBe("ssh");
    expect(merged.sshRelayUrl).toBe("wssh://127.0.0.1:8022/ssh/tok");
  });

  test("not in a settings export, and an import cannot set them", () => {
    const payload = buildExportPayload(local);
    expect(JSON.stringify(payload)).not.toContain("connectionProtocol");
    expect(JSON.stringify(payload)).not.toContain("127.0.0.1:8022");
    const merged = mergeImportedPrefs(DEFAULT_PREFS, local, {
      connectionProtocol: "websocket",
      sshRelayUrl: "wsssh://evil.example/ssh",
    });
    expect(merged.connectionProtocol).toBe("ssh");
    expect(merged.sshRelayUrl).toBe("wssh://127.0.0.1:8022/ssh/tok");
  });
});
