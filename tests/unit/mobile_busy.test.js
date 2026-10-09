// 手機 App Bar 的等待進度條狀態機（src/js/mobile_busy.js）。docs/mobile.md「等待進度條」。
import {
  busyNext,
  isBusyShown,
  BUSY_IDLE,
  BUSY_ACTION_WINDOW_MS,
  BUSY_SHOW_DELAY_MS,
  BUSY_TIMEOUT_MS,
} from "../../src/js/mobile_busy";

const run = (events) => events.reduce((s, ev) => busyNext(s, ev), BUSY_IDLE);

test("UI 按下 → 真的送出 → 延遲後才顯示 → settle 收起", () => {
  let s = run([{ type: "action", t: 0 }, { type: "sent", t: 10 }]);
  expect(s.phase).toBe("pending");
  expect(isBusyShown(busyNext(s, { type: "tick", t: 10 + BUSY_SHOW_DELAY_MS - 1 }))).toBe(false);
  s = busyNext(s, { type: "tick", t: 10 + BUSY_SHOW_DELAY_MS });
  expect(isBusyShown(s)).toBe(true);
  s = busyNext(s, { type: "settled", t: 500 });
  expect(isBusyShown(s)).toBe(false);
  expect(s.phase).toBe("idle");
});

test("快速回應（顯示延遲內就 settle）＝不閃", () => {
  const s = run([
    { type: "action", t: 0 },
    { type: "sent", t: 5 },
    { type: "settled", t: 80 },
    { type: "tick", t: 5 + BUSY_SHOW_DELAY_MS },
  ]);
  expect(isBusyShown(s)).toBe(false);
});

test("REGRESSION 預防：沒有送出 byte（列表好讀的本地捲動）不亮", () => {
  const s = run([{ type: "action", t: 0 }, { type: "tick", t: BUSY_SHOW_DELAY_MS + 1 }]);
  expect(s.phase).toBe("idle");
});

test("沒有 UI 按下（實體鍵盤／程式化序列）的送出不亮；太久以前的按下也不算", () => {
  expect(run([{ type: "sent", t: 0 }]).phase).toBe("idle");
  expect(
    run([{ type: "action", t: 0 }, { type: "sent", t: BUSY_ACTION_WINDOW_MS + 1 }]).phase,
  ).toBe("idle");
});

test("一次按下只消耗一次：之後的送出不再觸發", () => {
  const s = run([
    { type: "action", t: 0 },
    { type: "sent", t: 1 },
    { type: "settled", t: 50 },
    { type: "sent", t: 60 },
  ]);
  expect(s.phase).toBe("idle");
});

test("PTT 不回應（不認得的鍵）⇒ 逾時自己收", () => {
  let s = run([
    { type: "action", t: 0 },
    { type: "sent", t: 0 },
    { type: "tick", t: BUSY_SHOW_DELAY_MS },
  ]);
  expect(isBusyShown(s)).toBe(true);
  s = busyNext(s, { type: "tick", t: BUSY_TIMEOUT_MS });
  expect(s.phase).toBe("idle");
});
