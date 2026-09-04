// pmore 「設定」畫面的偵測（src/js/pmore_pref.js）。
//
// 這是「離開設定頁 ⇒ 整篇重讀」的唯一觸發判準（easy_reading._evalFunctionModeExit），
// 判寬了會讓每個 prompt 退出時都重讀一次整篇，判窄了功能直接失效。
//
// 設定頁的三列是**真的**：逐字取自使用者提供的 debug 錄製檔（2026-09-04 兩份），
// 用真 TermBuf+AnsiParser 重放後 buf.getRowText 出來的樣子。row 21/22/23 = 快速設定頁的
// 標題／選項列／vmsg 提示列。文章那幾列同源，但帳號已換成佔位值（repo 是公開的）。
import {
  pmorePrefScreenSeen,
  parseRawModeFromPrefRow,
  rawModePrefRowVisible,
  rawModeKey,
  MFDISP_RAW_NA,
  MFDISP_RAW_NOANSI,
  MFDISP_RAW_PLAIN,
} from "../../src/js/pmore_pref";

// 快速設定頁（`\`）——錄製檔 step 4/5/6 的 row 21..23。
const QUICK_TITLE =
  " piaip's more: pmore 2007+ 快速設定 - 色彩(ANSI碼)顯示模式                      ";
const QUICK_PROMPT =
  " ◆ 請調整設定 (1-3 可直接選定，\\可切換) 或其它任意鍵結束。     [按任意鍵繼續]  ";
const optionRow = (sel) =>
  " \\ 色彩顯示方式:         1" +
  (sel === 0 ? "*" : " ") +
  "預設格式化內容 |2" +
  (sel === 1 ? "*" : " ") +
  "原始ANSI控制碼 |3" +
  (sel === 2 ? "*" : " ") +
  "純文字           ";

// 完整設定頁（`o`）——pmore.c 的 PMORE_MSG_PREF_TITLE + pmore_Preference 的選項。
const FULL_TITLE = " piaip's more: pmore 2007+ 設定選項 ";
const FULL_ROWS = [
  FULL_TITLE,
  optionRow(0),
  " w 斷行方式:             1 直接截行 |2*自動斷行",
  " m 斷行符號:             1*不顯示 |2 顯示",
];

// 說明頁（`h`）——標題不含「設定」二字，刻意不該命中。
const HELP_TITLE = " piaip's more: pmore 2007+ 瀏覽程式使用說明";

// 一般文章畫面（錄製檔 step 1 的幾列）。
const ARTICLE_ROWS = [
  " 作者  someuser (nick)                                            看板  Test   ",
  " 標題  [測試]                                                                   ",
  "中文測試3                                                                       ",
  "  瀏覽 第 1/1 頁 (100%)  目前顯示: 第 01~20 行  (y)回應(X%)推文(h)說明(←)離開  ",
];

const screen = (...rows) => {
  const s = new Array(24).fill("");
  rows.forEach((r, i) => (s[i] = r));
  return s;
};

describe("pmorePrefScreenSeen", () => {
  test("快速設定頁 → true（不綁死列號：畫在 row 21 也認得）", () => {
    const s = new Array(24).fill("");
    s[21] = QUICK_TITLE;
    s[22] = optionRow(0);
    s[23] = QUICK_PROMPT;
    expect(pmorePrefScreenSeen(s)).toBe(true);
  });

  test("完整設定頁 → true（`o` 的 w/l/t 同樣改變整篇行數，必須涵蓋）", () => {
    const s = new Array(24).fill("");
    FULL_ROWS.forEach((r, i) => (s[15 + i] = r));
    expect(pmorePrefScreenSeen(s)).toBe(true);
  });

  test("說明頁 → false（按 h 不該觸發整篇重讀）", () => {
    expect(pmorePrefScreenSeen(screen(HELP_TITLE))).toBe(false);
  });

  test("一般文章畫面 → false", () => {
    expect(pmorePrefScreenSeen(screen(...ARTICLE_ROWS))).toBe(false);
  });

  test("空輸入不炸", () => {
    expect(pmorePrefScreenSeen(null)).toBe(false);
    expect(pmorePrefScreenSeen([])).toBe(false);
  });
});

describe("parseRawModeFromPrefRow", () => {
  test("選中項的數字後面緊接 * → 0/1/2", () => {
    expect(parseRawModeFromPrefRow(screen(optionRow(0)))).toBe(MFDISP_RAW_NA);
    expect(parseRawModeFromPrefRow(screen(optionRow(1)))).toBe(
      MFDISP_RAW_NOANSI,
    );
    expect(parseRawModeFromPrefRow(screen(optionRow(2)))).toBe(
      MFDISP_RAW_PLAIN,
    );
  });

  test("非設定頁 → null", () => {
    expect(parseRawModeFromPrefRow(screen(...ARTICLE_ROWS))).toBe(null);
    expect(parseRawModeFromPrefRow(screen(HELP_TITLE))).toBe(null);
    expect(parseRawModeFromPrefRow(null)).toBe(null);
  });
});

describe("rawModePrefRowVisible（程式化切換第一步的完成判準）", () => {
  test("選項列出現 → true（快速設定頁與完整設定頁共用同一列）", () => {
    expect(rawModePrefRowVisible(screen(optionRow(0)))).toBe(true);
    const s = new Array(24).fill("");
    FULL_ROWS.forEach((r, i) => (s[15 + i] = r));
    expect(rawModePrefRowVisible(s)).toBe(true);
  });

  test("一般文章畫面 → false（沒進設定頁就絕不可以送數字鍵）", () => {
    expect(rawModePrefRowVisible(screen(...ARTICLE_ROWS))).toBe(false);
    expect(rawModePrefRowVisible(undefined)).toBe(false);
  });
});

describe("rawModeKey", () => {
  test("pmore 的直選鍵是 1/2/3（case '3' 立即 return，不需要 Enter）", () => {
    expect(rawModeKey(MFDISP_RAW_NA)).toBe("1");
    expect(rawModeKey(MFDISP_RAW_NOANSI)).toBe("2");
    expect(rawModeKey(MFDISP_RAW_PLAIN)).toBe("3");
    expect(rawModeKey(9)).toBe(null);
    expect(rawModeKey(null)).toBe(null);
  });
});
