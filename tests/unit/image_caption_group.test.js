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

  test("說明段去頭尾空白行、保留段內空行（多段翻譯）", () => {
    const rows = [IMG1, "", "段落一", "", "段落二", "", IMG2, "字"];
    expect(groupImageCaptionBlocks(rows)[0]).toEqual({
      imageRow: 0,
      captionStart: 2,
      captionEnd: 4, // 段內空行(3)保留在範圍內；頭尾空行(1,5)不算
    });
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
