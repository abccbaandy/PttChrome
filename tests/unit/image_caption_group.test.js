// 好讀「圖左字右合併」分組純函式的回歸守護（結構仿 #1gKHF5hU C_Chat 翻譯漫畫文：
// 前導文 → 圖連結 → 多行翻譯 → 圖連結 → …）。規則見 src/js/image_caption_group.js。
import {
  groupImageCaptionBlocks,
  maxCaptionCols,
} from "../../src/js/image_caption_group";

const IMG1 = "https://i.imgur.com/aaa111.jpg";
const IMG2 = "https://i.imgur.com/bbb222.jpg";
const IMG3 = "https://i.imgur.com/ccc333.png";

describe("groupImageCaptionBlocks", () => {
  test("典型翻譯漫畫結構：圖行＋其後翻譯段成塊；前導文不併", () => {
    const rows = [
      "作者 someone (nick) 看板 C_Chat", // 0 header
      "這是前導心得文字", // 1 前導 → 不屬於任何塊
      "", // 2
      IMG1, // 3
      "翻譯第一句", // 4
      "翻譯第二句", // 5
      "", // 6
      IMG2, // 7
      "第二張的翻譯", // 8
    ];
    expect(groupImageCaptionBlocks(rows)).toEqual([
      { imageRow: 3, captionStart: 4, captionEnd: 5 },
      { imageRow: 7, captionStart: 8, captionEnd: 8 },
    ]);
  });

  test("就近段落：只取圖下方最近一段（空行封閉說明段），前導空行照跳", () => {
    const rows = [IMG1, "", "段落一", "", "段落二", "", IMG2, "字"];
    expect(groupImageCaptionBlocks(rows)[0]).toEqual({
      imageRow: 0,
      captionStart: 2,
      captionEnd: 2, // 空行(3)封閉說明段；段落二(4)與 IMG1 無關，不併
    });
  });

  test("就近段落（imageFirst）：圖後緊貼段之後的無關結語不被吸進右欄", () => {
    const rows = [
      IMG1, // 0
      "step: 35  mu: 0.0", // 1 緊貼段（相關文）
      "", // 2
      "整體心得結語與圖無關", // 3
      "補充說明也無關", // 4
      "--", // 5
    ];
    expect(groupImageCaptionBlocks(rows)).toEqual([
      { imageRow: 0, captionStart: 1, captionEnd: 1 },
    ]);
  });

  test("連續兩張圖：無說明的塊不回傳（照常 render）", () => {
    const rows = [IMG1, IMG2, "只有第二張有翻譯"];
    expect(groupImageCaptionBlocks(rows)).toEqual([
      { imageRow: 1, captionStart: 2, captionEnd: 2 },
    ]);
  });

  test("「來源：URL」帶前綴的行不是圖行，歸入上一塊說明段", () => {
    const rows = [IMG1, "翻譯", "來源：https://i.imgur.com/src.jpg", IMG2, "字"];
    expect(groupImageCaptionBlocks(rows)).toEqual([
      { imageRow: 0, captionStart: 1, captionEnd: 2 },
      { imageRow: 3, captionStart: 4, captionEnd: 4 },
    ]);
  });

  test("簽名檔分隔線 -- 截斷：之後的圖/字都不分組", () => {
    const rows = [IMG1, "翻譯", "--", IMG2, "簽名檔裡的字"];
    expect(groupImageCaptionBlocks(rows)).toEqual([
      { imageRow: 0, captionStart: 1, captionEnd: 1 },
    ]);
  });

  test("app 簽名檔（----- ＋ Sent from …）截斷：不被當成最後一張圖的翻譯", () => {
    const rows = [
      IMG1,
      "翻譯",
      IMG2,
      "第二張翻譯",
      "",
      "-----",
      "Sent from JPTT on my Samsung SM-S9380.",
    ];
    expect(groupImageCaptionBlocks(rows)).toEqual([
      { imageRow: 0, captionStart: 1, captionEnd: 1 },
      { imageRow: 2, captionStart: 3, captionEnd: 3 },
    ]);
  });

  test("第一條推文截斷（真推文＝行尾帶 MM/DD HH:MM 時間戳）", () => {
    const rows = [
      IMG1,
      "翻譯",
      "推 someuser: 推翻譯 06/13 12:01",
      IMG2,
      "推文區貼的圖不分組",
    ];
    expect(groupImageCaptionBlocks(rows)).toEqual([
      { imageRow: 0, captionStart: 1, captionEnd: 1 },
    ]);
  });

  test("內文假推文（無時間戳）不截斷", () => {
    const rows = [IMG1, "→ tony : 這只是內文引用", IMG2, "字"];
    expect(groupImageCaptionBlocks(rows)).toEqual([
      { imageRow: 0, captionStart: 1, captionEnd: 1 },
      { imageRow: 2, captionStart: 3, captionEnd: 3 },
    ]);
  });

  test("非圖 sole-URL 行是中性：不開新塊、也不延伸 captionEnd（下一張圖的來源連結不被拖進上一塊尾巴）", () => {
    const rows = [
      IMG1,
      "翻譯",
      "https://x.com/SomeAuthor/status/123456", // 下一張圖的來源連結
      IMG3,
      "字",
    ];
    expect(groupImageCaptionBlocks(rows)).toEqual([
      { imageRow: 0, captionStart: 1, captionEnd: 1 }, // x.com 行不在尾巴
      { imageRow: 3, captionStart: 4, captionEnd: 4 },
    ]);
    // 夾在文字中間的中性行仍留在段內（範圍涵蓋）。
    const rows2 = [IMG1, "上文", "https://youtu.be/dQw4w9WgXcQ", "下文"];
    expect(groupImageCaptionBlocks(rows2)).toEqual([
      { imageRow: 0, captionStart: 1, captionEnd: 3 },
    ]);
  });

  test("圖行 URL 帶前後空白（BBS 定寬列尾空白）仍算圖行", () => {
    const rows = ["  " + IMG1 + "   ", "翻譯"];
    expect(groupImageCaptionBlocks(rows)).toEqual([
      { imageRow: 0, captionStart: 1, captionEnd: 1 },
    ]);
  });

  test("maxCaptionCols：半形1/全形2 欄、行尾空白不計、取全部說明段最大值", () => {
    const rows = [
      IMG1,
      "abc  ", // 3 欄（行尾空白不計）
      "中文四字", // 8 欄
      IMG2,
      "mix中1  ", // 3+2+1 = 6 欄
    ];
    const blocks = groupImageCaptionBlocks(rows);
    expect(maxCaptionCols(rows, blocks)).toBe(8);
    expect(maxCaptionCols(rows, [])).toBe(0);
  });

  test("無圖文章 → 空陣列；null/undefined 列容錯", () => {
    expect(groupImageCaptionBlocks(["純文字", "", "還是文字"])).toEqual([]);
    expect(groupImageCaptionBlocks([IMG1, null, undefined, "字"])).toEqual([
      { imageRow: 0, captionStart: 3, captionEnd: 3 },
    ]);
  });
});

