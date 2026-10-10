import {
  articleContextFromScreen,
  shouldClearArticleContextOnSettle
} from "../../src/js/comment_parse";
import { parseStatusRow } from "../../src/js/string_util";

// term_view 的「目前這篇」事實（_articleAuthor／_articleBoard／_articleTitle：App Bar
// 標題、#AID 遞補看板、同作者高亮）。原本只有讀到檔頭才覆寫 ⇒ 沒有檔頭的特殊文章
// （進站的系統公告、pmore 動畫…）會沿用上一篇的標題（手機 App Bar 顯示舊文章標題，
// 錄製檔 ptt-debug-20261009-231630：「站內信箱僅供…」公告頁）。
describe("articleContextFromScreen（每幀：設定／清空／沿用）", () => {
  const top = parseStatusRow(
    "  瀏覽 第 1/1 頁 (100%)  目前顯示: 第 01~03 行              (h)說明 (←/q)離開  "
  );
  const later = parseStatusRow(
    "  瀏覽 第 2/3 頁 ( 60%)  目前顯示: 第 23~45 行              (h)說明 (←/q)離開  "
  );

  test("有檔頭 → 作者／看板／標題一起設定", () => {
    expect(
      articleContextFromScreen(
        "作者  wowBenny (nick) 看板 C_Chat",
        "標題  [閒聊] 測試",
        top
      )
    ).toEqual({ author: "wowbenny", board: "C_Chat", title: "[閒聊] 測試" });
  });

  test("沒有檔頭的文章首頁（系統公告）→ 全部清空，不可沿用上一篇", () => {
    expect(
      articleContextFromScreen(
        "** 站內信箱僅供與站內其它使用者訊息交流，或方便與它站交換資料。",
        "   請各位使用者別把站內信箱拿來當熱門看板永久備份空間超收上千或上萬封文件，",
        top
      )
    ).toEqual({ author: null, board: null, title: null });
  });

  test("非首頁沒有檔頭 → 沿用（null）", () => {
    expect(articleContextFromScreen("內文", "內文", later)).toBeNull();
  });

  test("狀態列不是文章狀態列（prompt 蓋住）→ 沿用", () => {
    expect(articleContextFromScreen("內文", "內文", null)).toBeNull();
  });

  test("舊式狀態列無行號：第 1 頁 → 視為首頁", () => {
    expect(
      articleContextFromScreen("動畫", "", {
        pageIndex: 1,
        rowIndexStart: null,
        rowsUnknown: true
      })
    ).toEqual({ author: null, board: null, title: null });
    expect(
      articleContextFromScreen("動畫", "", {
        pageIndex: 2,
        rowIndexStart: null,
        rowsUnknown: true
      })
    ).toBeNull();
  });
});

describe("shouldClearArticleContextOnSettle（離開文章 → 一律清空）", () => {
  test("穩定在列表／選單／空白畫面 → 清", () => {
    for (const pageState of [0, 1, 2])
      expect(shouldClearArticleContextOnSettle({ pageState })).toBe(true);
  });

  test("仍在文章 → 不清", () => {
    expect(shouldClearArticleContextOnSettle({ pageState: 3 })).toBe(false);
  });

  test("文章裡的 prompt／編輯器（好讀 functionMode）→ 不清", () => {
    expect(
      shouldClearArticleContextOnSettle({ pageState: 6, functionMode: true })
    ).toBe(false);
  });

  test("跳行修補進行中（跳至第幾行 prompt）→ 不清", () => {
    expect(
      shouldClearArticleContextOnSettle({ pageState: 0, healInFlight: true })
    ).toBe(false);
  });

  test("按任意鍵繼續（pageState 5，可能還會回文章）→ 不清", () => {
    expect(shouldClearArticleContextOnSettle({ pageState: 5 })).toBe(false);
  });
});
