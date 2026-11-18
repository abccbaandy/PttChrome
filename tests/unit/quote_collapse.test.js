// P106 好讀文章把長引言收起來：純邏輯層（src/js/quote_collapse.js）。
// 引言格式照 pttbbs mbbsd/edit.c 回文引用（每行加「: 」、遇「--」停、多層＝「: : 」）。
import {
  QUOTE_COLLAPSE_MIN,
  QUOTE_KEEP,
  applyQuoteCollapse,
  findQuoteRuns,
  isQuoteLine,
  quoteRunKeys,
} from "../../src/js/quote_collapse";

const quote = (n, prefix = ": ") => Array.from({ length: n }, (_, i) => prefix + "原文第 " + (i + 1) + " 行");

describe("isQuoteLine", () => {
  test.each([
    [": 原文", true],
    [": : 兩層引言", true],
    [":", true], // 原文空行被引成「: 」，畫面去掉行尾空白
    [": ", true],
    [":)", false],
    [":D 好好笑", false],
    ["推 abc: 推文", false],
    [" : 前面有空白", false],
    ["", false],
    [null, false],
  ])("%j ⇒ %s", (text, want) => {
    expect(isQuoteLine(text)).toBe(want);
  });
});

describe("findQuoteRuns", () => {
  test("連續 5 行以上才算；4 行不算", () => {
    expect(QUOTE_COLLAPSE_MIN).toBe(5);
    expect(findQuoteRuns(["※ 引述《a》之銘言：", ...quote(4), "回文"])).toEqual([]);
    expect(findQuoteRuns(["※ 引述《a》之銘言：", ...quote(5), "回文"])).toEqual([{ start: 1, end: 6 }]);
  });

  test("夾一行回文就斷開重算：引言1／回文1／引言2／回文2 每段各自算", () => {
    const texts = [...quote(3), "回文一", ...quote(6), "回文二", ": 單行"];
    expect(findQuoteRuns(texts)).toEqual([{ start: 4, end: 10 }]);
  });

  test("多層引言跟一層的連在一起算；引言裡的空行（「:」）不斷開", () => {
    const texts = [": 一層", ": : 兩層", ":", ": : : 三層", ": 一層"];
    expect(findQuoteRuns(texts)).toEqual([{ start: 0, end: 5 }]);
  });

  test("文末那段（後面沒有回文）也算", () => {
    expect(findQuoteRuns(["回文", ...quote(7)])).toEqual([{ start: 1, end: 8 }]);
  });
});

describe("quoteRunKeys", () => {
  test("同一段首文字出現兩次 ⇒ 兩個不同 key；不同段首互不影響", () => {
    const texts = [...quote(5), "回文", ...quote(5), "回文", ...quote(5, ": : ")];
    const runs = findQuoteRuns(texts);
    expect(runs.length).toBe(3);
    const keys = quoteRunKeys(texts, runs);
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe("applyQuoteCollapse", () => {
  const TEXTS = ["※ 引述《a》之銘言：", ...quote(7), "回文"];
  const KEY = () => quoteRunKeys(TEXTS, findQuoteRuns(TEXTS))[0];

  test("收起：留前 2 行，第 2 行標收起幾行與 key，其餘 hidden", () => {
    const result = new Array(TEXTS.length);
    applyQuoteCollapse(result, null, TEXTS);
    expect(QUOTE_KEEP).toBe(2);
    expect(result[1]).toBeUndefined();
    expect(result[2]).toEqual({ quoteKey: KEY(), quoteSkip: 5 });
    for (let r = 3; r <= 7; ++r) expect(result[r]).toEqual({ hidden: true, quoteHidden: true });
    expect(result[8]).toBeUndefined();
  });

  test("剛好 5 行 ⇒ 收起 3 行", () => {
    const texts = ["回文", ...quote(5), "回文"];
    const result = new Array(texts.length);
    applyQuoteCollapse(result, null, texts);
    expect(result[2].quoteSkip).toBe(3);
    expect(result.filter((a) => a && a.quoteHidden).length).toBe(3);
  });

  test("展開（key 在 expanded 裡）：都不藏，第 2 行改標 quoteExpanded", () => {
    const result = new Array(TEXTS.length);
    applyQuoteCollapse(result, [KEY()], TEXTS);
    expect(result[2]).toEqual({ quoteKey: KEY(), quoteExpanded: 5 });
    for (let r = 3; r <= 7; ++r) expect(result[r]).toBeUndefined();
  });

  test("key 對不上（例如舊格式的段首文字）⇒ 照樣收起", () => {
    const result = new Array(TEXTS.length);
    applyQuoteCollapse(result, [TEXTS[1]], TEXTS);
    expect(result[2].quoteSkip).toBe(5);
  });

  test("同段首文字的兩段各自展開", () => {
    const texts = [...quote(5), "回文", ...quote(5), "回文"];
    const keys = quoteRunKeys(texts, findQuoteRuns(texts));
    const result = new Array(texts.length);
    applyQuoteCollapse(result, [keys[1]], texts);
    expect(result[1].quoteSkip).toBe(3);
    expect(result[2].hidden).toBe(true);
    expect(result[7].quoteExpanded).toBe(3);
    expect(result[8]).toBeUndefined();
  });

  test("原本有的標註保留；展開時只拿掉自己加的 hidden", () => {
    const result = new Array(TEXTS.length);
    result[4] = { floor: 3 };
    applyQuoteCollapse(result, null, TEXTS);
    expect(result[4]).toEqual({ floor: 3, hidden: true, quoteHidden: true });
    applyQuoteCollapse(result, [KEY()], TEXTS);
    expect(result[4]).toEqual({ floor: 3 });
  });

  test("別的功能已經藏起來的列不動：不掛 quoteHidden，展開後仍藏著", () => {
    const result = new Array(TEXTS.length);
    const other = { hidden: true, commentFilterHidden: true };
    result[5] = other;
    applyQuoteCollapse(result, null, TEXTS);
    expect(result[5]).toBe(other);
    applyQuoteCollapse(result, [KEY()], TEXTS);
    expect(result[5]).toBe(other);
  });

  test("再跑一次內容沒變 ⇒ 同一批物件（前沿快路徑要的穩定前綴）", () => {
    const result = new Array(TEXTS.length);
    applyQuoteCollapse(result, null, TEXTS);
    const before = result.slice();
    applyQuoteCollapse(result, null, TEXTS);
    result.forEach((a, i) => expect(a).toBe(before[i]));
  });

  test("短引言、沒有引言 ⇒ 一列都不動", () => {
    const texts = ["內文", ...quote(4), "回文"];
    const result = new Array(texts.length);
    applyQuoteCollapse(result, null, texts);
    expect(result.every((a) => a === undefined)).toBe(true);
  });
});
