// PTT 官方推文實況（文章裡按 v，more.c#live_run）的純邏輯：狀態列、橫幅、好讀累積的對齊。
// 畫面形狀照 upstream 產的 fixture（tests/unit/fixtures/ptt_src_screens/live_*.json，
// ptt_src_screens.test.js 用真位元組再驗一次）。
import {
  parseLiveStatusRow,
  isLiveStatusRow,
  isLiveBannerRow,
  findLiveBanner,
  mergeLiveArticle,
  mergeLiveWindow,
  liveKeyMirrors,
  LIVE_BANNER_TEXT,
} from "../../src/js/live_mode";

const R = 23; // 24 列畫面扣掉狀態列
const BANNER = " ".repeat(34) + LIVE_BANNER_TEXT + " ".repeat(35);
const STATUS =
  " 實況中 01:05 [+2]  (X)留言 (B)鈴聲[關閉] (T/M/S)調時 (q)離開      09/27 09:06 ";
const pad = (rows) => rows.concat(new Array(Math.max(0, R - rows.length)).fill(""));
const c = (i) => `推 bob:comment ${i}                                     09/27 09:06`;
const body = (from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => `長文第 ${from + i} 行`);

describe("實況狀態列", () => {
  test("490ceaf 版：時間、則數、能不能留言、鈴聲", () => {
    expect(parseLiveStatusRow(STATUS)).toEqual({
      elapsedSec: 65,
      received: 2,
      canComment: true,
      bell: false,
    });
    expect(parseLiveStatusRow(STATUS.replace("[關閉]", "[打開]")).bell).toBe(true);
  });

  test("844e8d0 版（任意鍵離開）也認得；沒有留言權就沒有 (X)", () => {
    const old = " 實況中 00:00 [+0]  (B)鈴聲[關閉] (T/M/S)調時 (任意鍵)離開   09/27 09:06 ";
    expect(parseLiveStatusRow(old)).toMatchObject({ received: 0, canComment: false });
  });

  test("pmore 狀態列、3c7d9af 舊版「實況 第 x 頁」、空列都不是", () => {
    expect(isLiveStatusRow("  瀏覽 第 1/3 頁 ( 50%)  目前顯示: 第 01~22 行 (y)回應")).toBe(false);
    expect(isLiveStatusRow("  實況 第 1/1 頁 (100%)  目前顯示: 第 01~07 行")).toBe(false);
    expect(isLiveStatusRow("")).toBe(false);
    expect(isLiveStatusRow(null)).toBe(false);
  });
});

describe("橫幅", () => {
  test("整列只有「實 況 開 始」才算", () => {
    expect(isLiveBannerRow(BANNER)).toBe(true);
    expect(isLiveBannerRow("推 bob: 實 況 開 始")).toBe(false);
    expect(findLiveBanner(pad(["a", "b", BANNER, c(1)]))).toBe(2);
    expect(findLiveBanner(pad(["a"]))).toBe(-1);
  });
});

describe("進實況那一幀：文章段接到累積頁", () => {
  test("長文讀完整篇：最後一頁整段都在累積頁裡 ⇒ 一列文章都不補，只接橫幅以下", () => {
    const acc = ["作者", "標題", "時間", "───", ""].concat(body(1, 40));
    const screen = body(19, 40).concat([BANNER]);
    expect(mergeLiveArticle({ accTexts: acc, screenTexts: screen })).toEqual({
      keep: acc.length,
      articleFrom: 22,
      articleTo: 22,
      liveFrom: 22,
      liveTo: 23,
    });
  });

  test("單頁短文：累積頁是整個畫面（含空白填充列）⇒ 去掉填充列再接", () => {
    const head = ["作者", "標題", "時間", "───", "", "body"];
    const acc = pad(head);
    const screen = pad(head.concat([BANNER, c(1)]));
    expect(mergeLiveArticle({ accTexts: acc, screenTexts: screen })).toEqual({
      keep: 6,
      articleFrom: 6,
      articleTo: 6,
      liveFrom: 6,
      liveTo: 8,
    });
  });

  test("累積頁少了文章尾巴（還沒讀到底）但對得上 ⇒ 補上沒讀到的那幾列", () => {
    const acc = body(1, 30);
    const screen = body(19, 40).concat([BANNER]);
    const m = mergeLiveArticle({ accTexts: acc, screenTexts: screen });
    expect(m.keep).toBe(30);
    expect(m.articleFrom).toBe(12); // 19..30 已有，從 31 起補
    expect(screen[m.articleFrom]).toBe("長文第 31 行");
  });

  test("對不上（中間有一段沒讀到）⇒ 不接管", () => {
    const acc = body(1, 10);
    const screen = body(19, 40).concat([BANNER]);
    expect(mergeLiveArticle({ accTexts: acc, screenTexts: screen })).toBeNull();
  });

  test("只對上一兩列的巧合不算", () => {
    const acc = ["x", "y", "--"];
    const screen = ["--", "別篇第 2 行", "別篇第 3 行", BANNER];
    expect(mergeLiveArticle({ accTexts: acc, screenTexts: screen })).toBeNull();
  });

  test("看不到橫幅 ⇒ 不接管", () => {
    expect(mergeLiveArticle({ accTexts: ["a"], screenTexts: pad(["a"]) })).toBeNull();
  });
});

