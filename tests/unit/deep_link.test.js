// Unit tests for src/js/deep_link.js — the 外部連結 → 文章 的 URL 合約。
// 這組 test 就是格式的規格書：正規形式 #<Board>/<AID>，另外相容 key=value 的
// hash 與 query。任何「看起來像但不合法」的東西都必須回 null（＝照常開站），
// 因為那個字串會被原樣送進 `s<board>\r` / `#<aid>\r`。

import { parseDeepLink, buildDeepLink, stripDeepLink } from "../../src/js/deep_link";

const BASE = "https://example.github.io/pttchrome/";
const AID = "1gIeu-3A";

describe("parseDeepLink — 正規形式 #<Board>/<AID>", () => {
  test("basic", () => {
    expect(parseDeepLink(BASE + "#Gossiping/" + AID)).toEqual({
      board: "Gossiping",
      aid: AID
    });
  });

  test("前導斜線也吃", () => {
    expect(parseDeepLink(BASE + "#/C_Chat/" + AID)).toEqual({
      board: "C_Chat",
      aid: AID
    });
  });

  test("尾端斜線也吃", () => {
    expect(parseDeepLink(BASE + "#movie/" + AID + "/")).toEqual({
      board: "movie",
      aid: AID
    });
  });

  test("板名大小寫原樣保留（PTT 自己不分大小寫，但不該由我們改寫）", () => {
    expect(parseDeepLink(BASE + "#gossiping/" + AID).board).toBe("gossiping");
  });

  test("percent-encoded 也解得開", () => {
    expect(parseDeepLink(BASE + "#%43_Chat/" + AID)).toEqual({
      board: "C_Chat",
      aid: AID
    });
  });
});

describe("parseDeepLink — 相容形式", () => {
  test("hash key=value", () => {
    expect(parseDeepLink(BASE + "#aid=" + AID + "&board=Gossiping")).toEqual({
      board: "Gossiping",
      aid: AID
    });
  });

  test("hash key=value 順序不拘", () => {
    expect(parseDeepLink(BASE + "#board=Gossiping&aid=" + AID)).toEqual({
      board: "Gossiping",
      aid: AID
    });
  });

  test("query string", () => {
    expect(parseDeepLink(BASE + "?board=Gossiping&aid=" + AID)).toEqual({
      board: "Gossiping",
      aid: AID
    });
  });

  test("hash 勝過 query（正規形式優先）", () => {
    expect(
      parseDeepLink(BASE + "?board=movie&aid=aaaaaaaa#Gossiping/" + AID)
    ).toEqual({ board: "Gossiping", aid: AID });
  });

  test("query 與其他參數並存", () => {
    expect(
      parseDeepLink(BASE + "?site=wstelnet%3A%2F%2Fx%2Fbbs&board=movie&aid=" + AID)
    ).toEqual({ board: "movie", aid: AID });
  });
});

describe("parseDeepLink — 拒絕", () => {
  test("沒有 hash / query", () => {
    expect(parseDeepLink(BASE)).toBeNull();
  });

  test("空 hash", () => {
    expect(parseDeepLink(BASE + "#")).toBeNull();
  });

  test("只有板名，沒有 AID", () => {
    expect(parseDeepLink(BASE + "#Gossiping")).toBeNull();
  });

  test("AID 只有 7 碼", () => {
    expect(parseDeepLink(BASE + "#Gossiping/1gIeu-3")).toBeNull();
  });

  test("AID 有 9 碼", () => {
    expect(parseDeepLink(BASE + "#Gossiping/1gIeu-3AB")).toBeNull();
  });

  test("AID 含非法字元", () => {
    expect(parseDeepLink(BASE + "#Gossiping/1gIeu.3A")).toBeNull();
  });

  test("板名只有 1 字", () => {
    expect(parseDeepLink(BASE + "#a/" + AID)).toBeNull();
  });

  test("板名開頭非英數", () => {
    expect(parseDeepLink(BASE + "#_hack/" + AID)).toBeNull();
  });

  test("板名含空白（會被原樣送進 s<board>）", () => {
    expect(parseDeepLink(BASE + "#Gos%20siping/" + AID)).toBeNull();
  });

  test("板名夾帶換行（想多送一個 Enter 給 PTT）", () => {
    expect(parseDeepLink(BASE + "#Gossiping%0Ax/" + AID)).toBeNull();
  });

  test("板名過長", () => {
    expect(parseDeepLink(BASE + "#" + "a".repeat(33) + "/" + AID)).toBeNull();
  });

  test("三段路徑", () => {
    expect(parseDeepLink(BASE + "#Gossiping/" + AID + "/extra")).toBeNull();
  });

  test("壞掉的 percent 序列不 throw", () => {
    expect(parseDeepLink(BASE + "#Gossiping/%E0%A4%A")).toBeNull();
  });

  test("不是合法 URL", () => {
    expect(parseDeepLink("#Gossiping/" + AID)).toBeNull();
  });
});

describe("buildDeepLink", () => {
  test("產生正規形式", () => {
    expect(buildDeepLink(BASE, "Gossiping", AID)).toBe(
      BASE + "#Gossiping/" + AID
    );
  });

  test("round-trip", () => {
    const link = buildDeepLink(BASE, "C_Chat", AID);
    expect(parseDeepLink(link)).toEqual({ board: "C_Chat", aid: AID });
  });

  test("丟掉 query（可能帶本機才有意義的 ?site=）與舊 hash", () => {
    expect(
      buildDeepLink(BASE + "?site=wstelnet://localhost:8080/bbs#movie/aaaaaaaa",
        "Gossiping", AID)
    ).toBe(BASE + "#Gossiping/" + AID);
  });

  test("board 為 null（站內信／精華區問不出看板）→ 不產生連結", () => {
    expect(buildDeepLink(BASE, null, AID)).toBeNull();
  });

  test("非法 aid → 不產生連結", () => {
    expect(buildDeepLink(BASE, "Gossiping", "short")).toBeNull();
  });
});

describe("stripDeepLink", () => {
  test("拆掉 hash 形式（F5 不該重跳一次）", () => {
    expect(stripDeepLink(BASE + "#Gossiping/" + AID)).toBe(BASE);
  });

  test("拆掉 query 形式", () => {
    expect(stripDeepLink(BASE + "?board=Gossiping&aid=" + AID)).toBe(BASE);
  });

  test("保留其他 query 參數", () => {
    expect(stripDeepLink(BASE + "?site=abc&board=Gossiping&aid=" + AID)).toBe(
      BASE + "?site=abc"
    );
  });

  test("不是 deep link 的 hash 原樣留著", () => {
    expect(stripDeepLink(BASE + "#something")).toBe(BASE + "#something");
  });

  test("沒有 deep link 時不動", () => {
    expect(stripDeepLink(BASE)).toBe(BASE);
  });
});
