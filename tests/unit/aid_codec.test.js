// AIDc ⇄ 檔名 codec 的回歸守護。
//
// 定點對照的兩組值都是**獨立來源**、非本實作自產：
//   M.1786458180.A.4FE ⇄ 1gUp14J-
//     來自 PTT SYSOP 板該篇說明文，站方頁面上同時印出檔名與短碼。
//   M.1786265274.A.5E3 ⇄ 1gU3wwNZ（Browsers 板）
//     檔名端來自使用者提供的 ptt.cc 文章網址；短碼端是 2026-08 使用者回報
//     deep link 時就存在於本 repo 的樣本（見 tests/unit/aid_parse.test.js:169
//     的 #Browsers/1gU3wwNZ）。兩端各自獨立，對得上才算真的驗證過。
//
// 演算法出處逐條列在 src/js/aid_codec.js 的檔頭（pttbbs mbbsd/aids.c）。

import {
  fnToAid,
  aidToFn,
  isAidc,
  parseArticleUrl,
  BOARD_RE
} from "../../src/js/aid_codec";

const PAIRS = [
  ["M.1786458180.A.4FE", "1gUp14J-"],
  ["M.1786265274.A.5E3", "1gU3wwNZ"]
];

describe("fnToAid / aidToFn 定點對照", () => {
  test.each(PAIRS)("%s → %s", (fn, aid) => {
    expect(fnToAid(fn)).toBe(aid);
  });

  test.each(PAIRS)("%s ← %s", (fn, aid) => {
    expect(aidToFn(aid)).toBe(fn);
  });

  test("產出的 AIDc 恆為 8 字（aidu2aidc 的 buf 就是 8 格）", () => {
    for (const [fn] of PAIRS) expect(fnToAid(fn)).toHaveLength(8);
    // 極小值也要補滿，不能變成短字串。
    expect(fnToAid("M.1.A.001")).toHaveLength(8);
  });
});

describe("fnToAid 的輸入寬容度", () => {
  test("尾巴帶 .html（直接餵網址尾段）", () => {
    expect(fnToAid("M.1786265274.A.5E3.html")).toBe("1gU3wwNZ");
    expect(fnToAid("M.1786265274.A.5E3.HTML")).toBe("1gU3wwNZ");
  });

  test("hex 小寫也吃（手打的連結不該因此失效）", () => {
    expect(fnToAid("M.1786265274.A.5e3")).toBe("1gU3wwNZ");
  });

  test("舊檔名沒有 .A 之後那段 ⇒ v2 視為 0，往返後補成 .000", () => {
    // pttbbs/docs/aids.txt:49 的 regex 把第三段標成 optional。
    const aid = fnToAid("M.123.A");
    expect(aid).not.toBeNull();
    expect(aidToFn(aid)).toBe("M.123.A.000");
  });

  test("G（精華區）前綴會被保留", () => {
    const aid = fnToAid("G.1786265274.A.5E3");
    expect(aid).not.toBeNull();
    expect(aidToFn(aid)).toBe("G.1786265274.A.5E3");
  });
});

describe("fnToAid / aidToFn 拒收非法輸入", () => {
  test.each([
    ["缺 .A 段", "M.1786265274.5E3"],
    ["type 不是 M/G", "X.1786265274.A.5E3"],
    ["hex 四位", "M.1786265274.A.5E3F"],
    ["hex 非十六進位", "M.1786265274.A.5G3"],
    ["時間戳超出 32-bit", "M.9999999999.A.5E3"],
    ["空字串", ""],
    ["非字串", null]
  ])("fnToAid 拒收：%s", (_label, input) => {
    expect(fnToAid(input)).toBeNull();
  });

  test.each([
    ["9 字", "1gU3wwNZa"],
    ["7 字", "1gU3wwN"],
    ["含非法字元", "1gU3ww.Z"],
    ["空字串", ""],
    ["非字串", null]
  ])("aidToFn 拒收：%s", (_label, input) => {
    expect(aidToFn(input)).toBeNull();
  });

  test("isAidc 與 aidToFn 對「什麼是合法 AIDc」看法一致", () => {
    expect(isAidc("1gU3wwNZ")).toBe(true);
    expect(isAidc("1gU3wwNZa")).toBe(false);
    expect(isAidc(null)).toBe(false);
  });
});

