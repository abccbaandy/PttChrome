// 「開燈」軌 B 的送鍵序列（App.onLightsRawMode）。
//
// 這一段有兩個「錯了就把使用者彈到別的地方」的硬規則，所以每一條都要守：
//  1. **不可以把 `\3` 兩個 byte 一次送出**：pttbbs 的 typeahead 會把中間那一幀吞掉
//     （docs/pttbbs-screen-protocol.md §2）。第一步用 CommandQueue 送 `\`，以**畫面
//     內容**（色彩顯示方式選項列出現）判定完成。
//  2. **第一步沒成功就絕不送數字鍵**：`3` 落回文章按鍵是 pmore 的「跳至第 3 頁」。
//
// 第二步刻意不再排一條 queue 命令（會擋掉 easy_reading 的 reenterFromTop）——
// 理由寫在 pttchrome.jsx#onLightsRawMode 的註解裡，這裡守「第二步是直接 view._send」。
import { App } from "../../src/js/pttchrome";
import { CommandQueue } from "../../src/js/command_queue";
import { MFDISP_RAW_PLAIN } from "../../src/js/pmore_pref";

const PREF_OPTION_ROW =
  " \\ 色彩顯示方式:         1*預設格式化內容 |2 原始ANSI控制碼 |3 純文字           ";
const ARTICLE_STATUS_ROW =
  "  瀏覽 第 1/1 頁 (100%)  目前顯示: 第 01~20 行  (y)回應(X%)推文(h)說明(←)離開  ";

function makeApp(opts = {}) {
  const sent = []; // queue 送出的（＝第一步）
  const viewSent = []; // view._send 送出的（＝第二步）
  const hints = [];
  const app = Object.create(App.prototype);
  app.modalShown = !!opts.modalShown;
  app.aidNavigation = { active: !!opts.aidActive };
  app.longPush = { active: false };
  app.easyReading = {
    _rawMode: null,
    enterCalls: 0,
    _enterFunctionMode() {
      this.enterCalls++;
    },
  };
  app.buf = { startedEasyReading: true };
  app.view = {
    useEasyReadingMode: true,
    _send: (d) => viewSent.push(d),
    flashListHint: (m) => hints.push(m),
  };
  app.commandQueue = new CommandQueue({ send: (d) => sent.push(d) });
  return { app, sent, viewSent, hints };
}

// 一次 settle：把 24 列文字餵給 queue 的 expect（形狀同 list_session._collectFacts）。
const settle = (h, rows) =>
  h.app.commandQueue.onSettle(null, {
    rowTexts: Object.assign(new Array(24).fill(""), rows),
  });

describe("App.onLightsRawMode", () => {
  test("第一步只送 `\\`，數字鍵一個都還沒出去", () => {
    const h = makeApp();
    h.app.onLightsRawMode(MFDISP_RAW_PLAIN);
    expect(h.sent).toEqual(["\\"]);
    expect(h.viewSent).toEqual([]);
  });

  test("送鍵前先進原生鏡像（否則設定頁畫在 24 列上、好讀長頁看不到它）", () => {
    const h = makeApp();
    h.app.onLightsRawMode(MFDISP_RAW_PLAIN);
    expect(h.app.easyReading.enterCalls).toBe(1);
  });

  test("設定頁出現後才送 `3`，並記下目標模式（直選時 pmore 不重畫選項列）", () => {
    const h = makeApp();
    h.app.onLightsRawMode(MFDISP_RAW_PLAIN);
    expect(settle(h, { 22: PREF_OPTION_ROW })).toBe("done");
    expect(h.viewSent).toEqual(["3"]);
    expect(h.app.easyReading._rawMode).toBe(MFDISP_RAW_PLAIN);
    // 第二步刻意不是 queue 命令：線路必須在文章回來那一幀之前就空出來，
    // 否則 easy_reading._send 的 _wireBusy 閘門會吃掉 reenterFromTop 的 Home。
    expect(h.app.commandQueue.inFlightKind).toBe(null);
  });

  test("關燈 → 送 `1`（回預設格式化）", () => {
    const h = makeApp();
    h.app.onLightsRawMode(0);
    settle(h, { 22: PREF_OPTION_ROW });
    expect(h.viewSent).toEqual(["1"]);
    expect(h.app.easyReading._rawMode).toBe(0);
  });

  test("一般文章畫面不算完成 → 絕不送數字鍵", () => {
    const h = makeApp();
    h.app.onLightsRawMode(MFDISP_RAW_PLAIN);
    expect(settle(h, { 23: ARTICLE_STATUS_ROW })).toBe(null);
    expect(h.viewSent).toEqual([]);
    expect(h.app.easyReading._rawMode).toBe(null);
  });

  test("第一步失敗（probe 之後仍不是設定頁）→ 提示，且不送數字鍵", () => {
    const h = makeApp();
    h.app.onLightsRawMode(MFDISP_RAW_PLAIN);
    // 逾時 → 送 \f 探針 → 探針的完整幀仍不是設定頁 ⇒ miss。
    h.app.commandQueue._inFlight._probed = true;
    expect(settle(h, { 23: ARTICLE_STATUS_ROW })).toBe("miss");
    expect(h.viewSent).toEqual([]);
    expect(h.hints.length).toBe(1);
  });

  test("有序列化操作在飛（AID 跳文）→ 吞掉並提示，一個 byte 都不送", () => {
    const h = makeApp({ aidActive: true });
    h.app.onLightsRawMode(MFDISP_RAW_PLAIN);
    expect(h.sent).toEqual([]);
    expect(h.hints.length).toBe(1);
  });

  test("對話框開著 → 什麼都不做（不提示、不送）", () => {
    const h = makeApp({ modalShown: true });
    h.app.onLightsRawMode(MFDISP_RAW_PLAIN);
    expect(h.sent).toEqual([]);
    expect(h.hints).toEqual([]);
  });

  test("佇列上已有別人的命令 → 吞掉並提示", () => {
    const h = makeApp();
    h.app.commandQueue.enqueue({
      keys: "x",
      kind: "other",
      expect: () => false,
    });
    h.sent.length = 0;
    h.app.onLightsRawMode(MFDISP_RAW_PLAIN);
    expect(h.sent).toEqual([]);
    expect(h.hints.length).toBe(1);
  });

  test("不認得的模式 → no-op", () => {
    const h = makeApp();
    h.app.onLightsRawMode(9);
    expect(h.sent).toEqual([]);
  });
});
