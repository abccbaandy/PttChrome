// pmore 的「設定」畫面偵測（純函式，無 DOM／無網路）。
//
// 為什麼需要它：pmore 的三種色彩顯示模式（`bpref.rawmode`）改變的是**整篇文章的
// 呈現與行數**，而好讀模式畫的是累積長頁（`buf.pageLines`）而不是當前 24 列。
// 離開設定頁時 PTT 只重畫「目前這一頁」，行號又常常與切換前相同 ⇒ 好讀的去重
// （`resolvePageOverlap`）判定「這一頁已經在累積裡了」而一列都不 append
// ⇒ 畫面完全沒變，使用者必須重進文章才看得到新模式。修法是離開設定頁後整篇重讀
// （easy_reading.js#_evalFunctionModeExit → reenterFromTop）。
//
// 判準用**畫面內容**而不是按鍵：改到 rawmode 的入口不只 `\`（快速設定），還有
// `o`（完整設定頁）裡的 `\`／`|`，以及 `1`/`2`/`3` 直選；完整設定頁的 `w`（斷行）／
// `l`（分隔線）／`t`（傳統狀態列）同樣改變整篇行數。按鍵層看不全，畫面層才看得全。
//
// pttbbs 事實（`mbbsd/pmore.c`，全部已由錄製檔實證，見 docs/pttbbs-screen-protocol.md）：
//   - 快速設定頁標題 `" piaip's more: pmore 2007+ 快速設定 - 色彩(ANSI碼)顯示模式 "`
//     （`pmore.c` 的 `PMORE_MSG_PREF_TITLE_QRAW`），畫在 `b_lines-2`＝24 列終端的 row 21；
//   - 完整設定頁標題 `" piaip's more: pmore 2007+ 設定選項 "`，畫在 `b_lines-9`＋
//     `PMORE_SHADOW_ABOVE` 的一列 `▔` ⇒ row 15；
//   - 說明頁標題是「瀏覽程式使用說明」，**不含「設定」** ⇒ 按 `h` 不會誤觸整篇重讀；
//   - 選項列由 `pmore_prefEntry` 畫成 `1*預設格式化內容 |2 原始ANSI控制碼 |3 純文字`，
//     **選中項的數字後面緊接 `*`**，未選是空白。
//
// 所以偵測**掃整個畫面、不綁死列號**（不同 `t_lines` 或版本都會位移）。
// 守護：tests/unit/pmore_pref_screen.test.js。

// bpref.rawmode 的三個值（pmore.c:525-528）。
export const MFDISP_RAW_NA = 0; // 預設格式化內容
export const MFDISP_RAW_NOANSI = 1; // 原始ANSI控制碼
export const MFDISP_RAW_PLAIN = 2; // 純文字

// 快速設定頁上「直選」該模式的按鍵（pmore.c:2990-2999 的 case '1'/'2'/'3'，
// 按下去**立即 return**，不需要 Enter）。
export const RAW_MODE_KEYS = ['1', '2', '3'];

export function rawModeKey(mode) {
  return RAW_MODE_KEYS[mode] || null;
}

// 現在停在 pmore 的「設定」畫面上嗎？（快速設定 or 完整設定；說明頁不算）
export function pmorePrefScreenSeen(rowTexts) {
  if (!rowTexts) return false;
  for (let i = 0; i < rowTexts.length; ++i) {
    const t = rowTexts[i];
    if (t && t.indexOf("piaip's more") >= 0 && t.indexOf('設定') >= 0)
      return true;
  }
  return false;
}

// 選項列上目前選中的是哪一個模式（0/1/2）；不是設定頁就回 null。
//
// 注意這是「**畫面上**選中的那一項」：`\` 循環時 PTT 會 patch 這幾格，所以跟得上；
// 但使用者按 `1`/`2`/`3` 直選時 pmore 直接 return、**不重畫選項列** ⇒ 這裡讀到的
// 仍是按鍵前的值。程式化切換因此要自己記下目標值（見 pttchrome.jsx#onLightsRawMode），
// 不能只靠這條路。
export function parseRawModeFromPrefRow(rowTexts) {
  if (!rowTexts) return null;
  for (let i = 0; i < rowTexts.length; ++i) {
    const t = rowTexts[i];
    if (!t || t.indexOf('色彩顯示方式') < 0) continue;
    if (/1\*/.test(t)) return MFDISP_RAW_NA;
    if (/2\*/.test(t)) return MFDISP_RAW_NOANSI;
    if (/3\*/.test(t)) return MFDISP_RAW_PLAIN;
    return null;
  }
  return null;
}

// 「這一幀是不是快速設定頁已經開好了」——程式化切換第一步（送 `\`）的完成判準。
// 用選項列而不是標題：完整設定頁也有同一個選項列，兩者都可以接著送數字鍵。
export function rawModePrefRowVisible(rowTexts) {
  if (!rowTexts) return false;
  for (let i = 0; i < rowTexts.length; ++i) {
    if (rowTexts[i] && rowTexts[i].indexOf('色彩顯示方式') >= 0) return true;
  }
  return false;
}
