// 防閒置／半開斷線偵測的決策（src/js/keep_alive.js）。
// 規格來源：PTT 站方公告（PttCurrent 2026-09-23）——送 IAC DO TIMING-MARK、
// 使用者有輸入就重置計時、沒收到回應可判定半開斷線。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decideKeepAlive, KEEP_ALIVE_TIMEOUT_MS } from "../../src/js/keep_alive";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";
import { zh_TW } from "../../src/js/zh_TW_messages";
import { en_US } from "../../src/js/en_US_messages";

const base = {
  intervalMs: 180000,
  timeoutMs: 30000,
  lastSendAt: 0,
  lastRecvAt: 0,
  probeAt: null,
};

describe("decideKeepAlive", () => {
  test("interval 0（停用）永遠不動作，即使有未回應的 probe", () => {
    expect(decideKeepAlive({ ...base, intervalMs: 0, now: 1e9 }).action).toBe(null);
    expect(
      decideKeepAlive({ ...base, intervalMs: 0, probeAt: 1, now: 1e9 }).action,
    ).toBe(null);
  });

  test("還沒到間隔不送", () => {
    expect(decideKeepAlive({ ...base, now: 179999 }).action).toBe(null);
  });

  test("距上次送出滿間隔就 probe（邊界含等號）", () => {
    expect(decideKeepAlive({ ...base, now: 180000 }).action).toBe("probe");
  });

  test("使用者有送出（按鍵）就重置計時", () => {
    expect(
      decideKeepAlive({ ...base, lastSendAt: 100000, now: 200000 }).action,
    ).toBe(null);
  });

  test("probe 待回應期間不重複送", () => {
    expect(
      decideKeepAlive({
        ...base,
        lastSendAt: 180000,
        probeAt: 180000,
        now: 200000,
      }).action,
    ).toBe(null);
  });

  test("probe 後收到任何資料＝活著，回到一般計時", () => {
    const r = decideKeepAlive({
      ...base,
      lastSendAt: 180000,
      probeAt: 180000,
      lastRecvAt: 180050,
      now: 400000,
    });
    expect(r.action).toBe("probe");
  });

  test("probe 逾時沒回應 → dead（邊界含等號）", () => {
    const s = { ...base, lastSendAt: 180000, probeAt: 180000, lastRecvAt: 1000 };
    expect(decideKeepAlive({ ...s, now: 209999 }).action).toBe(null);
    expect(decideKeepAlive({ ...s, now: 210000 }).action).toBe("dead");
  });

  test("probe 同一毫秒收到的舊資料不算回應", () => {
    const s = { ...base, lastSendAt: 180000, probeAt: 180000, lastRecvAt: 180000 };
    expect(decideKeepAlive({ ...s, now: 210000 }).action).toBe("dead");
  });

  test("預設逾時為 30 秒", () => {
    expect(KEEP_ALIVE_TIMEOUT_MS).toBe(30000);
  });
});

// 靜態守護：防閒置不准再改回「送按鍵」式（ESC ESC／NUL／^L／方向鍵）。
// 那類 byte 會進 server 的 vkey，推文型別選單會把 ESC 當成「推」。
describe("pttchrome.jsx 不再送按鍵式防閒置", () => {
  test("沒有 ANTI_IDLE_STR", () => {
    const src = readFileSync(
      resolve(__dirname, "../../src/js/pttchrome.jsx"),
      "utf8",
    );
    expect(src).not.toMatch(/ANTI_IDLE_STR/);
    expect(src).toMatch(/sendTimingMark\(\)/);
  });
});

// 設定頁說明寫明預設值（使用者改掉後才知道怎麼改回），而且必須跟 DEFAULT_PREFS 同步。
describe("設定說明的預設值與 DEFAULT_PREFS 一致", () => {
  test.each([
    ["zh_TW", zh_TW, (n) => `預設 ${n} 秒`],
    ["en_US", en_US, (n) => `Default: ${n} seconds`],
  ])("%s", (_, msgs, phrase) => {
    expect(msgs.tooltip_antiIdleTime.message).toContain(phrase(DEFAULT_PREFS.antiIdleTime));
  });
});
