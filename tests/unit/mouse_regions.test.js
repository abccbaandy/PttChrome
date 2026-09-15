// 滑鼠區域決策層。這份表就是「點哪裡會發生什麼」的唯一真相，逐格鎖住：
// 改版前它散在 term_buf.onMouse_move 的 switch 裡、輸出是 0..14 的數字、無法測，
// 而且「隨手一點就跳出文章」「點作者欄誤開文」都是那份表的直接後果。
import {
  ACT_NONE,
  ACT_ENTER,
  ACT_EXIT,
  ACT_EXIT_ARTICLE,
  ACT_PAGE_UP,
  ACT_PAGE_DOWN,
  ACT_HOME,
  ACT_END,
  CUR_AUTO,
  CUR_POINTER,
  CUR_BACK,
  CUR_PAGE_UP,
  CUR_PAGE_DOWN,
  CUR_HOME,
  CUR_END,
  isEdgeCursor,
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
    // 左 7 欄現在是退出帶（見下方 describe），這裡只列 EXIT_COL_END 之後的。
    [7, 8, 10, 16, 17, 25, 29].forEach((col) => {
      expect(at({ pageState: 2, row: 5, col }).action).toBe(ACT_NONE);
    });
  });

  test("hover 整列都認得（底色的列），但底色只從標題欄畫起", () => {
    expect(at({ pageState: 2, row: 5, col: EXIT_COL_END }).highlightRow).toBe(5);
    expect(at({ pageState: 2, row: 5, col: 40 }).highlightRow).toBe(5);
    // 底色區＝可點區（使用者 2026-08 定案），兩者不可分岔。
    expect(at({ pageState: 2, row: 5, col: EXIT_COL_END }).highlightColStart).toBe(
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

  test("舊的右緣翻頁已經不存在（左緣離開 2026-08 重新加回，見下）", () => {
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

  test("退出帶與可點區之間的空隙（col 7）什麼都不做", () => {
    expect(at({ pageState: 1, row: 5, col: EXIT_COL_END }).action).toBe(ACT_NONE);
  });

  test("hover 一樣上底色，範圍從可點欄起", () => {
    expect(at({ pageState: 1, row: 5, col: EXIT_COL_END }).highlightRow).toBe(5);
    expect(at({ pageState: 1, row: 5, col: EXIT_COL_END }).highlightColStart).toBe(
      MENU_COL_START,
    );
  });

  test("首列與末列不是正文列", () => {
    expect(at({ pageState: 1, row: 0, col: 40 }).action).toBe(ACT_NONE);
    expect(at({ pageState: 1, row: 23, col: 40 }).action).toBe(ACT_NONE);
  });
});

// 2026-08 重新加回「列表左緣離開」。當初移除是因為舊版 15 種動作誤觸率高又完全
// 沒有提示；提示帶（#exitHintBand）＋ back 指標補上之後 affordance 問題已解決，
// 使用者要求把它帶回列表／看板列表。見 docs/mouse.md「移除的舊動作」。
describe("列表／選單的左側退出帶（pageState 1/2/4）", () => {
  [1, 2, 4].forEach((pageState) => {
    test(`pageState ${pageState}：左 ${EXIT_COL_END} 欄＝回上一層，指標換成 back`, () => {
      for (let col = 0; col < EXIT_COL_END; ++col) {
        const r = at({ pageState, row: 5, col });
        expect(r.action).toBe(ACT_EXIT);
        expect(r.cursor).toBe(CUR_BACK);
        // 退出帶上沒有「hover 到哪一列」，與文章一致 ⇒ 不上底色。
        expect(r.highlightRow).toBe(-1);
        expect(r.highlightColStart).toBe(0);
      }
    });

    test(`pageState ${pageState}：防誤觸開或關都成立（固定手勢，不是欄位判定）`, () => {
      [true, false].forEach((misclickGuard) => {
        expect(
          resolveMouseRegion({
            rows: 24,
            lineEmpty: false,
            misclickGuard,
            pageState,
            row: 5,
            col: 0,
          }).action,
        ).toBe(ACT_EXIT);
      });
    });

    test(`pageState ${pageState}：第 ${EXIT_COL_END} 欄起不再是退出帶`, () => {
      expect(at({ pageState, row: 5, col: EXIT_COL_END }).action).not.toBe(ACT_EXIT);
    });
  });

  test("非正文列（header/footer）不是退出區 —— 那幾列現在有功能鍵按鈕", () => {
    // 「提示帶亮＝點得下去」的合約：退出帶只在正文列範圍內成立。
    [0, 1, 2, 23].forEach((row) => {
      expect(at({ pageState: 2, row, col: 0 }).action).toBe(ACT_NONE);
    });
    [0, 23].forEach((row) => {
      expect(at({ pageState: 1, row, col: 0 }).action).toBe(ACT_NONE);
    });
  });

  test("空列不是退出區（lineEmpty 檢查排在前面）", () => {
    expect(at({ pageState: 2, row: 5, col: 0, lineEmpty: true }).action).toBe(
      ACT_NONE,
    );
  });

  test("文章的退出動作仍是獨立常數（兩者刻意分開，見 mouse_regions.js）", () => {
    expect(at({ pageState: 3, row: 5, col: 0 }).action).toBe(ACT_EXIT_ARTICLE);
    expect(ACT_EXIT).not.toBe(ACT_EXIT_ARTICLE);
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

// 框開著（pressanykey／vmsg 橫幅／vgetstring 輸入欄）＝整個畫面都是「點空白處
// 關框」的目標。決策本身在 screen_dismiss.resolveDismiss，這裡只驗接線。
describe("點空白處關框（dismiss）", () => {
  const DISMISS = { kind: "anyKey", bytes: " " };

  test("框開著 ⇒ 換 pointer 指標、但**不上底色**（下方整片是殘影）", () => {
    [0, 1, 2, 3, 4, 5].forEach((pageState) => {
      const r = at({ pageState, row: 10, col: 40, dismiss: DISMISS });
      expect(r.cursor).toBe(CUR_POINTER);
      expect(r.highlightRow).toBe(-1);
      // 送鍵不走 buf.mouseAction（notify 每個 changed 幀都把它清成 none），
      // 由 App.mouse_click 在點擊當下現算 ⇒ 這裡必須維持 ACT_NONE。
      expect(r.action).toBe(ACT_NONE);
    });
  });

  test("**優先於 inputPrompt 早退**（輸入欄那一種框正好被它擋掉）", () => {
    const r = at({
      pageState: 2,
      row: 10,
      col: 40,
      inputPrompt: true,
      dismiss: { kind: "inputField", bytes: "\x03" },
    });
    expect(r.cursor).toBe(CUR_POINTER);
    expect(r.highlightRow).toBe(-1);
  });

  test("框開著時左側退出帶不再是 back 指標（整片都是關框）", () => {
    const r = at({ pageState: 3, row: 10, col: 1, dismiss: DISMISS });
    expect(r.cursor).toBe(CUR_POINTER);
    expect(r.action).toBe(ACT_NONE);
  });

  test("沒有框時（dismiss = null）行為一字未改", () => {
    const withNull = at({ pageState: 2, row: 10, col: 40, dismiss: null });
    const without = at({ pageState: 2, row: 10, col: 40 });
    expect(withNull).toEqual(without);
    expect(withNull.action).toBe(ACT_ENTER);
    const article = at({ pageState: 3, row: 10, col: 1, dismiss: null });
    expect(article.action).toBe(ACT_EXIT_ARTICLE);
    expect(article.cursor).toBe(CUR_BACK);
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

  test("文章列表：序號／日期／作者欄都開得了文（退出帶以外）", () => {
    [7, 8, 16, 17, 29, 30, 79].forEach((col) => {
      const r = off({ pageState: 2, row: 5, col });
      expect(r.action).toBe(ACT_ENTER);
      expect(r.row).toBe(5);
      expect(r.cursor).toBe(CUR_POINTER);
      expect(r.highlightColStart).toBe(0);
    });
  });

  test("LIST 變體與選單同樣整列可點（退出帶以外）", () => {
    expect(off({ pageState: 4, row: 5, col: EXIT_COL_END }).action).toBe(ACT_ENTER);
    expect(off({ pageState: 1, row: 5, col: EXIT_COL_END }).action).toBe(ACT_ENTER);
    expect(off({ pageState: 1, row: 5, col: EXIT_COL_END }).highlightColStart).toBe(0);
  });

  test("空列／非正文列／文章頁不受影響", () => {
    expect(off({ pageState: 2, row: 5, col: 0, lineEmpty: true }).action).toBe(
      ACT_NONE,
    );
    expect(off({ pageState: 2, row: 0, col: 0 }).action).toBe(ACT_NONE);
    // 退出帶也**不看防誤觸**（使用者定案），關掉照樣成立。
    expect(off({ pageState: 2, row: 5, col: 0 }).action).toBe(ACT_EXIT);
    expect(off({ pageState: 1, row: 5, col: 0 }).action).toBe(ACT_EXIT);
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

  // 找回來的四顆邊緣區指標走同一支函式 ⇒ 同一條括號平衡鎖要涵蓋它們，
  // 否則歷史會重演（少一個 ')' ⇒ 整條 declaration 被 CSS 丟掉，靜默沒有提示）。
  test("四顆邊緣區指標的 CSS 同樣括號平衡", () => {
    const urls = {
      [CUR_BACK]: "/x/back.png",
      [CUR_PAGE_UP]: "/x/pageup.png",
      [CUR_PAGE_DOWN]: "/x/pagedown.png",
      [CUR_HOME]: "/x/home.png",
      [CUR_END]: "/x/end.png",
    };
    for (const kind of [CUR_PAGE_UP, CUR_PAGE_DOWN, CUR_HOME, CUR_END]) {
      const css = cursorCss(kind, { urls, iconsEnabled: true });
      expect((css.match(/\(/g) || []).length).toBe((css.match(/\)/g) || []).length);
      expect(css).toMatch(/^url\([^)]+\)\s+\d+\s+\d+,\s*auto$/);
    }
    // back 也吃新的 urls 形狀（term_buf／term_view 都改成傳整張表）。
    expect(cursorCss(CUR_BACK, { urls, iconsEnabled: true })).toContain("back.png");
  });

  test("isEdgeCursor 只認那四顆 —— 它決定「不跟 mouseLeftClick 走」的範圍", () => {
    for (const kind of [CUR_PAGE_UP, CUR_PAGE_DOWN, CUR_HOME, CUR_END])
      expect(isEdgeCursor(kind)).toBe(true);
    for (const kind of [CUR_BACK, CUR_POINTER, CUR_AUTO, undefined])
      expect(isEdgeCursor(kind)).toBe(false);
  });
});

// 2026-08：PTT 開著輸入框（vgetstring 的反白輸入欄，見 term_buf.isCursorOnInputField）
// 時，畫面下方殘留的列表／選單列**不可以**還能點 —— 那一點會送 Enter 給輸入框，
// 等於替使用者把搜尋送出／進錯看板。底色也一起關（合約：可點區＝底色區）。
describe("輸入框畫面（inputPrompt）", () => {
  test("列表／選單／文章一律 none、不上色、指標不變", () => {
    [1, 2, 3, 4].forEach((pageState) => {
      [3, 5, 40, LIST_TITLE_COL_START].forEach((col) => {
        const r = at({ pageState, row: 5, col, inputPrompt: true });
        expect(r.action).toBe(ACT_NONE);
        expect(r.cursor).toBe(CUR_AUTO);
        expect(r.highlightRow).toBe(-1);
        expect(r.highlightColStart).toBe(0);
      });
    });
  });

  test("左側退出帶在輸入框畫面也失效（送左方向鍵會被輸入框吃掉）", () => {
    expect(at({ pageState: 2, row: 5, col: 0, inputPrompt: true }).action).toBe(
      ACT_NONE,
    );
    expect(at({ pageState: 3, row: 5, col: 0, inputPrompt: true }).action).toBe(
      ACT_NONE,
    );
  });

  test("沒有輸入框時行為一字不變", () => {
    expect(at({ pageState: 2, row: 5, col: 40, inputPrompt: false }).action)
      .toBe(ACT_ENTER);
  });
});

// 2026-09 滑鼠交給 PTT server（XTerm SGR 回報）時，整張決策表都不作數。
//
// 這是排在**最前面**的早退（連 dismiss 都要讓開）。一條早退同時關掉四件事：
// action 恆 none、指標恆 auto、底色恆 -1、左側退出提示帶不畫 —— 所以四個消費端
// （App.onMouse_click／_applyMousePointer／cursor_highlight／setExitAffordance）
// 一行都不用改。
describe("serverMouse：滑鼠交給 PTT server", () => {
  // 逐格掃過所有 pageState 與所有欄位，一格都不能漏。
  test("所有 pageState 的所有格子都是 NONE", () => {
    for (const pageState of [0, 1, 2, 3, 4, 5]) {
      for (const col of [0, 3, 6, 7, 8, 29, 30, 40, 79]) {
        for (const row of [0, 1, 12, 22, 23]) {
          const r = at({ serverMouse: true, pageState, col, row });
          expect(r.action).toBe(ACT_NONE);
          expect(r.row).toBe(-1);
          expect(r.cursor).toBe(CUR_AUTO);
          expect(r.highlightRow).toBe(-1);
        }
      }
    }
  });

  test("即使框開著（dismiss）也讓開 —— 關框那一下也該由 server 收", () => {
    const r = at({ serverMouse: true, pageState: 5, col: 40, row: 12, dismiss: { bytes: "\r" } });
    expect(r.action).toBe(ACT_NONE);
    expect(r.cursor).toBe(CUR_AUTO);
  });

  test("文章內左側退出帶也讓開", () => {
    const r = at({ serverMouse: true, pageState: 3, col: 2, row: 10 });
    expect(r.action).toBe(ACT_NONE);
    expect(r.cursor).toBe(CUR_AUTO);
  });

  // 零回歸鎖：serverMouse 為 false（＝絕大多數人的常態）時，逐格結果必須與
  // 加這條早退之前**逐字相同**。這一組保護的是「多加一個早退不小心動到既有表」。
  test("serverMouse:false 時逐格與未帶該欄位時完全相同", () => {
    for (const pageState of [0, 1, 2, 3, 4, 5]) {
      for (const col of [0, 3, 6, 7, 8, 29, 30, 40, 79]) {
        for (const row of [0, 1, 12, 22, 23]) {
          const base = at({ pageState, col, row });
          expect(at({ serverMouse: false, pageState, col, row })).toEqual(base);
        }
      }
    }
  });
});

// ── 邊緣翻頁區（pref mouseEdgePaging，2026-09 從 term.ptt.cc 原版找回）───────────
//
// 頂列 Home／底列 End／右緣上下半翻頁（文章內是整片上下半）。當初與另外十種一起
// 被移除，理由是「誤觸率高又完全沒有提示」—— 所以這一組除了逐格鎖動作，也鎖
// 「提示帶矩形與可點範圍是同一個」以及「pref 關掉時整張表一格都沒變」。
describe("邊緣翻頁區：列表（pageState 2）", () => {
  const edge = (over) => at({ pageState: 2, edgePaging: true, cols: 80, ...over });

  test("頂列＝Home、底列＝End，整列寬", () => {
    const home = edge({ row: 0, col: 40 });
    expect(home.action).toBe(ACT_HOME);
    expect(home.hintBand).toEqual({ colStart: 0, colEnd: 80, rowStart: 0, rowEnd: 1 });
    const end = edge({ row: 23, col: 40 });
    expect(end.action).toBe(ACT_END);
    expect(end.hintBand).toEqual({ colStart: 0, colEnd: 80, rowStart: 23, rowEnd: 24 });
  });

  test("標題列與提示列（row 1-2）＝上一頁，帶子涵蓋那兩列", () => {
    for (const row of [1, 2]) {
      const r = edge({ row, col: 40 });
      expect(r.action).toBe(ACT_PAGE_UP);
      expect(r.hintBand).toEqual({ colStart: 0, colEnd: 80, rowStart: 1, rowEnd: 3 });
    }
  });

  test("右緣 16 欄：上半上一頁、下半下一頁（分界 row 12/13）", () => {
    expect(edge({ row: 12, col: 64 }).action).toBe(ACT_PAGE_UP);
    expect(edge({ row: 13, col: 64 }).action).toBe(ACT_PAGE_DOWN);
    expect(edge({ row: 12, col: 79 }).action).toBe(ACT_PAGE_UP);
  });

  test("右緣的左邊界就是 col 64：63 仍然是開文", () => {
    expect(edge({ row: 5, col: 63 }).action).toBe(ACT_ENTER);
    expect(edge({ row: 5, col: 64 }).action).toBe(ACT_PAGE_UP);
  });

  test("左 7 欄仍然是退出帶（右緣帶不得蓋過它）", () => {
    expect(edge({ row: 5, col: 0 }).action).toBe(ACT_EXIT);
    expect(edge({ row: 5, col: 6 }).action).toBe(ACT_EXIT);
  });

  test("邊緣區一律不上底色 —— 那一格的意思是翻頁，不是開這一列", () => {
    for (const [row, col] of [[0, 40], [23, 40], [1, 40], [12, 70], [13, 70]]) {
      const r = edge({ row, col });
      expect(r.highlightRow).toBe(-1);
      expect(r.row).toBe(-1);
    }
  });

  test("提示帶的欄範圍＝可點範圍（右緣帶逐格對齊）", () => {
    const band = edge({ row: 5, col: 70 }).hintBand;
    // 帶子左緣的前一格必須不是翻頁區，帶子右緣就是行尾。
    expect(edge({ row: 5, col: band.colStart }).action).toBe(ACT_PAGE_UP);
    expect(edge({ row: 5, col: band.colStart - 1 }).action).not.toBe(ACT_PAGE_UP);
    expect(band.colEnd).toBe(80);
  });
});

describe("邊緣翻頁區：文章（pageState 3）", () => {
  const edge = (over) => at({ pageState: 3, edgePaging: true, cols: 80, ...over });

  test("沒有右緣帶：上半整片上一頁、下半整片下一頁", () => {
    expect(edge({ row: 3, col: 40 }).action).toBe(ACT_PAGE_UP);
    expect(edge({ row: 12, col: 79 }).action).toBe(ACT_PAGE_UP);
    expect(edge({ row: 13, col: 8 }).action).toBe(ACT_PAGE_DOWN);
    expect(edge({ row: 22, col: 40 }).action).toBe(ACT_PAGE_DOWN);
  });

  test("最後一列＝End", () => {
    expect(edge({ row: 23, col: 40 }).action).toBe(ACT_END);
  });

  test("左側退出帶贏過底列 End —— #exitHintBand 是整片高度，不能讓它說謊", () => {
    expect(edge({ row: 23, col: 3 }).action).toBe(ACT_EXIT_ARTICLE);
    expect(edge({ row: 10, col: 3 }).action).toBe(ACT_EXIT_ARTICLE);
    // 反過來說，End 的帶子必須從第 7 欄才開始，不蓋到退出帶上。
    expect(edge({ row: 23, col: 40 }).hintBand.colStart).toBe(EXIT_COL_END);
  });

  test("翻頁帶也從第 7 欄開始（左側永遠留給離開）", () => {
    expect(edge({ row: 5, col: 40 }).hintBand.colStart).toBe(EXIT_COL_END);
    expect(edge({ row: 20, col: 40 }).hintBand.colStart).toBe(EXIT_COL_END);
  });
});

describe("邊緣翻頁區：pageState 1 只有看板列表能用", () => {
  test("看板列表：頂列 Home、底列 End、右緣翻頁", () => {
    const b = (over) =>
      at({ pageState: 1, edgePaging: true, boardList: true, cols: 80, ...over });
    expect(b({ row: 0, col: 40 }).action).toBe(ACT_HOME);
    expect(b({ row: 23, col: 40 }).action).toBe(ACT_END);
    expect(b({ row: 5, col: 70 }).action).toBe(ACT_PAGE_UP);
    expect(b({ row: 20, col: 70 }).action).toBe(ACT_PAGE_DOWN);
  });

  // 依據：mbbsd/menu.c:508,517 —— 主功能表的 KEY_HOME/KEY_PGUP 是「下一項」、
  // KEY_END/KEY_PGDN 是「上一項」，不是跳第一頁／最後一頁。點下去做出來的事會和
  // 使用者的預期相反，所以整組不給。
  test("主功能表：一格都沒有邊緣區（與 pref 關掉時逐格相同）", () => {
    for (const col of [0, 6, 7, 40, 64, 79]) {
      for (const row of [0, 1, 5, 12, 13, 22, 23]) {
        const on = at({ pageState: 1, edgePaging: true, boardList: false, col, row });
        expect(on).toEqual(at({ pageState: 1, col, row }));
        expect(on.hintBand).toBe(null);
      }
    }
  });
});

describe("邊緣翻頁區：pref 關掉＝零回歸", () => {
  test("edgePaging:false 時逐格與未帶該欄位時完全相同", () => {
    for (const pageState of [0, 1, 2, 3, 4, 5]) {
      for (const col of [0, 3, 6, 7, 8, 29, 30, 40, 63, 64, 70, 79]) {
        for (const row of [0, 1, 2, 5, 12, 13, 21, 22, 23]) {
          const base = at({ pageState, col, row });
          expect(at({ edgePaging: false, pageState, col, row })).toEqual(base);
          // 沒有任何一格會亮提示帶。
          expect(base.hintBand).toBe(null);
        }
      }
    }
  });

  test("輸入框開著／框開著／滑鼠交給 server 時，邊緣區同樣不作數", () => {
    const on = { pageState: 2, edgePaging: true, row: 0, col: 40 };
    expect(at({ ...on, inputPrompt: true }).action).toBe(ACT_NONE);
    expect(at({ ...on, serverMouse: true }).action).toBe(ACT_NONE);
    expect(at({ ...on, dismiss: { bytes: " " } }).action).toBe(ACT_NONE);
    expect(at({ ...on, dismiss: { bytes: " " } }).hintBand).toBe(null);
  });
});
