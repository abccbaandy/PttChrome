// Unit tests for src/js/deep_link.js — the 外部連結 → 文章 的 URL 合約。
// 這組 test 就是格式的規格書：正規形式 #<Board>/M.<v1>.A.<v2>.html（與 ptt.cc
// 文章網址同形），另外相容「只吃不產」的短碼形式與 key=value 的 hash / query。
// 任何「看起來像但不合法」的東西都必須回 null（＝照常開站），因為那個字串會被
// 原樣送進 `s<board>\r` / `#<aid>\r`。

import {
  parseDeepLink,
  buildDeepLink,
  stripDeepLink,
  parseSharedText,
  hasShareParams,
} from "../../src/js/deep_link";
import manifest from "../../public/manifest.webmanifest?raw";
import { fnToAid } from "../../src/js/aid_codec";

const BASE = "https://example.github.io/pttchrome/";
const AID = "1gIeu-3A";
// 同一篇文章的檔名形式（aid_codec 可逆換算，對照值守在 aid_codec.test.js）。
const FN = "M.1783270974.A.0CA.html";

describe("parseDeepLink — 正規形式 #<Board>/<檔名>", () => {
  test("basic", () => {
    expect(parseDeepLink(BASE + "#Gossiping/" + FN)).toEqual({
      board: "Gossiping",
      aid: AID
    });
  });

  test(".html 可有可無", () => {
    expect(parseDeepLink(BASE + "#Gossiping/M.1783270974.A.0CA")).toEqual({
      board: "Gossiping",
      aid: AID
    });
  });

  test("前導／尾端斜線也吃", () => {
    expect(parseDeepLink(BASE + "#/C_Chat/" + FN)).toEqual({
      board: "C_Chat",
      aid: AID
    });
    expect(parseDeepLink(BASE + "#C_Chat/" + FN + "/")).toEqual({
      board: "C_Chat",
      aid: AID
    });
  });

  test("整條 ptt.cc 文章網址的後兩段可以直接貼進 hash", () => {
    // 需求：拿到文章網址的人要能「複製貼上」手組出本站連結。
    const pttUrl = "https://www.ptt.cc/bbs/Browsers/M.1786265274.A.5E3.html";
    const tail = pttUrl.split("/bbs/")[1];
    expect(parseDeepLink(BASE + "#" + tail)).toEqual({
      board: "Browsers",
      aid: "1gU3wwNZ"
    });
  });

  test("檔名壞掉 → null（照常開站，不可送半截的 #<aid>\\r）", () => {
    expect(parseDeepLink(BASE + "#Gossiping/M.1783270974.X.0CA.html")).toBeNull();
    expect(parseDeepLink(BASE + "#Gossiping/M.1783270974.A.0CAF.html")).toBeNull();
  });
});

// 2026-08 之前產出的連結還在別人的記事本／LINE 對話裡，永遠要吃得下。
describe("parseDeepLink — 舊短碼形式 #<Board>/<AID>（只吃不產）", () => {
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
  test("產生正規形式（檔名形式，與 ptt.cc 文章網址同形）", () => {
    expect(buildDeepLink(BASE, "Gossiping", AID)).toBe(
      BASE + "#Gossiping/" + FN
    );
  });

  test("文摘的 G AID（文摘裡按 Q 拿到的）換回原文的 M 檔名", () => {
    const g = fnToAid("G" + FN.slice(1).replace(/\.html$/, ""));
    expect(g).not.toBe(AID);
    expect(buildDeepLink(BASE, "Gossiping", g)).toBe(BASE + "#Gossiping/" + FN);
  });

  test("不再產出短碼形式", () => {
    expect(buildDeepLink(BASE, "Gossiping", AID)).not.toContain("/" + AID);
  });

  test("round-trip", () => {
    const link = buildDeepLink(BASE, "C_Chat", AID);
    expect(parseDeepLink(link)).toEqual({ board: "C_Chat", aid: AID });
  });

  test("丟掉 query（可能帶本機才有意義的 ?site=）與舊 hash", () => {
    expect(
      buildDeepLink(BASE + "?site=wstelnet://localhost:8080/bbs#movie/aaaaaaaa",
        "Gossiping", AID)
    ).toBe(BASE + "#Gossiping/" + FN);
  });

  test("board 為 null（站內信／精華區問不出看板）→ 不產生連結", () => {
    expect(buildDeepLink(BASE, null, AID)).toBeNull();
  });

  test("非法 aid → 不產生連結", () => {
    expect(buildDeepLink(BASE, "Gossiping", "short")).toBeNull();
  });
});

