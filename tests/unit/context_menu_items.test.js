// 右鍵選單的旗標與「複製什麼」邏輯（src/js/context_menu_items.js）。
//
// 回歸來源：selEnabled 曾被寫成 `!normalEnabled`（normalEnabled 的補集）。
// 在連結上按右鍵、又沒有選取任何文字時 urlEnabled=true ⇒ normalEnabled=false
// ⇒ selEnabled 被算成 true ⇒ 選單畫出「複製」「複製 (包含 ANSI 顏色)」，
// 但 selectedText 是空字串 ⇒ 點了什麼都沒發生。
import {
  menuTargetFlags,
  copyTextFor,
  copyPreviews,
  truncateMiddle
} from "../../src/js/context_menu_items";

const HREF = "https://example.github.io/pttchrome/?site=x#Gossiping/M.1.A.2.html";
const BASE = "https://example.github.io/pttchrome/";

describe("menuTargetFlags", () => {
  test("連結上 + 沒有選取 → 不算「有選取」（REGRESSION）", () => {
    const f = menuTargetFlags({
      contextOnUrl: "https://i.imgur.com/a.jpg",
      selectionCollapsed: true
    });
    expect(f).toEqual({
      urlEnabled: true,
      normalEnabled: false,
      selEnabled: false
    });
  });

  test("連結上 + 有選取 → 連結項目與複製項目並存", () => {
    expect(
      menuTargetFlags({
        contextOnUrl: "https://i.imgur.com/a.jpg",
        selectionCollapsed: false
      })
    ).toEqual({ urlEnabled: true, normalEnabled: false, selEnabled: true });
  });

  test("空白處 + 有選取 → 只有複製那一組", () => {
    expect(
      menuTargetFlags({ contextOnUrl: "", selectionCollapsed: false })
    ).toEqual({ urlEnabled: false, normalEnabled: false, selEnabled: true });
  });

  test("空白處 + 沒有選取 → 一般項目", () => {
    expect(
      menuTargetFlags({ contextOnUrl: "", selectionCollapsed: true })
    ).toEqual({ urlEnabled: false, normalEnabled: true, selEnabled: false });
  });
});

describe("copyTextFor：預覽與實際複製同源", () => {
  const article = { board: "movie", aid: "1gIeu-3A" };

  test("連結網址就是 href 原文", () => {
    expect(
      copyTextFor("copyLinkUrl", { contextOnUrl: "https://i.imgur.com/a.jpg" }, HREF)
    ).toBe("https://i.imgur.com/a.jpg");
  });

  test("文章代碼是 PTT 慣用的帶看板寫法", () => {
    expect(copyTextFor("copyArticleAid", { contextArticle: article }, HREF)).toBe(
      "#1gIeu-3A (movie)"
    );
  });

  test("分享連結是檔名形式，且丟掉目前網址的 query", () => {
    expect(
      copyTextFor("copyArticleDeepLink", { contextArticle: article }, HREF)
    ).toBe(BASE + "#movie/M.1783270974.A.0CA.html");
  });

  test("本篇連結走 currentArticle（findLocalPostAid 的結果）", () => {
    expect(
      copyTextFor("copyArticleLink", { currentArticle: article }, HREF)
    ).toBe(BASE + "#movie/M.1783270974.A.0CA.html");
  });

  test("算不出來一律 null（不是 undefined、不是空字串）", () => {
    expect(copyTextFor("copyLinkUrl", {}, HREF)).toBeNull();
    expect(copyTextFor("copyArticleAid", {}, HREF)).toBeNull();
    expect(copyTextFor("copyArticleDeepLink", {}, HREF)).toBeNull();
    // 長文還沒捲到「※ 文章網址」那行：沒有預覽，但選項本身照樣在。
    expect(copyTextFor("copyArticleLink", { currentArticle: null }, HREF)).toBeNull();
    expect(copyTextFor("notAnEventKey", { contextOnUrl: "x" }, HREF)).toBeNull();
  });
});

describe("truncateMiddle：省略中段、保住結尾", () => {
  test("短字串原樣不動", () => {
    expect(truncateMiddle("#1gIeu-3A (movie)", 72)).toBe("#1gIeu-3A (movie)");
  });

  test("長網址：頭尾都在，副檔名不會被切掉", () => {
    const url =
      "https://cdn.example.com/" + "a".repeat(200) + "/Pn3XurX.jpeg";
    const out = truncateMiddle(url, 72);
    expect(out.length).toBe(72);
    expect(out.startsWith("https://")).toBe(true);
    expect(out.endsWith("/Pn3XurX.jpeg")).toBe(true);
    expect(out).toContain("…");
  });

  test("null/undefined 不炸", () => {
    expect(truncateMiddle(null)).toBe("");
    expect(truncateMiddle(undefined)).toBe("");
  });
});

describe("copyPreviews", () => {
  test("只列出算得出內容的 key", () => {
    const previews = copyPreviews(
      { contextOnUrl: "https://i.imgur.com/a.jpg", currentArticle: null },
      HREF
    );
    expect(Object.keys(previews)).toEqual(["copyLinkUrl"]);
    expect(previews.copyLinkUrl).toBe("https://i.imgur.com/a.jpg");
  });

  test("預覽字串是「實際會複製的字串」截斷後的結果", () => {
    const url = "https://cdn.example.com/" + "a".repeat(200) + "/Pn3XurX.jpeg";
    const previews = copyPreviews({ contextOnUrl: url }, HREF);
    expect(previews.copyLinkUrl).toBe(truncateMiddle(url));
  });
});
