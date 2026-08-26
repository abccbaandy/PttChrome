// @vitest-environment node
//
// 共用 session 的開機（`tests/e2e/helpers/ptt.js#autoLoginBoot`）＝整輪 live e2e 的
// **唯一一次登入**。它同時也是「開站自動登入」那條 spec 的被測行為。
//
// 為什麼在 unit 測：這裡最要緊的分支全都只在「事情不順」時才走到 —— 被 PTT 封鎖、
// 被節流、帳密錯、站台維護 —— 而那些狀態沒辦法在 live e2e 裡穩定製造，偏偏每一條
// 走錯都會直接害到帳號（多送一次登入就多延長一次封鎖）。所以拿假 page 餵畫面序列驗
// 決策，跟 e2e_login_flow.test.js 同一個理由。
//
// node env（非 jsdom）：helper 裡的 page.evaluate 閉包只讀 window/document，
// 這裡自己塞一份最小的假全域，比在 jsdom 上動真的 document 乾淨。
import { afterEach, beforeEach } from "vitest";
import { autoLoginBoot } from "../e2e/helpers/ptt";
import { clearBotBlock, readBotBlock } from "../e2e/helpers/bot_block";

const MAIN_MENU = "【主功能表】 心情不好嗎？找人聊聊吧！";
const BOT_BLOCK =
  "[PTT DDoS/BOT 偵測系統] 偵測到連線異常/不當連續登入行為！\n帳號 *** 已被暫時禁止登入。";
const THROTTLED = "登入太頻繁, 為避免系統負荷過重, 請稍後再試";
const VERIFYING = "正在檢查帳號與密碼...";
const BAD_PASSWORD = "密碼不對喔！請重新輸入。";
const GUEST_FULL = "系統過載, 目前有太多 guest 在站上, 請稍後再來";

// 假 page：evaluate 直接呼叫傳進來的閉包，window/document 由這裡供應。
// screens 是「每次 readScreen 依序吐什麼」，用完停在最後一格。
function makePage(screens, opts = {}) {
  const calls = { goto: 0, addInitScript: [], slept: 0 };
  let i = 0;
  globalThis.window = {
    __app: {
      isConnected: () => opts.connected !== false,
      connectState: 1,
    },
  };
  globalThis.document = {
    querySelector: () => ({
      get innerText() {
        const s = screens[Math.min(i, screens.length - 1)];
        ++i;
        return s;
      },
    }),
  };
  return {
    calls,
    async addInitScript(fn, arg) {
      calls.addInitScript.push(arg);
    },
    async goto() {
      ++calls.goto;
    },
    async evaluate(fn, arg) {
      return fn(arg);
    },
    // 不真的睡：這些分支的退避是 30 秒，測試不該跟著等。
    async waitForTimeout(ms) {
      calls.slept += ms;
    },
  };
}

// 這一檔會動 env（helper 直接讀 process.env）⇒ 存原值、跑完還原，不要污染別的檔。
const ENV_KEYS = ["PTT_USER", "PTT_PASS", "PTT_OTP_SECRET"];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  clearBotBlock();
  process.env.PTT_USER = "e2e-test-user";
  process.env.PTT_PASS = "e2e-test-pass";
  process.env.PTT_OTP_SECRET = "";
});

afterEach(() => {
  // 只刪閂鎖檔本身。**不可以**連 test-results/ 一起刪 —— 那是 Playwright 的輸出
  // 目錄（截圖／錄影／report），unit 跑一次就把上一輪 e2e 的失敗證據清光。
  clearBotBlock();
  delete globalThis.window;
  delete globalThis.document;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("autoLoginBoot：一輪一次登入的開機", () => {
  test("看到主功能表就回開機證據（開站一次，一個鍵都沒送）", async () => {
    const page = makePage([VERIFYING, VERIFYING, MAIN_MENU]);
    const r = await autoLoginBoot(page);
    expect(r.screen).toContain("主功能表");
    expect(r.retries).toBe(0);
    expect(page.calls.goto).toBe(1); // 唯一一次開站＝唯一一次登入
  });

  test("prefs 走 addInitScript 注入（auto_login 只在 connect 當下讀）", async () => {
    const page = makePage([MAIN_MENU]);
    await autoLoginBoot(page);
    expect(page.calls.addInitScript.length).toBe(1);
    const values = page.calls.addInitScript[0].extra;
    expect(values.autoLogin).toBe(true);
    expect(values.autoLoginUser).toBe("e2e-test-user");
    // 跳過歡迎頁、重複登入一律答 N —— 這一輪只有一條連線，不該去砍別人的。
    expect(values.autoLoginSkipWelcome).toBe(true);
    expect(values.autoLoginDupConn).toBe("N");
  });

  test("被 PTT 封鎖：立刻丟、立閂鎖，而且**不重開站**", async () => {
    const page = makePage([BOT_BLOCK, BOT_BLOCK, MAIN_MENU]);
    await expect(autoLoginBoot(page)).rejects.toThrow(/DDoS\/BOT/);
    // 這是唯一一種「再試一次」嚴格劣於「什麼都不做」的失敗。
    expect(page.calls.goto).toBe(1);
    expect(readBotBlock()).toContain("不要重跑");
  });

  test("閂鎖已在（同一輪稍早被鎖）：連 addInitScript 都不做", async () => {
    const first = makePage([BOT_BLOCK]);
    await expect(autoLoginBoot(first)).rejects.toThrow();
    const second = makePage([MAIN_MENU]);
    await expect(autoLoginBoot(second)).rejects.toThrow(/略過/);
    expect(second.calls.goto).toBe(0);
    expect(second.calls.addInitScript.length).toBe(0);
  });

  test("節流：退避後重開站，成功就回來（重試次數記在證據裡）", async () => {
    const page = makePage([THROTTLED, MAIN_MENU]);
    const r = await autoLoginBoot(page);
    expect(r.retries).toBe(1);
    expect(page.calls.goto).toBe(2);
    expect(page.calls.slept).toBeGreaterThanOrEqual(30000); // 退避真的有等
  });

  test("節流：重試有上限，不會無限重登", async () => {
    const page = makePage([THROTTLED]);
    await expect(autoLoginBoot(page)).rejects.toThrow(/節流.*仍失敗/s);
    // 首次 + 上限 2 次重試 = 最多 3 次開站
    expect(page.calls.goto).toBe(3);
  });

  test("帳密錯：終局，立刻丟結論而不是空等到逾時", async () => {
    const page = makePage([BAD_PASSWORD]);
    await expect(autoLoginBoot(page)).rejects.toThrow(/帳密錯誤/);
    expect(page.calls.goto).toBe(1);
  });

  test("站台過載／guest 滿：同樣快速失敗並保留 PTT 的原話", async () => {
    const page = makePage([GUEST_FULL]);
    await expect(autoLoginBoot(page)).rejects.toThrow(/過載|guest/);
    expect(page.calls.goto).toBe(1);
  });

  test("沒有帳密就不該走這條（呼叫端要退回 guest 手動登入）", async () => {
    delete process.env.PTT_PASS;
    const page = makePage([MAIN_MENU]);
    await expect(autoLoginBoot(page)).rejects.toThrow(/PTT_USER\/PTT_PASS/);
    expect(page.calls.goto).toBe(0);
  });
});
