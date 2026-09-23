// 底部狀態列左側 Caption 的畫面判定（src/js/screen_captions.js）。
//
// 舊格式 fixture 逐字取自 pttbbs 03cdf5eb（CONFIRMED）；新格式照 2026-09-20 公告
// 「介面調整: 動態指令列與看板資訊改版」組的（**guess**，該改動還沒進公開 repo），
// 重新校準見 docs/handoff/list-caption-recalibrate.md。
//
// PTT1/PTT2 上線差約一個月，兩種格式會並存 ⇒ 舊格式這一組一條都不准刪。
import {
  boardListCaptionVariant,
  footerCaption,
  isArticleListFooter,
  isBoardListFooter,
} from "../../src/js/screen_captions";

// read.c:1237-1238（CONFIRMED）
const OLD_ARTICLE =
  " 文章選讀  (y)回應(X)推文(^X)轉錄 (=[]<>)相關主題(/?a)找標題/作者 (b)進板畫面";
// read.c:1234-1235（CONFIRMED）
const OLD_MAIL = " 鴻雁往返  (R/y)回信 (x)站內轉寄 (d/D)刪信 (^P)寄發新信       (←/q)離開";
// board.c:1285-1287（CONFIRMED）
const OLD_BOARD = "  選擇看板    (a)增加看板 (s)進入已知板名 (y)列出全部 (v/V)已讀/未讀";
// edit.c:470-479（CONFIRMED）
const OLD_EDITOR =
  " 編輯文章  (^Z/F1)說明 (^P/^G)插入符號/範本 (^X/^Q)離開        插入│aipr  1:  1";

// 公告第 2 點：中段「 (按鍵)名稱」逐項空白分隔，最右側靠右「(h)說明」（guess）。
const newFooter = (caption, mid = " (y)回應 (X)推文 (^X)轉錄") =>
  " " + caption + " " + mid + "            (h)說明";

describe("footerCaption — 舊格式（CONFIRMED）", () => {
  test.each([
    [OLD_ARTICLE, "文章選讀"],
    [OLD_MAIL, "鴻雁往返"],
    [OLD_BOARD, "選擇看板"],
    [OLD_EDITOR, "編輯文章"],
  ])("%s", (row, caption) => {
    expect(footerCaption(row)).toBe(caption);
  });

  test("舊文章列表是文章列表、舊信箱不是", () => {
    expect(isArticleListFooter(OLD_ARTICLE)).toBe(true);
    expect(isArticleListFooter(OLD_MAIL)).toBe(false);
  });

  test("舊看板列表是看板列表", () => {
    expect(isBoardListFooter(OLD_BOARD)).toBe(true);
    expect(isBoardListFooter(OLD_ARTICLE)).toBe(false);
  });

  test("舊看板列表的變體光看 caption 定不出來（交給按鍵提示）", () => {
    expect(boardListCaptionVariant(OLD_BOARD)).toBe(null);
  });
});

describe("footerCaption — 新格式（guess）", () => {
  test.each(["文章列表", "系列文章", "文摘列表"])(
    "「%s」是文章列表",
    (caption) => {
      expect(isArticleListFooter(newFooter(caption))).toBe(true);
    }
  );

  test("「信件列表」不是文章列表（信箱不得 engage 列表好讀）", () => {
    const row = newFooter("信件列表", " (R)回信 (x)站內轉寄 (d)刪信");
    expect(footerCaption(row)).toBe("信件列表");
    expect(isArticleListFooter(row)).toBe(false);
  });

  test.each(["看板列表", "我的最愛", "分類看板"])("「%s」是看板列表", (caption) => {
    expect(isBoardListFooter(newFooter(caption, " (m)加入/移出最愛"))).toBe(true);
  });

  test("「我的最愛」光看 caption 就定 fav；「看板列表」不定", () => {
    expect(boardListCaptionVariant(newFooter("我的最愛", " (a)增加看板"))).toBe("fav");
    expect(boardListCaptionVariant(newFooter("看板列表", " (m)加入/移出最愛"))).toBe(null);
  });
});

describe("footerCaption — 只認行首", () => {
  test("caption 字樣出現在中段提示裡 ⇒ 不命中", () => {
    expect(footerCaption(" 文摘列表  (f)我的最愛")).toBe("文摘列表");
    expect(isBoardListFooter(" 某個標籤  (f)我的最愛 (y)看板列表")).toBe(false);
    expect(isArticleListFooter("  其他  文章列表")).toBe(false);
  });

  test("主選單新狀態列（左側是選單分類標籤）不命中", () => {
    const row =
      " 主功能表  射手時 9/20 週六 17:09 | someuser | 線上25809人          (h)說明";
    expect(footerCaption(row)).toBe(null);
  });

  test("pmore 狀態列、空列、null 不命中", () => {
    expect(footerCaption("  瀏覽 第 1/2 頁 ( 50%)  目前顯示: 第 01~22 行")).toBe(null);
    expect(footerCaption(" ".repeat(80))).toBe(null);
    expect(footerCaption("")).toBe(null);
    expect(footerCaption(null)).toBe(null);
  });
});
