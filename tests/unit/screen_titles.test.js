// Row 0 標題判定的括號容錯（2026-09-20 公告「介面調整: 標題列與主選單底部狀態列改版」）。
//
// 公告動了兩種標題形狀的括號：
//   單段式 `【 標題 】` → `【標題】`（移除內側空白）
//   兩段式 移除左半部的【】，改為「固定前後各留一格半形空白」
// 三段式（本專案判畫面用的那四個）公告說沒有變動，第 1 點還特地保證
//   「頂端 Row 0 左側仍維持「【主功能表】」不變」
// ⇒ 這次不會壞。這支測試鎖的是**加固**：把散在 8 個檔案的字面值收成一處，
// 並同時吃得下去括號的形狀，下次 PTT 再動括號時不必翻八個檔案。
//
// 最重要的一條是**不可以放寬成 `indexOf(...) >= 0`**：文章內文與看板標題裡到處
// 都有【】，只認第 0 欄起算才是指紋。下面「出現在畫面中間 → false」那幾條就是
// 這件事的閂鎖。
import {
  ARCHIVE_LIST,
  BOARD_LIST,
  CLASS_LIST,
  FAVOURITE,
  MAIN_MENU,
  MENU_TITLES,
  rowHasAnyTitle,
  rowHasTitle,
} from "../../src/js/screen_titles";

describe("rowHasTitle（row 0 標題指紋）", () => {
  // 現行線上版（三段式 vs_header，VMSG_HEADER_PREFIX/POSTFIX = 【/】）。
  // 這一組就是零退化守護：PTT1 10/04 之前 server 還是這個形狀。
  test.each([
    ["【主功能表】 主功能表  Welcome              (C)交談   (M)郵件", MAIN_MENU],
    ["【分類看板】 分類看板                                        ", CLASS_LIST],
    ["【精華文章】 精華文章                                        ", ARCHIVE_LIST],
    ["【看板列表】 看板列表  目前顯示: 全部       ", BOARD_LIST],
  ])("現行三段式 %s 命中", (row, name) => {
    expect(rowHasTitle(row, name)).toBe(true);
  });

  // 去括號形狀：vtuikit.c#vs_draw_hdr2 的 `outs(VCLR_HDR2_LEFT " "); outs(left);
  // outs(" " VCLR_HDR2_RIGHT " ")`（CONFIRMED 讀碼 @ piaip.newui 7e35b24e）。
  // 本專案判畫面的四個標題走 vs_header，仍是【X】；這組守的是容錯。
  test.each([
    [" 主功能表  Welcome                       ", MAIN_MENU],
    [" 看板列表  目前顯示: 全部                ", BOARD_LIST],
    [" 偏好設定列表  調整介面顯示與操作偏好     ", "偏好設定列表"],
  ])("公告描述的去括號形狀 %s 命中", (row, name) => {
    expect(rowHasTitle(row, name)).toBe(true);
  });

  // 從 col 0 起算是承重條件。放寬成 `>= 0` 會讓任何一篇提到【主功能表】的文章
  // 被判成主功能表 —— deep_link_controller 的登入訊號會因此誤觸。
  test.each([
    ["  【主功能表】", "前面多一格空白（不是第 0 欄）"],
    ["※ 引述【主功能表】的文章", "出現在文章內文中間"],
    ["【主功能表】", "沒有後綴也算（indexOf === 0 成立）", true],
    ["主功能表  Welcome", "裸字串沒有任何分隔"],
    ["【主功能表", "括號沒關"],
    ["【 主功能表 】", "單段式的內側空白形狀（不是這四個標題會用的）"],
  ])("%s → %s", (row, _why, expected = false) => {
    expect(rowHasTitle(row, MAIN_MENU)).toBe(expected);
  });

  test("空值一律 false，不得 throw", () => {
    expect(rowHasTitle("", MAIN_MENU)).toBe(false);
    expect(rowHasTitle(null, MAIN_MENU)).toBe(false);
    expect(rowHasTitle(undefined, MAIN_MENU)).toBe(false);
    expect(rowHasTitle("【主功能表】", "")).toBe(false);
    expect(rowHasTitle("【主功能表】", null)).toBe(false);
  });

  // 標題之間不可以互相誤命中（【分類看板】不是【主功能表】）。
  test("不同標題彼此不命中", () => {
    expect(rowHasTitle("【分類看板】 分類看板", MAIN_MENU)).toBe(false);
    expect(rowHasTitle(" 看板列表  全部", MAIN_MENU)).toBe(false);
  });
});

describe("rowHasAnyTitle / MENU_TITLES", () => {
  // MENU_TITLES 是 setPageState / classifyListScreen / boardListContextKind
  // 共用的「選單畫面」白名單。三處原本各抄一遍字面值。
  test("MENU_TITLES 就是那三個選單標題", () => {
    expect(MENU_TITLES).toEqual([MAIN_MENU, CLASS_LIST, ARCHIVE_LIST]);
  });

  test.each([
    "【主功能表】 主功能表",
    "【分類看板】 分類看板",
    "【精華文章】 精華文章",
    " 主功能表  Welcome",
    " 分類看板 ",
  ])("%s 命中 MENU_TITLES", (row) => {
    expect(rowHasAnyTitle(row, MENU_TITLES)).toBe(true);
  });

  // 看板列表與我的最愛**刻意不在** MENU_TITLES 裡：list_session 要它們，
  // 但 term_buf.setPageState 與 boardListContextKind 不要（board_list_parse
  // 的 classifyBoardListScreen 靠【看板列表】分辨自己該不該 engage）。
  test.each([BOARD_LIST, FAVOURITE])("%s 不在 MENU_TITLES", (name) => {
    expect(MENU_TITLES).not.toContain(name);
  });

  test.each([
    "【看板列表】 看板列表",
    " 文章選讀 ",
    "",
  ])("%s 不命中 MENU_TITLES", (row) => {
    expect(rowHasAnyTitle(row, MENU_TITLES)).toBe(false);
  });

  test("空值一律 false，不得 throw", () => {
    expect(rowHasAnyTitle(null, MENU_TITLES)).toBe(false);
    expect(rowHasAnyTitle("【主功能表】", null)).toBe(false);
    expect(rowHasAnyTitle("【主功能表】", [])).toBe(false);
  });
});
