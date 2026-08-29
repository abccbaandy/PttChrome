import { WordSegmentBuilder } from "../../src/render/word_segment";
import { color } from "./helpers/screen_fixtures";

// 二色 DBCS（一個全形字的頭尾兩格屬性不同）的閃爍。
//
// 為什麼會漏：一般色段的閃爍是 WordSegmentBuilder.build() 的 qq{bg} + CSS
// .blink--active；但 ColorState.equals 比的是 fg/bg/**blink** 三欄，所以只要兩格的
// blink 不同（或相同但 fg/bg 不同而其中有閃），ColorSegmentBuilder 就會改走
// appendTwoColorWord ——那條路徑上游從第一天起就完全沒有處理 blink（原地留著一行
// "FIXME: add blinking."），整個字直接不閃。
//
// PTT 真的會送 ESC[5m（mbbsd/ch_dark.c、chicken.c，使用者自己在文章裡打的更不用說），
// 而兩格屬性被切開最常見的成因就是反白游標帶／背景色切換橫過一個全形字。
describe("二色 DBCS 的閃爍", () => {
  const build = (lead, tail) => {
    const b = new WordSegmentBuilder(lead);
    b.appendTwoColorWord("中", lead, tail, 0);
    return b.build().firstChild;
  };
  const cls = (node) => new Set(node.getAttribute("class").split(/\s+/));

  test("兩格都在閃 → 掛上二色專用的閃爍 class", () => {
    const node = build(color(7, 0, true), color(7, 1, true));
    expect(cls(node).has("qq2")).toBe(true);
  });

  test("只有頭那格在閃也要閃（整字一起，見 color.css 的精度邊界說明）", () => {
    const node = build(color(7, 0, true), color(7, 0, false));
    expect(cls(node).has("qq2")).toBe(true);
  });

  test("只有尾那格在閃也要閃", () => {
    const node = build(color(7, 0, false), color(3, 0, true));
    expect(cls(node).has("qq2")).toBe(true);
  });

  test("都沒在閃 → 不掛，既有輸出一個字元都不變", () => {
    const node = build(color(7, 0, false), color(3, 1, false));
    const c = cls(node);
    expect(c.has("qq2")).toBe(false);
    // 既有的二色 class 組合（w=頭色疊在 ::after、q=尾色字身、o=分半、bAbB=背景漸層）
    expect(c).toEqual(new Set(["w7", "q3", "o", "b0b1"]));
  });

  test("閃爍不影響原本的顏色 class 組合", () => {
    const c = cls(build(color(7, 0, true), color(3, 1, true)));
    expect(c).toEqual(new Set(["w7", "q3", "o", "b0b1", "qq2"]));
  });
});