// P69 分享選單：安裝成 App 的網頁版被選為分享對象 ⇒ manifest share_target 以 GET 開
// ./?share_url=…&share_text=…&share_title=…；APK 把分享文字原樣包成 #share_text=…（原生不解析）。
describe("分享選單（share_target）", () => {
  const PTT = "https://www.ptt.cc/bbs/Gossiping/" + FN;
  const T = { board: "Gossiping", aid: AID };
  const shared = (params) => BASE + "?" + new URLSearchParams(params).toString();

  test("manifest 的 share_target 參數名與解析端一致", () => {
    const st = JSON.parse(manifest).share_target;
    expect(st).toEqual({
      action: "./",
      method: "GET",
      params: { title: "share_title", text: "share_text", url: "share_url" },
    });
  });

  test("share_url／share_text／share_title 任一帶著文章連結就跳", () => {
    expect(parseDeepLink(shared({ share_url: PTT }))).toEqual(T);
    expect(parseDeepLink(shared({ share_text: "[問卦] 有沒有分享的八卦？\n" + PTT }))).toEqual(T);
    expect(parseDeepLink(shared({ share_title: "標題", share_text: "看這篇" + PTT + "。好扯" }))).toEqual(T);
    expect(parseDeepLink(shared({ share_title: PTT }))).toEqual(T);
  });

  test("分享文字：句尾標點、括號、前面接不住的網址", () => {
    expect(parseSharedText("(" + PTT + ").", BASE)).toEqual(T);
    expect(
      parseSharedText("https://example.com/x https://www.ptt.cc/bbs/Gossiping/index.html " + PTT, BASE),
    ).toEqual(T);
    expect(parseSharedText("http://WWW.PTT.CC/bbs/Gossiping/" + FN, BASE)).toEqual(T);
  });

  test("本站分享出去的連結也吃（同一個頁面才算）", () => {
    expect(parseSharedText("PttChrome 連結 " + BASE + "#Gossiping/" + FN, BASE)).toEqual(T);
    expect(parseSharedText("https://example.github.io/pttchrome#Gossiping/" + FN, BASE)).toEqual(T);
    expect(parseSharedText("https://evil.example/pttchrome/#Gossiping/" + FN, BASE)).toBe(null);
  });

  test("沒有文章連結、或看起來像但不合法 ⇒ null（照常開站）", () => {
    expect(parseDeepLink(shared({ share_text: "沒有連結的一段話" }))).toBe(null);
    expect(parseSharedText("https://www.ptt.cc/bbs/Gossiping/index.html", BASE)).toBe(null);
    expect(parseSharedText("https://example.com/bbs/Gossiping/" + FN, BASE)).toBe(null);
    // hex 必須大寫、要有 .html（與 APK 一致）
    expect(parseSharedText("https://www.ptt.cc/bbs/Gossiping/M.1783270974.A.0ca.html", BASE)).toBe(null);
    expect(parseSharedText("https://www.ptt.cc/bbs/Gossiping/M.1783270974.A.0CA", BASE)).toBe(null);
    // 看板名會被原樣送進 s<board>\r
    expect(parseSharedText("https://www.ptt.cc/bbs/_bad/" + FN, BASE)).toBe(null);
    expect(parseSharedText("https://www.ptt.cc/bbs/Go%0Dssiping/" + FN, BASE)).toBe(null);
    expect(parseSharedText(null, BASE)).toBe(null);
  });

  test("PTT 畫面上的「#AID (看板)」寫法（全半形括號）；網址優先", () => {
    expect(parseSharedText("看這篇 #" + AID + " (Gossiping) 好扯", BASE)).toEqual(T);
    expect(parseSharedText("#" + AID + "（Gossiping）", BASE)).toEqual(T);
    expect(parseSharedText("#" + AID + " (C_Chat) " + PTT, BASE)).toEqual(T);
    expect(parseSharedText("#" + AID + " (_bad)", BASE)).toBe(null);
    expect(parseSharedText("#" + AID, BASE)).toBe(null);
  });

  test("APK 的 #share_text=…（URLEncoder 編碼，空白是 +）", () => {
    const frag = "#share_text=" + encodeURIComponent("[問卦] x\n" + PTT).replace(/%20/g, "+");
    expect(parseDeepLink(BASE + frag)).toEqual(T);
    expect(hasShareParams(BASE + "#share_text=hello")).toBe(true);
    expect(stripDeepLink(BASE + frag)).toBe(BASE);
    expect(stripDeepLink(BASE + "#share_text=hello")).toBe(BASE);
  });

  test("開關關掉（opts.share false）⇒ 分享參數一律不看；其他 deep link 照常", () => {
    const off = { share: false };
    expect(parseDeepLink(shared({ share_url: PTT }), off)).toBe(null);
    expect(parseDeepLink(BASE + "#share_text=" + encodeURIComponent(PTT), off)).toBe(null);
    expect(parseDeepLink(BASE + "#Gossiping/" + FN, off)).toEqual(T);
    expect(parseDeepLink(BASE + "?board=Gossiping&aid=" + AID, off)).toEqual(T);
  });

  test("hasShareParams：只認分享參數，空值不算", () => {
    expect(hasShareParams(shared({ share_text: "x" }))).toBe(true);
    expect(hasShareParams(shared({ share_text: "" }))).toBe(false);
    expect(hasShareParams(BASE + "#Gossiping/" + FN)).toBe(false);
    expect(hasShareParams("not a url")).toBe(false);
  });

  test("hash／board=aid 照舊優先於分享參數", () => {
    expect(
      parseDeepLink(BASE + "?share_url=" + encodeURIComponent("https://www.ptt.cc/bbs/C_Chat/" + FN) + "#Gossiping/" + FN),
    ).toEqual(T);
  });

  test("消費後拆掉分享參數（找不到文章也拆），其他參數留著", () => {
    expect(stripDeepLink(shared({ share_url: PTT }))).toBe(BASE);
    expect(stripDeepLink(BASE + "?site=abc&share_text=hello&share_title=x")).toBe(BASE + "?site=abc");
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
