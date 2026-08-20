// 滑鼠區域決策層。這份表就是「點哪裡會發生什麼」的唯一真相，逐格鎖住：
// 改版前它散在 term_buf.onMouse_move 的 switch 裡、輸出是 0..14 的數字、無法測，
// 而且「隨手一點就跳出文章」「點作者欄誤開文」都是那份表的直接後果。
import {
  ACT_NONE,
  ACT_ENTER,
  ACT_EXIT_ARTICLE,
  CUR_AUTO,
  CUR_POINTER,
  CUR_BACK,
  EXIT_COL_END,
  MENU_COL_START,
  clickableColStart,
  resolveMouseRegion,
  cursorCss,
} from "../../src/js/mouse_regions";
import { LIST_TITLE_COL_START } from "../../src/js/comment_parse";

// 預設帶著防誤觸模式（pref 預設就是開）；關掉的那一半另有 describe。
const at = (over) =>
  resolveMouseRegion({ rows: 24, lineEmpty: false, misclickGuard: true, ...over });

describe("文章列表（pageState 2）", () => {
  test("只有標題欄（col >= 30）可以開文", () => {
    expect(at({ pageState: 2, row: 5, col: LIST_TITLE_COL_START }).action).toBe(
      ACT_ENTER,
    );
    expect(at({ pageState: 2, row: 5, col: LIST_TITLE_COL_START }).row).toBe(5);
    expect(at({ pageState: 2, row: 5, col: 79 }).action).toBe(ACT_ENTER);
  });

  test("作者欄最後一格（col 29）不可開文 —— 這是誤觸的主要來源", () => {
    const r = at({ pageState: 2, row: 5, col: LIST_TITLE_COL_START - 1 });
    expect(r.action).toBe(ACT_NONE);
    expect(r.cursor).toBe(CUR_AUTO);
  });

  test("序號／日期／作者欄全部不可開文", () => {
    [0, 6, 7, 8, 10, 16, 17, 25, 29].forEach((col) => {
      expect(at({ pageState: 2, row: 5, col }).action).toBe(ACT_NONE);
    });
  });

  test("hover 整列都認得（底色的列），但底色只從標題欄畫起", () => {
    expect(at({ pageState: 2, row: 5, col: 0 }).highlightRow).toBe(5);
    expect(at({ pageState: 2, row: 5, col: 40 }).highlightRow).toBe(5);
    // 底色區＝可點區（使用者 2026-08 定案），兩者不可分岔。
    expect(at({ pageState: 2, row: 5, col: 0 }).highlightColStart).toBe(
      LIST_TITLE_COL_START,
    );
    expect(at({ pageState: 2, row: 5, col: 40 }).highlightColStart).toBe(
      LIST_TITLE_COL_START,
    );
  });

  test("空列不可點也不上色", () => {
    const r = at({ pageState: 2, row: 5, col: 40, lineEmpty: true });
    expect(r.action).toBe(ACT_NONE);
    expect(r.highlightRow).toBe(-1);
  });

  test("標題列（0/1/2）與狀態列（23）不是正文列", () => {
    [0, 1, 2, 23].forEach((row) => {
      expect(at({ pageState: 2, row, col: 40 }).action).toBe(ACT_NONE);
    });
    expect(at({ pageState: 2, row: 3, col: 40 }).action).toBe(ACT_ENTER);
    expect(at({ pageState: 2, row: 22, col: 40 }).action).toBe(ACT_ENTER);
  });

  test("舊的左緣離開／右緣翻頁已經不存在", () => {
    expect(at({ pageState: 2, row: 5, col: 3 }).action).toBe(ACT_NONE); // 舊：離開
    expect(at({ pageState: 2, row: 5, col: 70 }).action).toBe(ACT_ENTER); // 舊：翻頁
  });
});

describe("LIST 變體（pageState 4）", () => {
  test("正文列範圍比 pageState 2 各外擴一列", () => {
    expect(at({ pageState: 4, row: 2, col: 40 }).action).toBe(ACT_ENTER);
    expect(at({ pageState: 4, row: 1, col: 40 }).action).toBe(ACT_NONE);
    expect(at({ pageState: 4, row: 21, col: 40 }).action).toBe(ACT_ENTER);
    expect(at({ pageState: 4, row: 22, col: 40 }).action).toBe(ACT_NONE);
  });

  test("欄位限制與 pageState 2 相同", () => {
    expect(at({ pageState: 4, row: 5, col: 29 }).action).toBe(ACT_NONE);
    expect(at({ pageState: 4, row: 5, col: 30 }).action).toBe(ACT_ENTER);
  });
});

