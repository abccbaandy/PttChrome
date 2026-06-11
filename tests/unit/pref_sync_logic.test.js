import {
  sanitizeForCloud,
  mergeCloudPrefs,
  classifySnapshot
} from "../../src/js/pref_sync_logic";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";

describe("sanitizeForCloud", () => {
  it("strips autoLoginPassword and autoLoginUser", () => {
    const out = sanitizeForCloud({
      ...DEFAULT_PREFS,
      autoLoginUser: "ptt_user",
      autoLoginPassword: "secret"
    });
    expect(out).not.toHaveProperty("autoLoginPassword");
    expect(out).not.toHaveProperty("autoLoginUser");
  });

  it("keeps every other key untouched", () => {
    const input = { ...DEFAULT_PREFS, fontSize: 24, blacklist: "foo\nbar" };
    const out = sanitizeForCloud(input);
    const { autoLoginPassword, autoLoginUser, ...expected } = input;
    expect(out).toEqual(expected);
  });
});

describe("mergeCloudPrefs", () => {
  const local = { ...DEFAULT_PREFS, fontSize: 24, autoLoginPassword: "pw" };

  it("cloud wins over local for synced keys", () => {
    const out = mergeCloudPrefs(DEFAULT_PREFS, local, { fontSize: 18 });
    expect(out.fontSize).toBe(18);
  });

  it("always keeps the local password, even if cloud has one", () => {
    const out = mergeCloudPrefs(DEFAULT_PREFS, local, {
      autoLoginPassword: "evil-from-cloud"
    });
    expect(out.autoLoginPassword).toBe("pw");
  });

  it("password is empty string when local has none", () => {
    const out = mergeCloudPrefs(DEFAULT_PREFS, DEFAULT_PREFS, {});
    expect(out.autoLoginPassword).toBe("");
  });

  it("keeps the local autoLoginUser even when a legacy cloud doc has one", () => {
    const out = mergeCloudPrefs(
      DEFAULT_PREFS,
      { ...local, autoLoginUser: "local_user" },
      { autoLoginUser: "stale-from-cloud" }
    );
    expect(out.autoLoginUser).toBe("local_user");
  });

  it("autoLoginUser is empty string when local has none", () => {
    const out = mergeCloudPrefs(DEFAULT_PREFS, DEFAULT_PREFS, {
      autoLoginUser: "stale-from-cloud"
    });
    expect(out.autoLoginUser).toBe("");
  });

  it("backfills keys missing from cloud with local then defaults", () => {
    const out = mergeCloudPrefs(
      DEFAULT_PREFS,
      { ...DEFAULT_PREFS, lineWrap: 60 },
      { fontSize: 18 } // old cloud doc without newer keys
    );
    expect(out.lineWrap).toBe(60); // local kept
    expect(out.showFloorNumbers).toBe(DEFAULT_PREFS.showFloorNumbers);
  });

  it("nested termSize is replaced wholesale by cloud", () => {
    const out = mergeCloudPrefs(DEFAULT_PREFS, local, {
      termSize: { cols: 100, rows: 30 }
    });
    expect(out.termSize).toEqual({ cols: 100, rows: 30 });
  });

  it("result contains every DEFAULT_PREFS key", () => {
    const out = mergeCloudPrefs(DEFAULT_PREFS, {}, {});
    expect(Object.keys(out).sort()).toEqual(
      Object.keys(DEFAULT_PREFS).sort()
    );
  });
});

describe("classifySnapshot", () => {
  it("skips our own pending-write echo, whatever the doc state", () => {
    expect(
      classifySnapshot({
        exists: true,
        hasPendingWrites: true,
        fromCache: true,
        hasPrefs: true
      })
    ).toBe("skip-echo");
    expect(
      classifySnapshot({
        exists: false,
        hasPendingWrites: true,
        fromCache: false,
        hasPrefs: false
      })
    ).toBe("skip-echo");
  });

  it("pushes local prefs when the server confirms there is no doc", () => {
    expect(
      classifySnapshot({
        exists: false,
        hasPendingWrites: false,
        fromCache: false,
        hasPrefs: false
      })
    ).toBe("push-local");
  });

  it("pushes local prefs when the doc exists but has no prefs field", () => {
    expect(
      classifySnapshot({
        exists: true,
        hasPendingWrites: false,
        fromCache: false,
        hasPrefs: false
      })
    ).toBe("push-local");
  });

  // Regression guard: an offline cache miss must NOT be mistaken for a first
  // sign-in — the queued push would overwrite the real cloud prefs once the
  // connection comes back.
  it("waits (no push) when 'no doc' comes from the offline cache", () => {
    expect(
      classifySnapshot({
        exists: false,
        hasPendingWrites: false,
        fromCache: true,
        hasPrefs: false
      })
    ).toBe("skip-offline-missing");
  });

  it("merges a normal server doc", () => {
    expect(
      classifySnapshot({
        exists: true,
        hasPendingWrites: false,
        fromCache: false,
        hasPrefs: true
      })
    ).toBe("merge");
  });

  it("merges a cached copy of an existing doc (startup before reconnect)", () => {
    expect(
      classifySnapshot({
        exists: true,
        hasPendingWrites: false,
        fromCache: true,
        hasPrefs: true
      })
    ).toBe("merge");
  });
});
