// PTT DDoS/BOT 封鎖的偵測與閂鎖（2026-08-25 實錄，見 tests/e2e/README.md）。
//
// 這是唯一一種「重試會讓情況變糟」的登入失敗：每多試一次就多延長一次封鎖。所以行為
// 契約有三條，全部在這裡守：
//   1. 兩種實錄句型都認得出來，而且優先權高於其他登入分支（畫面裡也有「登入」字樣）；
//   2. 判到就 fail，**不重連、不退避重試**（對比 throttled 是 reconnect）；
//   3. 結論訊息必須明講「不要重跑」，否則下一個 session 會照本能重跑。
// 閂鎖的檔案 I/O 另外測：它必須跨 worker（Playwright 在 test 失敗後會重啟 worker，
// 模組變數會歸零）。
import fs from "fs";
import {
  isBotBlockScreen,
  describeBotBlock,
  markBotBlocked,
  readBotBlock,
  clearBotBlock,
  assertNotBotBlocked,
  MARKER,
} from "../e2e/helpers/bot_block";
import {
  classifyLoginScreen,
  createLoginState,
  decideLoginAction,
} from "../e2e/helpers/login_flow";

// 實錄的兩種句型（帳號遮成 ***，這是公開 repo）。
const BLOCKED_A =
  "[PTT DDoS/BOT 偵測系統] 偵測到連線異常/不當連續登入行為！\n帳號 *** 已被暫時禁止登入。";
const BLOCKED_B =
  "[PTT DDoS/BOT 偵測系統] 帳號 *** 有疑似不當連續登入行為所以暫停連線。";

describe("isBotBlockScreen", () => {
  test.each([
    [BLOCKED_A, true],
    [BLOCKED_B, true],
    ["請輸入代號，或以 guest 參觀，或以 new 註冊: ", false],
    ["登入太頻繁, 為避免系統負荷過重, 請稍後再試", false], // 這是 throttled，處置完全不同
    ["【主功能表】", false],
    ["", false],
  ])("%s", (screen, expected) => {
    expect(isBotBlockScreen(screen)).toBe(expected);
  });
});

describe("classifyLoginScreen：bot-blocked 的優先權", () => {
  test.each([
    [BLOCKED_A, "bot-blocked"],
    [BLOCKED_B, "bot-blocked"],
  ])("%s → %s", (screen, phase) => {
    expect(classifyLoginScreen(screen)).toBe(phase);
  });

  test("封鎖頁含「登入」字樣，不可被 throttled/bad-credentials 之類的分支吃掉", () => {
    expect(classifyLoginScreen(BLOCKED_A + "\n登入太頻繁, 請稍後再試")).toBe(
      "bot-blocked"
    );
  });
});

describe("decideLoginAction：被封鎖時只能停手", () => {
  const decide = (screen) =>
    decideLoginAction({
      screen,
      connected: true,
      now: 1000,
      state: createLoginState({ user: "***", now: 1000 }),
    });

  test("action 是 fail，不是 reconnect（重試＝延長封鎖）", () => {
    const d = decide(BLOCKED_A);
    expect(d.phase).toBe("bot-blocked");
    expect(d.action).toBe("fail");
  });

  test("對照組：登入節流仍然是 reconnect 退避重試（兩者不可混為一談）", () => {
    expect(decide("登入太頻繁, 為避免系統負荷過重, 請稍後再試").action).toBe(
      "reconnect"
    );
  });

  test("訊息明講不要重跑，並指出非本專案 code 問題", () => {
    const { message } = decide(BLOCKED_B);
    expect(message).toContain("不要重跑");
    expect(message).toContain("非本專案 code 問題");
    expect(message).toContain("--- 當前畫面 ---");
  });
});

describe("describeBotBlock", () => {
  test("沒有畫面時不吐空的畫面區塊", () => {
    expect(describeBotBlock("")).not.toContain("--- 當前畫面 ---");
  });
});

describe("閂鎖（跨 worker：寫檔）", () => {
  const wasMarked = (() => {
    try {
      return fs.readFileSync(MARKER, "utf8");
    } catch (e) {
      return null;
    }
  })();
  afterEach(() => clearBotBlock());
  afterAll(() => {
    if (wasMarked != null) markBotBlocked(wasMarked);
  });

  test("沒立閂鎖時 assertNotBotBlocked 放行", () => {
    clearBotBlock();
    expect(readBotBlock()).toBeNull();
    expect(() => assertNotBotBlocked()).not.toThrow();
  });

  test("立了閂鎖之後直接丟，且結論帶得出去", () => {
    markBotBlocked(describeBotBlock(BLOCKED_A));
    expect(() => assertNotBotBlocked()).toThrow(/不要重跑/);
  });

  test("clearBotBlock 可重複呼叫（globalSetup 每輪無條件跑）", () => {
    clearBotBlock();
    expect(() => clearBotBlock()).not.toThrow();
    expect(readBotBlock()).toBeNull();
  });
});
