import {
  sanitizeForCloud,
  mergeCloudPrefs,
  classifySnapshot,
  deepEqual,
  LOCAL_ONLY_PREF_KEYS
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

  it("strips every LOCAL_ONLY_PREF_KEYS entry (incl. enableWorkMode)", () => {
    const out = sanitizeForCloud({ ...DEFAULT_PREFS, enableWorkMode: true });
    for (const key of LOCAL_ONLY_PREF_KEYS) {
      expect(out).not.toHaveProperty(key);
    }
    expect(LOCAL_ONLY_PREF_KEYS).toContain("enableWorkMode");
  });

  it("keeps every other key untouched", () => {
    const input = { ...DEFAULT_PREFS, fontSize: 24, blacklist: "foo\nbar" };
    const out = sanitizeForCloud(input);
    const expected = { ...input };
    for (const key of LOCAL_ONLY_PREF_KEYS) delete expected[key];
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

  it("cloud can never flip enableWorkMode (local-only, per machine)", () => {
    const out = mergeCloudPrefs(
      DEFAULT_PREFS,
      { ...DEFAULT_PREFS, enableWorkMode: false },
      { enableWorkMode: true } // a synced copy must not turn it on here
    );
    expect(out.enableWorkMode).toBe(false);
  });

  it("enableWorkMode falls back to the default when local has no value", () => {
    const out = mergeCloudPrefs(DEFAULT_PREFS, {}, { enableWorkMode: true });
    expect(out.enableWorkMode).toBe(DEFAULT_PREFS.enableWorkMode);
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

describe("deepEqual", () => {
  it("ignores object key order (Firestore map round-trip)", () => {
    expect(
      deepEqual(
        { termSize: { cols: 80, rows: 24 }, fontSize: 16 },
        { fontSize: 16, termSize: { rows: 24, cols: 80 } }
      )
    ).toBe(true);
  });

  it("detects nested value differences", () => {
    expect(
      deepEqual({ termSize: { cols: 80, rows: 24 } }, { termSize: { cols: 80, rows: 25 } })
    ).toBe(false);
  });

  it("detects missing/extra keys", () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  it("handles primitives, null and arrays", () => {
    expect(deepEqual("x", "x")).toBe(true);
    expect(deepEqual(1, "1")).toBe(false);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual([1, 2], [1, 2])).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
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