describe("往返一致性（round trip）", () => {
  test("時間戳 × v2 的組合都能原樣還原", () => {
    const stamps = [0, 1, 999999999, 1786265274, 2147483647, 4294967295];
    const v2s = [0, 1, 0x50d, 0xfff];
    for (const t of stamps) {
      for (const v of v2s) {
        const hex = v.toString(16).toUpperCase().padStart(3, "0");
        const fn = "M." + t + ".A." + hex;
        const aid = fnToAid(fn);
        expect(aid).toHaveLength(8);
        expect(aidToFn(aid)).toBe(fn);
      }
    }
  });

  test("每一個 AIDc 字元都對應得回去（涵蓋 '-' 與 '_'）", () => {
    // 表尾的 '-'(62)/'_'(63) 是最容易在自製 base64 實作裡漏掉的兩格。
    expect(aidToFn("1gUp14J-")).toBe("M.1786458180.A.4FE");
    const withUnderscore = fnToAid("M.4294967295.A.FFF");
    expect(aidToFn(withUnderscore)).toBe("M.4294967295.A.FFF");
  });
});

describe("parseArticleUrl", () => {
  test("標準文章網址", () => {
    expect(
      parseArticleUrl("https://www.ptt.cc/bbs/Browsers/M.1786265274.A.5E3.html")
    ).toEqual({ board: "Browsers", aid: "1gU3wwNZ" });
  });

  test("裸網域與 http 也吃", () => {
    expect(
      parseArticleUrl("http://ptt.cc/bbs/SYSOP/M.1786458180.A.4FE.html")
    ).toEqual({ board: "SYSOP", aid: "1gUp14J-" });
  });

  test("USE_AID_URL 形式：尾段直接是 AIDc、沒有 .html", () => {
    expect(parseArticleUrl("https://www.ptt.cc/bbs/SYSOP/1gUp14J-")).toEqual({
      board: "SYSOP",
      aid: "1gUp14J-"
    });
  });

  test("尾端斜線不影響", () => {
    expect(
      parseArticleUrl("https://www.ptt.cc/bbs/SYSOP/M.1786458180.A.4FE.html/")
    ).toEqual({ board: "SYSOP", aid: "1gUp14J-" });
  });

  test.each([
    ["別的站台", "https://evil.example/bbs/SYSOP/M.1786458180.A.4FE.html"],
    ["看起來像但不是 ptt.cc", "https://notptt.cc/bbs/SYSOP/M.1786458180.A.4FE.html"],
    ["不是 /bbs/ 路徑", "https://www.ptt.cc/man/SYSOP/M.1786458180.A.4FE.html"],
    ["看板名非法（含空白）", "https://www.ptt.cc/bbs/a%20b/M.1786458180.A.4FE.html"],
    ["尾段不是檔名也不是 AIDc", "https://www.ptt.cc/bbs/SYSOP/index.html"],
    ["看板列表頁", "https://www.ptt.cc/bbs/SYSOP/index.html?x=1"],
    ["不是網址", "M.1786458180.A.4FE"],
    ["非字串", null]
  ])("拒收：%s", (_label, input) => {
    expect(parseArticleUrl(input)).toBeNull();
  });
});

describe("BOARD_RE（與 deep_link.js 共用同一份）", () => {
  test("合法板名", () => {
    for (const b of ["Gossiping", "C_Chat", "Browsers", "ALLPOST", "b-b"])
      expect(BOARD_RE.test(b)).toBe(true);
  });

  test("送進 `s<board>\\r` 前必須擋掉的東西", () => {
    for (const b of ["", "a", "-abc", "a b", "a\rb", "a/b"])
      expect(BOARD_RE.test(b)).toBe(false);
  });
});
