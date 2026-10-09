// 選單畫面判定（menu_items.js）：上半的 ANSI 圖／心情點播不可以被當成選單項
// （回歸：滑鼠移到 art 上會上底色、點下去送 ↑↓＋Enter 到別的項）；子選單（個人設定區…）
// 的標題列舉不完，靠狀態列（menu.c#show_status_bar，指紋＝string_util.parseListRow）認。
import { parseMenuItemRow, isMenuScreen } from "../../src/js/menu_items";
import {
  MAIN_MENU_ROWS,
  MAIN_MENU_ITEM_ROWS,
  MAIN_MENU_STATUS,
  SUBMENU_ROWS,
  SUBMENU_ITEM_ROWS,
} from "./fixtures/main_menu_rows";

const itemRows = (rows) =>
  rows.map((t, i) => (parseMenuItemRow(t) ? i : -1)).filter((i) => i >= 0);

test("主選單錄製畫面：只有 row 13–22 是選單項（含游標列），art／心情點播／分隔線都不是", () => {
  expect(itemRows(MAIN_MENU_ROWS)).toEqual(MAIN_MENU_ITEM_ROWS);
});

test("子選單：快捷鍵可以是數字（2FA），(X) 後面接什麼都行", () => {
  expect(itemRows(SUBMENU_ROWS)).toEqual(SUBMENU_ITEM_ROWS);
  expect(parseMenuItemRow(SUBMENU_ROWS[19])).toEqual({ key: "2" });
  expect(parseMenuItemRow(SUBMENU_ROWS[16])).toEqual({ key: "M" });
});

test("快捷鍵取 (X) 裡的字元", () => {
  expect(parseMenuItemRow(MAIN_MENU_ROWS[14])).toEqual({ key: "F" });
  expect(parseMenuItemRow(MAIN_MENU_ROWS[22])).toEqual({ key: "G" });
});

test("UF_CURSOR_LEGACY 的 ● 游標（stuff.c#cursor_show 寫 STR_CURSOR2）也認得", () => {
  expect(parseMenuItemRow(" ".repeat(20) + "●(F)avorite     【 我 的 最愛 】")).toEqual({
    key: "F",
  });
});

test("空列、非字串、行中出現的 (X) 都不是選單項", () => {
  expect(parseMenuItemRow(" ".repeat(80))).toBe(null);
  expect(parseMenuItemRow(undefined)).toBe(null);
  expect(parseMenuItemRow("│   功德經 (節錄)│")).toBe(null);
  expect(parseMenuItemRow("   1   + (A) 標題")).toBe(null);
});

describe("isMenuScreen", () => {
  test("主選單：標題就夠", () => {
    expect(isMenuScreen(1, MAIN_MENU_ROWS[0], "")).toBe(true);
  });

  // 狀態列指紋沿用 string_util.parseListRow（setPageState 判子選單用的同一個），
  // 兩種格式各自的細節在 string_util.test.js；這裡只鎖「接上了」。
  test("子選單：標題不在白名單，靠狀態列（新格式，剪掉線上人數）", () => {
    expect(isMenuScreen(1, SUBMENU_ROWS[0], SUBMENU_ROWS[23])).toBe(true);
    expect(isMenuScreen(1, SUBMENU_ROWS[0], "")).toBe(false);
  });

  test("子選單：舊格式狀態列（線上實測位元組，帳號為佔位）也認得", () => {
    expect(
      isMenuScreen(
        1,
        "【工具程式】",
        "9/10周四 17:09 [ 射手時 ]    線上25809人,我是bbsuser001,呼叫器開啟          (h)說明",
      ),
    ).toBe(true);
  });

  test("子選單標題配上非選單的狀態列 ⇒ 不是", () => {
    expect(
      isMenuScreen(1, SUBMENU_ROWS[0], " 文章選讀  (y)回應(X)推文(^X)轉錄 (=[]<>)相關主題 "),
    ).toBe(false);
  });

  test("分類看板根目錄：同一個狀態列，但它是看板列表", () => {
    expect(isMenuScreen(1, "【分類看板】                     批踢踢實業坊", MAIN_MENU_STATUS)).toBe(false);
    expect(isMenuScreen(1, "【看板列表】", MAIN_MENU_STATUS)).toBe(false);
  });

  test("pageState 不是 1 ⇒ 不是", () => {
    expect(isMenuScreen(2, MAIN_MENU_ROWS[0], MAIN_MENU_STATUS)).toBe(false);
  });
});