describe("之後每一幀：實況段", () => {
  test("橫幅還在畫面上 ⇒ 橫幅以下就是整段，只接新的", () => {
    const live = [BANNER, c(1)];
    const screen = pad(body(1, 5).concat([BANNER, c(1), c(2)]));
    expect(mergeLiveWindow({ liveTexts: live, screenTexts: screen, receivedDelta: 1 })).toEqual({
      action: "append",
      from: 7,
      to: 8,
    });
    expect(
      mergeLiveWindow({ liveTexts: [BANNER, c(1), c(2)], screenTexts: screen, receivedDelta: 0 })
    ).toEqual({ action: "none" });
  });

  test("橫幅還在但內容對不上 ⇒ 整段換掉", () => {
    const screen = pad(["x", BANNER, c(9)]);
    expect(
      mergeLiveWindow({ liveTexts: [BANNER, c(1)], screenTexts: screen, receivedDelta: 0 })
    ).toEqual({ action: "replace", from: 1, to: 3 });
  });

  test("畫面已滿、上捲一列（橫幅還在第 0 列）", () => {
    // 上一幀：文章 21 列 + 橫幅 + 1 則
    const live = [BANNER, c(1)];
    const screen = body(20, 40).concat([BANNER, c(1)]).slice(1).concat([c(2)]);
    expect(screen).toHaveLength(R);
    expect(mergeLiveWindow({ liveTexts: live, screenTexts: screen, receivedDelta: 1 })).toEqual({
      action: "append",
      from: R - 1,
      to: R,
    });
  });

  test("橫幅捲走之後照上捲列數對齊", () => {
    const live = [BANNER].concat(Array.from({ length: 30 }, (_, i) => c(i + 1)));
    const screen = live.slice(-R + 2).concat([c(31), c(32)]);
    expect(mergeLiveWindow({ liveTexts: live, screenTexts: screen, receivedDelta: 2 })).toEqual({
      action: "append",
      from: R - 2,
      to: R,
    });
    // 沒有新推文（每秒重畫時間）⇒ 什麼都不接
    const same = live.slice(-R);
    expect(mergeLiveWindow({ liveTexts: live, screenTexts: same, receivedDelta: 0 })).toEqual({
      action: "none",
    });
  });

  test("同一句推文連刷：好幾種上捲列數都對得上時，取不小於 [+N] 增量的那個", () => {
    const same = "推 a: +1                                                      09/27 09:06";
    const live = [BANNER].concat(new Array(30).fill(same));
    const screen = new Array(R).fill(same);
    // d=0 也對得上（畫面沒變的樣子），但狀態列說多了 1 則 ⇒ 接 1 列。
    expect(mergeLiveWindow({ liveTexts: live, screenTexts: screen, receivedDelta: 1 })).toEqual({
      action: "append",
      from: R - 1,
      to: R,
    });
    expect(mergeLiveWindow({ liveTexts: live, screenTexts: screen, receivedDelta: 0 })).toEqual({
      action: "none",
    });
  });

  test("一次湧進超過一個畫面、對不上 ⇒ 整個畫面當新列接上", () => {
    const live = [BANNER].concat(Array.from({ length: 30 }, (_, i) => c(i + 1)));
    const screen = Array.from({ length: R }, (_, i) => c(100 + i));
    expect(mergeLiveWindow({ liveTexts: live, screenTexts: screen, receivedDelta: 40 })).toEqual({
      action: "resync",
      from: 0,
      to: R,
    });
  });
});

describe("實況中的按鍵", () => {
  test("留言（X／x／%）與離開（q）先切原生鏡像，其他直接送", () => {
    for (const k of ["X", "x", "%", "q", "Q"]) expect(liveKeyMirrors(k)).toBe(true);
    for (const k of ["B", "b", "T", "t", "M", "m", "S", "s", "v", "a"])
      expect(liveKeyMirrors(k)).toBe(false);
  });
});
