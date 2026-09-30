// 已讀文章低亮（pref dimReadArticles）的已讀判定：comment_parse#isListRowRead。
// 規則出處 pttbbs `mbbsd/bbs.c#readdoent`：type 字元畫在 cell 8（`%7d` + 空白 + type），
// 置底列（"  " + "  ★ "）同樣剛好 7 格。判定按 cell 讀，不走 rowToText 字串索引。
import { isListRowRead } from "../../src/js/comment_parse";
import { row, seg } from "./helpers/screen_fixtures";

const withType = (type, prefix = " 350024") =>
  row(seg(`${prefix} ${type} 2 6/14 someone      □ [心得] 測試`));

describe("isListRowRead", () => {
  test.each([" ", "m", "s", "*"])("已讀標記 %j ⇒ true", (t) => {
    expect(isListRowRead(withType(t))).toBe(true);
  });

  test.each(["+", "~", "M", "=", "S", "#"])("未讀標記 %j ⇒ false", (t) => {
    expect(isListRowRead(withType(t))).toBe(false);
  });

  test.each(["!", "D"])("蓋掉未讀資訊的標記 %j ⇒ false（不判定、不低亮）", (t) => {
    expect(isListRowRead(withType(t))).toBe(false);
  });

  test("置底列（★）同一格位", () => {
    expect(isListRowRead(withType(" ", "    ★"))).toBe(true);
    expect(isListRowRead(withType("+", "    ★"))).toBe(false);
  });

  test("舊游標 ● 佔 cell 0–1，不影響 cell 8", () => {
    expect(isListRowRead(withType(" ", "●50024"))).toBe(true);
    expect(isListRowRead(withType("+", "●50024"))).toBe(false);
  });

  test("非列表列／空列 ⇒ false", () => {
    expect(isListRowRead(row(seg("")))).toBe(false);
    expect(isListRowRead(row(seg("   編號    日 期 作  者       文  章  標  題")))).toBe(false);
    expect(isListRowRead(null)).toBe(false);
  });
});