describe("選單／看板列表（pageState 1）", () => {
  // 刻意不套欄位限制：pttbbs board.c#show_brdlist 每列至少四種版型，沒有共用的
  // 標題欄起點可校準（見 mouse_regions.js 的 MENU_COL_START 註解）。
  test("col > 7 整列可點", () => {
    expect(at({ pageState: 1, row: 5, col: MENU_COL_START }).action).toBe(
      ACT_ENTER,
    );
    expect(at({ pageState: 1, row: 5, col: MENU_COL_START }).row).toBe(5);
    expect(at({ pageState: 1, row: 5, col: 70 }).action).toBe(ACT_ENTER);
  });

  test("最左邊的序號區不可點（舊版是「離開」，現在什麼都不做）", () => {
    expect(at({ pageState: 1, row: 5, col: 7 }).action).toBe(ACT_NONE);
    expect(at({ pageState: 1, row: 5, col: 0 }).action).toBe(ACT_NONE);
  });

  test("hover 一樣上底色，範圍從可點欄起", () => {
    expect(at({ pageState: 1, row: 5, col: 0 }).highlightRow).toBe(5);
    expect(at({ pageState: 1, row: 5, col: 0 }).highlightColStart).toBe(
      MENU_COL_START,
    );
  });

  test("首列與末列不是正文列", () => {
    expect(at({ pageState: 1, row: 0, col: 40 }).action).toBe(ACT_NONE);
    expect(at({ pageState: 1, row: 23, col: 40 }).action).toBe(ACT_NONE);
  });
});

describe("文章內（pageState 3）", () => {
  test("左側帶＝離開文章，指標換成 back", () => {
    for (let col = 0; col < EXIT_COL_END; ++col) {
      const r = at({ pageState: 3, row: 10, col });
      expect(r.action).toBe(ACT_EXIT_ARTICLE);
      expect(r.cursor).toBe(CUR_BACK);
    }
  });

  test("第 7 欄起什麼都不做", () => {
    expect(at({ pageState: 3, row: 10, col: EXIT_COL_END }).action).toBe(
      ACT_NONE,
    );
    expect(at({ pageState: 3, row: 10, col: 40 }).action).toBe(ACT_NONE);
  });

  test("左側帶對整個視窗高度成立 —— 舊的 row 0/1/2/23 特例已移除", () => {
    // 好讀模式是可捲動長頁，clientToPos 仍把 row clamp 進 0..23，那些「頂列底列」
    // 指的是視窗頂底而非文章頂底，語意本來就對不上。
    [0, 1, 2, 12, 23].forEach((row) => {
      expect(at({ pageState: 3, row, col: 1 }).action).toBe(ACT_EXIT_ARTICLE);
    });
  });

  test("舊的 [ ] = 翻篇／重新整理／Home／End 全部不存在", () => {
    [
      { row: 0, col: 1 }, // 舊：= 同標題首篇
      { row: 1, col: 79 }, // 舊：] 下一篇
      { row: 23, col: 79 }, // 舊：同標題末篇
      { row: 10, col: 40 }, // 舊：PageDown
      { row: 5, col: 40 }, // 舊：PageUp
    ].forEach((pos) => {
      const r = at({ pageState: 3, ...pos });
      expect([ACT_NONE, ACT_EXIT_ARTICLE]).toContain(r.action);
      expect(r.action === ACT_ENTER).toBe(false);
    });
  });

  test("文章內不上游標底色", () => {
    expect(at({ pageState: 3, row: 10, col: 1 }).highlightRow).toBe(-1);
    expect(at({ pageState: 3, row: 10, col: 40 }).highlightRow).toBe(-1);
  });
});

