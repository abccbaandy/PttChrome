import {
  sanitizeForCloud,
  mergeCloudPrefs
} from "../../src/js/pref_sync_logic";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";

describe("sanitizeForCloud", () => {
  it("strips autoLoginPassword", () => {
    const out = sanitizeForCloud({
      ...DEFAULT_PREFS,
      autoLoginPassword: "secret"
    });
    expect(out).not.toHaveProperty("autoLoginPassword");
  });

  it("keeps every other key untouched", () => {
    const input = { ...DEFAULT_PREFS, fontSize: 24, blacklist: "foo\nbar" };
    const out = sanitizeForCloud(input);
    const { autoLoginPassword, ...expected } = input;
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
