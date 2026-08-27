// 合併推文塊換行邊界的共用判準（src/js/comment_break.js）。
// 這裡守的是「url_wrap 與 aid_wrap 共用同一份行為」的那一份本體；兩個消費端各自的
// 整合守護在 tests/unit/url_wrap.test.js / aid_wrap.test.js。
import { toMinutes, withinOneMinute, isDbcsCell } from "../../src/js/comment_break";

describe("toMinutes / withinOneMinute", () => {
  test("同一分鐘 → 接", () => {
    expect(withinOneMinute("08/26 22:17", "08/26 22:17")).toBe(true);
  });

  test("差 1 分（跨過整分）→ 接", () => {
    expect(withinOneMinute("08/26 22:17", "08/26 22:18")).toBe(true);
  });

  test("差 2 分 → 不接", () => {
    expect(withinOneMinute("08/26 22:17", "08/26 22:19")).toBe(false);
  });

  test("跨小時仍算得出來", () => {
    expect(withinOneMinute("08/26 22:59", "08/26 23:00")).toBe(true);
    expect(withinOneMinute("08/26 22:58", "08/26 23:00")).toBe(false);
  });

  test("月份 1 位數也吃（PTT 印成 8/26 或 08/26 都有）", () => {
    expect(toMinutes("8/26 22:17")).toBe(toMinutes("08/26 22:17"));
  });

  test("格式不符 / 缺值 → null，withinOneMinute 一律 false", () => {
    expect(toMinutes("22:17")).toBeNull();
    expect(toMinutes(null)).toBeNull();
    expect(withinOneMinute(null, "08/26 22:17")).toBe(false);
    expect(withinOneMinute("08/26 22:17", undefined)).toBe(false);
  });

  // 月長一律當 31 天：短月月底跨日會多算 ⇒ 判成不接，方向安全（不會誤接）。
  test("短月月底跨日只會判成不接，不會誤接", () => {
    expect(withinOneMinute("02/28 23:59", "03/01 00:00")).toBe(false);
  });
});

describe("isDbcsCell", () => {
  const lead = { ch: "\xa4", isLeadByte: true };
  const trail = { ch: "@" }; // trail byte 剛好是合法 URL／AID 字元
  const plain = { ch: "a" };

  test("lead byte / trail byte 都算 DBCS 的一半", () => {
    const chars = [plain, lead, trail, plain];
    expect(isDbcsCell(chars, 0)).toBe(false);
    expect(isDbcsCell(chars, 1)).toBe(true);
    expect(isDbcsCell(chars, 2)).toBe(true); // 只看 ch 會誤判成合法 '@'
    expect(isDbcsCell(chars, 3)).toBe(false);
  });

  test("越界一律當 true（不可用）", () => {
    expect(isDbcsCell([plain], 5)).toBe(true);
    expect(isDbcsCell([plain], -1)).toBe(true);
  });
});