describe("groupImageCaptionBlocks captionFirst（上文下圖）", () => {
  const g = (rows) => groupImageCaptionBlocks(rows, "captionFirst");

  test("典型上文下圖：圖行之前的文字 run 成塊；最後圖之後殘留文字丟棄", () => {
    const rows = [
      "翻譯第一句", // 0
      "翻譯第二句", // 1
      "", // 2
      IMG1, // 3
      "第二張的翻譯", // 4
      IMG2, // 5
      "後記文字（不屬於任何塊）", // 6
    ];
    expect(g(rows)).toEqual([
      { imageRow: 3, captionStart: 0, captionEnd: 1 },
      { imageRow: 5, captionStart: 4, captionEnd: 4 },
    ]);
  });

  test("就近段落：只取圖上方最近一段；段與圖之間隔空行仍配對", () => {
    const rows = ["", "段落一", "", "段落二", "", IMG1];
    expect(g(rows)).toEqual([{ imageRow: 5, captionStart: 3, captionEnd: 3 }]);
  });

  test("就近段落（captionFirst）：多段無關前言不併進首圖，只取緊貼段（回報 case：AI_Art Ideogram 測試文）", () => {
    const rows = [
      "前言：模型介紹與工作流討論", // 0 無關
      "所以工作流中的 Guider 可能需要改", // 1 無關
      "", // 2
      "在我的環境下 相同種子下各設定值的生成速度", // 3 無關
      "*(時間為該設定值重複運行十次取最佳值)", // 4 無關
      "", // 5
      "原生Ideogram V4 NVFP4", // 6 ← 緊貼段（相關文）
      "quality設定值 生成時間為Default的 194%時間", // 7
      "  step: 35  mu: 0.0  std: 1.5", // 8
      IMG1, // 9
      "", // 10
      "原生Ideogram V4 NVFP4", // 11 ← 第二張的緊貼段
      "Default設定值 代表基準值 (100%)", // 12
      IMG2, // 13
    ];
    expect(g(rows)).toEqual([
      { imageRow: 9, captionStart: 6, captionEnd: 8 },
      { imageRow: 13, captionStart: 11, captionEnd: 12 },
    ]);
  });

  test("就近段落（captionFirst）：圖上方直接是空行且更上方無新段 → 沿用最近一段；全空則無塊", () => {
    // 段落 → 空行 → 圖：常見排版，空行不斷開「最近一段」與圖的配對。
    expect(g(["說明段", "", IMG1])).toEqual([
      { imageRow: 2, captionStart: 0, captionEnd: 0 },
    ]);
    // 圖上方全是空行 → 無塊。
    expect(g(["", "", IMG1])).toEqual([]);
  });

  test("連續兩張圖：前無文字 run 的圖不回傳塊", () => {
    const rows = ["只有第一張有翻譯", IMG1, IMG2];
    expect(g(rows)).toEqual([{ imageRow: 1, captionStart: 0, captionEnd: 0 }]);
  });

  test("中性 sole-URL 行：不成圖塊、不延伸 captionEnd、不重置 run", () => {
    const rows = [
      "翻譯",
      "https://x.com/SomeAuthor/status/123456", // 來源連結
      IMG1,
      "字",
      IMG2,
    ];
    expect(g(rows)).toEqual([
      { imageRow: 2, captionStart: 0, captionEnd: 0 }, // x.com 行不在尾巴
      { imageRow: 4, captionStart: 3, captionEnd: 3 },
    ]);
    // 夾在文字中間的中性行仍留在段內（範圍涵蓋）。
    const rows2 = ["上文", "https://youtu.be/dQw4w9WgXcQ", "下文", IMG1];
    expect(g(rows2)).toEqual([{ imageRow: 3, captionStart: 0, captionEnd: 2 }]);
  });

  test("-- 與真推文截斷", () => {
    expect(g(["翻譯", "--", "簽名檔字", IMG1])).toEqual([]);
    expect(g(["翻譯", "推 someuser: 推 06/13 12:01", "字", IMG1])).toEqual([]);
    expect(g(["翻譯", IMG1, "--", "字", IMG2])).toEqual([
      { imageRow: 1, captionStart: 0, captionEnd: 0 },
    ]);
  });

  test("文章 header（作者/看板/標題/時間＋分隔線）不併入首圖的說明段", () => {
    const rows = [
      " 作者  boss0322 (山羊先生)", // 0
      "看板  C_Chat", // 1
      " 標題  [蛋頭] 可以介紹你哥給我認識嗎", // 2
      " 時間  Mon Jul 13 21:35:07 2026", // 3
      "═══════════════════════════", // 4 分隔線（同一全形字重複）
      "", // 5
      "https://x.com/i/status/123", // 6 中性來源連結
      "", // 7
      IMG1, // 8 → header 全被跳過，無 run → 首圖無塊
      "「這是你哥？」", // 9
      IMG2, // 10
    ];
    expect(g(rows)).toEqual([
      { imageRow: 10, captionStart: 9, captionEnd: 9 },
    ]);
  });

  test("無圖文章 → 空陣列；imageFirst 預設值不變", () => {
    expect(g(["純文字", "還是文字"])).toEqual([]);
    // 明確傳 "imageFirst" 與省略等價。
    const rows = [IMG1, "翻譯"];
    expect(groupImageCaptionBlocks(rows, "imageFirst")).toEqual(
      groupImageCaptionBlocks(rows),
    );
  });
});