describe("其餘畫面", () => {
  test("NORMAL / PASS / 編輯器一律沒有滑鼠動作", () => {
    [0, 5, 6, undefined].forEach((pageState) => {
      const r = at({ pageState, row: 10, col: 1 });
      expect(r.action).toBe(ACT_NONE);
      expect(r.cursor).toBe(CUR_AUTO);
      expect(r.highlightRow).toBe(-1);
    });
  });
});

// 防誤觸模式（pref mouseMisclickGuard，預設開）＝「可點區＝底色區」的起始欄。
// 關掉之後整列可點、整列上底色（＝改版前的行為）。
describe("clickableColStart（可點區＝底色區的唯一真相源）", () => {
  test("防誤觸開啟：列表 30、選單 8、其餘 0", () => {
    expect(clickableColStart(2, true)).toBe(LIST_TITLE_COL_START);
    expect(clickableColStart(4, true)).toBe(LIST_TITLE_COL_START);
    expect(clickableColStart(1, true)).toBe(MENU_COL_START);
    [0, 3, 5, 6, undefined].forEach((ps) => {
      expect(clickableColStart(ps, true)).toBe(0);
    });
  });

  test("防誤觸關閉：一律 0（整列）", () => {
    [0, 1, 2, 3, 4, 5, 6, undefined].forEach((ps) => {
      expect(clickableColStart(ps, false)).toBe(0);
    });
  });
});

describe("防誤觸關閉：整列可點、整列上底色", () => {
  const off = (over) =>
    resolveMouseRegion({ rows: 24, lineEmpty: false, misclickGuard: false, ...over });

  test("文章列表：序號／日期／作者欄都開得了文", () => {
    [0, 6, 7, 8, 16, 17, 29, 30, 79].forEach((col) => {
      const r = off({ pageState: 2, row: 5, col });
      expect(r.action).toBe(ACT_ENTER);
      expect(r.row).toBe(5);
      expect(r.cursor).toBe(CUR_POINTER);
      expect(r.highlightColStart).toBe(0);
    });
  });

  test("LIST 變體與選單同樣整列可點", () => {
    expect(off({ pageState: 4, row: 5, col: 0 }).action).toBe(ACT_ENTER);
    expect(off({ pageState: 1, row: 5, col: 0 }).action).toBe(ACT_ENTER);
    expect(off({ pageState: 1, row: 5, col: 0 }).highlightColStart).toBe(0);
  });

  test("空列／非正文列／文章頁不受影響", () => {
    expect(off({ pageState: 2, row: 5, col: 0, lineEmpty: true }).action).toBe(
      ACT_NONE,
    );
    expect(off({ pageState: 2, row: 0, col: 0 }).action).toBe(ACT_NONE);
    // 文章的左側退出帶是固定手勢，與防誤觸無關。
    expect(off({ pageState: 3, row: 10, col: 1 }).action).toBe(ACT_EXIT_ARTICLE);
    expect(off({ pageState: 3, row: 10, col: 40 }).action).toBe(ACT_NONE);
  });
});

describe("cursorCss", () => {
  test("括號必須平衡 —— 舊 mouseCursorMap 少一個 ')' 導致所有自訂指標從未生效", () => {
    const css = cursorCss(CUR_BACK, { backUrl: "/x/back.png", iconsEnabled: true });
    expect(css).toContain("back.png");
    expect((css.match(/\(/g) || []).length).toBe((css.match(/\)/g) || []).length);
    expect(css).toMatch(/^url\([^)]+\)\s+\d+\s+\d+,\s*auto$/);
  });

  test("指標圖示關閉（左鍵功能關）時一律 auto", () => {
    expect(cursorCss(CUR_BACK, { backUrl: "/x/back.png", iconsEnabled: false })).toBe(
      "auto",
    );
    expect(cursorCss(CUR_POINTER, { iconsEnabled: false })).toBe("auto");
  });

  test("pointer 不需要圖檔", () => {
    expect(cursorCss(CUR_POINTER, { iconsEnabled: true })).toBe("pointer");
  });

  test("拿不到圖檔時退回 auto，不生出壞掉的 CSS", () => {
    expect(cursorCss(CUR_BACK, { iconsEnabled: true })).toBe("auto");
    expect(cursorCss(CUR_AUTO, { iconsEnabled: true })).toBe("auto");
  });
});
