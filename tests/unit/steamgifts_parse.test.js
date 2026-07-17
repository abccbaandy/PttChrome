// Steamgifts giveaway 代碼自動連結（純邏輯守護）。
// 行為鎖定：只有「文章內出現 steamgifts 字樣」時，獨立成列的 5 碼英數才連結到
// https://www.steamgifts.com/giveaway/<code>/（無 slug，站方自動 redirect）。

const {
  articleHasSteamgifts,
  detectGiveawayCodes,
} = require("../../src/js/steamgifts_parse");

// 使用者提供的實際 [抽獎] 文（Steam 板）
const giveawayArticle = [
  " 作者  YoshiTilde (一頁本是難成書)                                看板  Steam",
  " 標題  [抽獎] Steamgifts LV1",
  " 時間  Fri Jul 17 17:37:41 2026",
  "───────────────────────────",
  "",
  "LV1，限港台，至7月20日17點。",
  "若key無法啟用，請在Steamgifts留言告知，並同意我刪除giveaway，謝謝。",
  "",
  "Dragon's Dogma: Dark Arisen",
  "jQtf0",
  "",
  "Mega Man Legacy Collection",
  "zA4jJ",
  "",
  "Mega Man X Legacy Collection",
  "6dCgN",
  "",
  "Mega Man 11",
  "PgVRr",
];

describe("articleHasSteamgifts（文章層 gate）", () => {
  it("標題/內文含 Steamgifts（不分大小寫）→ 啟用", () => {
    expect(articleHasSteamgifts(giveawayArticle)).toBe(true);
  });
  it("含 steamgifts 網址形式也啟用", () => {
    expect(
      articleHasSteamgifts(["前言", "https://www.steamgifts.com/giveaway/abc12/x"]),
    ).toBe(true);
  });
  it("無 steamgifts 字樣的文章 → 不啟用", () => {
    expect(articleHasSteamgifts(["一般文章", "HELLO", "ver 1.2.3"])).toBe(false);
    expect(articleHasSteamgifts([])).toBe(false);
  });
});

describe("detectGiveawayCodes（列層 pattern）", () => {
  it("獨立成列的 5 碼英數 → 命中，URL 正確（範例文四組全中）", () => {
    for (const code of ["jQtf0", "zA4jJ", "6dCgN", "PgVRr"]) {
      const found = detectGiveawayCodes(code);
      expect(found).toEqual([
        {
          startCol: 0,
          endCol: 5,
          code,
          href: `https://www.steamgifts.com/giveaway/${code}/`,
        },
      ]);
    }
  });
  it("前導空白不影響命中，startCol 對應原始欄位", () => {
    expect(detectGiveawayCodes("   jQtf0  ")).toEqual([
      {
        startCol: 3,
        endCol: 8,
        code: "jQtf0",
        href: "https://www.steamgifts.com/giveaway/jQtf0/",
      },
    ]);
  });
  it("非獨立列（前後有其他文字）不命中", () => {
    expect(detectGiveawayCodes("代碼是 jQtf0 喔")).toEqual([]);
    expect(detectGiveawayCodes("> jQtf0")).toEqual([]);
    // 推文列（整列不是純代碼）
    expect(detectGiveawayCodes("推 someone: jQtf0        07/17 18:00")).toEqual(
      [],
    );
  });
  it("4 碼／6 碼／含符號不命中", () => {
    expect(detectGiveawayCodes("jQtf")).toEqual([]);
    expect(detectGiveawayCodes("jQtf01")).toEqual([]);
    expect(detectGiveawayCodes("jQt-0")).toEqual([]);
  });
  it("空列與遊戲名列不命中", () => {
    expect(detectGiveawayCodes("")).toEqual([]);
    expect(detectGiveawayCodes("Mega Man 11")).toEqual([]);
    expect(detectGiveawayCodes("Dragon's Dogma: Dark Arisen")).toEqual([]);
  });
});
