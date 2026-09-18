// 長推文「放手」時必須主動叫醒好讀的自動翻頁。
//
// REGRESSION（使用者回報 + ptt-debug-20260917-221112）：在文章裡按 X 叫出長推文
// 輸入框，然後**取消**，文章就再也不會往下讀到結尾。
//
// 根因是通知只有單向：
//   - 好讀的自動翻頁被 easy_reading._wireBusy() 擋下時是**延後**不是丟棄
//     （存進 _deferredPageDownKeys），唯一的喚醒點是 EasyReading.onWireIdle()，
//     而它只由 CommandQueue.onIdle 呼叫（pttchrome.jsx 的接線）。
//   - 但 _wireBusy 的三個來源裡，longPush.busy 是**唯一一個 queue 管不到的**：
//     探路成功後 _armed 一直活著（使用者在輸入框打字，線路真的空著），冷卻倒數
//     也一樣。queue 早就空了、onIdle 也早就發過了，busy 卻要等到使用者關框
//     （disarm）才翻 false ⇒ 那一刻沒有任何人再通知好讀。
//   - 沒送鍵就沒有新幀，沒有新幀就不會再評估一次 ⇒ 死結，只能離開文章再進。
//
// 錄製檔裡的指紋：最後三筆 easyReading.pageDown 全是
// {action:"blocked", inFlightKind:null} —— inFlightKind 已經是 null 卻還是被擋，
// 擋人的就是 longPush.busy。
//
// 配對的另一半在 tests/unit/easy_reading_send_gate.test.js（force 補送）。

import { loadBig5Tables } from "./helpers/load_big5_tables";
import {
  harness,
  vmsg,
  PROMPT,
  TYPE_MENU,
  ARTICLE_FOOTER,
  ANCHOR_ROW,
  OTHER_ROW,
} from "./helpers/long_push_harness";

beforeAll(() => loadBig5Tables());

// 探路走完一輪：X → 型別選單 → Ctrl-C ×2 退出 → 落回列表 → ⏎ 回文章。
// 收工時 session 停在 armed（_armed 活著、busy 為 true），就是使用者正在打字的狀態。
function armed(h) {
  h.session.startPreflight({});
  h.settle(TYPE_MENU);
  h.settle(PROMPT);
  h.settleList([ANCHOR_ROW(1234, true), OTHER_ROW(1235)], 0);
  h.settle(ARTICLE_FOOTER);
  return h;
}

describe("busy 翻 false 時要通知好讀", () => {
  test("armed 期間 busy 是 true，好讀的閘門必須關著", () => {
    const h = armed(harness());
    expect(h.session.busy).toBe(true);
    expect(h.session.active).toBe(false); // 線路空著，使用者在打字
    expect(h.wireIdle).toEqual([]); // 還握著畫面，這時候不可以叫醒
  });

  test("REGRESSION：關掉輸入框（disarm）必須叫醒好讀", () => {
    const h = armed(harness());
    h.session.disarm();
    expect(h.session.busy).toBe(false);
    expect(h.wireIdle).toEqual([{ force: true }]);
  });

  test("送出階段失敗收工（_finish）也要叫醒", () => {
    const h = armed(harness());
    h.session.start({ text: "測試內容", type: "push" });
    expect(h.session.busy).toBe(true);
    h.wireIdle.length = 0; // start() 內部那次 disarm 的帳先歸零（見下一條）
    h.settle(vmsg("本文已臻完美, 不需要推文"));
    expect(h.session.busy).toBe(false);
    expect(h.wireIdle).toEqual([{ force: true }]);
  });

  test("探路被擋下來（_preflightFail）也要叫醒", () => {
    const h = harness();
    h.session.startPreflight({});
    h.settle(vmsg("抱歉, 禁止推薦")); // 橫幅 → 送空白消掉
    h.settleList([ANCHOR_ROW(1234, true), OTHER_ROW(1235)], 0);
    h.settle(ARTICLE_FOOTER); // ⏎ 回文章
    expect(h.session.busy).toBe(false);
    expect(h.wireIdle).toEqual([{ force: true }]);
  });

  test("start() 內部的 disarm 不可以叫醒（線路正要交給自己）", () => {
    const h = armed(harness());
    h.wireIdle.length = 0;
    h.session.start({ text: "測試內容", type: "push" });
    // 這一刻 active 已經是 true，busy 仍然是 true ⇒ 放手的守門必須擋下來，
    // 否則好讀會在長推文的鍵序中間插一個 PageDown 進去。
    expect(h.session.busy).toBe(true);
    expect(h.wireIdle).toEqual([]);
  });

  test("core 沒有 easyReading（測試替身／早期 boot）時不得爆炸", () => {
    const h = armed(harness());
    delete h.core.easyReading;
    expect(() => h.session.disarm()).not.toThrow();
  });
});
