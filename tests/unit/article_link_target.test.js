// 右鍵選單「游標下這個 <a> 指向哪一篇文章」的判斷（src/js/article_link_target.js）。
//
// 這裡用**真的 DOM 元素**（unit project 跑 jsdom）：判斷會讀 classList 與
// getAttribute，用假物件測等於在測假物件。

import {
  isAidLinkAnchor,
  articleTargetFromAnchor,
  formatArticleCode
} from "../../src/js/article_link_target";

// Row/LinkSegmentBuilder 畫出來的文章代碼連結：href 是佔位符，真資料在 data-*。
function aidAnchor(aid, board) {
  const a = document.createElement("a");
  a.className = "aidLink";
  a.setAttribute("href", "#");
  a.setAttribute("data-aid", aid);
  a.setAttribute("data-board", board || "");
  return a;
}

function urlAnchor(href) {
  const a = document.createElement("a");
  a.className = "y";
  a.setAttribute("href", href);
  return a;
}

const PTT_URL = "https://www.ptt.cc/bbs/Browsers/M.1786265274.A.5E3.html";
const PTT_AID = "1gU3wwNZ";

describe("isAidLinkAnchor", () => {
  test("文章代碼連結認得出來", () => {
    expect(isAidLinkAnchor(aidAnchor("1gIeu-3A", "movie"))).toBe(true);
  });

  test("一般連結不是", () => {
    expect(isAidLinkAnchor(urlAnchor(PTT_URL))).toBe(false);
    expect(isAidLinkAnchor(null)).toBe(false);
  });
});

describe("articleTargetFromAnchor：文章代碼連結", () => {
  test("data-board 有寫就用它", () => {
    expect(articleTargetFromAnchor(aidAnchor("1gIeu-3A", "movie"), "C_Chat")).toEqual(
      { board: "movie", aid: "1gIeu-3A" }
    );
  });

  // 內文常見的裸 #AID 沒寫看板。pttchrome.jsx 的點擊路徑也是用 _articleBoard 遞補。
  test("沒寫看板 → 用目前文章的看板遞補", () => {
    expect(articleTargetFromAnchor(aidAnchor("1gIeu-3A", ""), "C_Chat")).toEqual({
      board: "C_Chat",
      aid: "1gIeu-3A"
    });
  });

  // PTT 的 # 搜尋只搜 currboard：沒有看板就組不出「別人點得開」的連結。
  test("沒寫看板又沒有遞補來源 → null（兩個選項都不該出現）", () => {
    expect(articleTargetFromAnchor(aidAnchor("1gIeu-3A", ""), null)).toBeNull();
    expect(articleTargetFromAnchor(aidAnchor("1gIeu-3A", ""), undefined)).toBeNull();
  });

  test("data-aid 不是合法 AIDc → null", () => {
    expect(articleTargetFromAnchor(aidAnchor("1gIeu-3A9", "movie"), null)).toBeNull();
    expect(articleTargetFromAnchor(aidAnchor("", "movie"), null)).toBeNull();
  });

  // 這個字串會被原樣送進 `s<board>\r`，不可以夾雜控制字元或空白。
  test("看板名非法 → null", () => {
    expect(articleTargetFromAnchor(aidAnchor("1gIeu-3A", "a b"), null)).toBeNull();
  });

  // REGRESSION：文章代碼連結的 href 是 "#"。走「當成網址解析」那條路的話，
  // 得到的會是 null 沒錯，但真正的 bug 在呼叫端把它當成 URL —— 這裡先鎖住
  // 「aidLink 一律走 data-* 那條路，不看 href」。
  test("href 是佔位的 '#'，不影響判斷", () => {
    const a = aidAnchor("1gIeu-3A", "movie");
    expect(a.getAttribute("href")).toBe("#");
    expect(articleTargetFromAnchor(a, null)).toEqual({
      board: "movie",
      aid: "1gIeu-3A"
    });
  });
});

describe("articleTargetFromAnchor：內文裡的 ptt.cc 文章網址", () => {
  test("標準文章網址", () => {
    expect(articleTargetFromAnchor(urlAnchor(PTT_URL), null)).toEqual({
      board: "Browsers",
      aid: PTT_AID
    });
  });

  test("非文章網址一律 null", () => {
    for (const href of [
      "https://www.ptt.cc/bbs/Browsers/index.html",
      "https://example.com/x",
      "https://www.ptt.cc/man/Browsers/M.1786265274.A.5E3.html",
      "#"
    ])
      expect(articleTargetFromAnchor(urlAnchor(href), "C_Chat")).toBeNull();
  });

  test("沒有 anchor → null", () => {
    expect(articleTargetFromAnchor(null, "C_Chat")).toBeNull();
    expect(articleTargetFromAnchor(undefined, "C_Chat")).toBeNull();
  });
});

describe("formatArticleCode", () => {
  // PTT 站上的慣用寫法（bbs.c#view_postinfo 印的也是這個形狀）：帶著看板，
  // 換個板貼過去也找得到。
  test("帶看板", () => {
    expect(formatArticleCode({ board: "EZsoft", aid: "1gU3xHKD" })).toBe(
      "#1gU3xHKD (EZsoft)"
    );
  });

  test("沒有看板就只有代碼", () => {
    expect(formatArticleCode({ board: null, aid: "1gU3xHKD" })).toBe("#1gU3xHKD");
  });

  test("沒有 target → null", () => {
    expect(formatArticleCode(null)).toBeNull();
  });
});
