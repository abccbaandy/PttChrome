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
//   - 選項列由 `pmore_prefEntry` 畫：快速設定頁 `1*預設格式化內容 |2 原始ANSI控制碼 |3 純文字`，
//     完整設定頁沒有數字熱鍵 ` *預設格式化內容 | 原始ANSI控制碼 | 純文字`；**選中項前面緊接 `*`**，
//     未選是空白（upstream 原始碼產的兩頁：tests/unit/ptt_src_screens.test.js「pmore 設定頁」）。
//
//   - 兩頁的標題都是 `pmore_PromptBar` 從 **col 0** 起印（caption 自帶開頭空白），
//     選項列是 `pmore_prefEntry` 的 `" " key " " text`（` \ 色彩顯示方式:`）同樣從 col 0，
//     等按鍵的是 `vmsg(...)` ⇒ **底列是 vmsg 橫幅**（` ◆ … [按任意鍵繼續]`）。
//   - 1/2/3 直選只在 `pmore_QuickRawModePref` 的 switch；`pmore_Preference`（完整設定頁）
//     沒有這三個 case，落 default ＝離開設定頁。
//
// 所以偵測**掃整個畫面、不綁死列號**（不同 `t_lines` 或版本都會位移），但指紋要三件
// 都到齊：col 0 的標題列、它下面 col 0 的「色彩顯示方式」選項列、底列 vmsg。文章內文
// 引用設定頁的字（教學文常見）時底列是 pmore 狀態列，三件湊不齊 ⇒ 認不出 ⇒ 什麼都不做。
// 守護：tests/unit/pmore_pref_screen.test.js、parse_failure_degrade.test.js。

import { parseVmsgText } from './push_screen';

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

// PMORE_MSG_PREF_TITLE／PMORE_MSG_PREF_TITLE_QRAW（pmore.c:129-132）。說明頁
// （「瀏覽程式使用說明」）不含「設定」，刻意不命中。
const PREF_TITLE_RE = /^ piaip's more: \S+ \S+ (?:設定選項|快速設定)/;
const QUICK_TITLE_RE = /^ piaip's more: \S+ \S+ 快速設定/;
// pmore_prefEntry：`" " key " " text`，key 是 `\`、text 是「色彩顯示方式:」。
const RAW_MODE_ROW_RE = /^ \\ 色彩顯示方式:/;

// 設定頁的列號（標題列）；指紋不齊回 -1。titleRe 決定認哪一種設定頁。
function prefTitleRow(rowTexts, titleRe) {
  if (!rowTexts || !rowTexts.length) return -1;
  if (parseVmsgText(rowTexts[rowTexts.length - 1]) === null) return -1;
  for (let i = 0; i < rowTexts.length - 1; ++i) {
    if (!titleRe.test(rowTexts[i] || '')) continue;
    for (let j = i + 1; j < rowTexts.length - 1; ++j)
      if (RAW_MODE_ROW_RE.test(rowTexts[j] || '')) return i;
    return -1;
  }
  return -1;
}

// 現在停在 pmore 的「設定」畫面上嗎？（快速設定 or 完整設定；說明頁不算）
export function pmorePrefScreenSeen(rowTexts) {
  return prefTitleRow(rowTexts, PREF_TITLE_RE) >= 0;
}

// 選項列上目前選中的是哪一個模式（0/1/2）；不是設定頁就回 null。
//
// 注意這是「**畫面上**選中的那一項」：`\` 循環時 PTT 會 patch 這幾格，所以跟得上；
// 但使用者按 `1`/`2`/`3` 直選時 pmore 直接 return、**不重畫選項列** ⇒ 這裡讀到的
// 仍是按鍵前的值。程式化切換因此要自己記下目標值（見 pttchrome.jsx#onLightsRawMode），
// 不能只靠這條路。
//
// 兩頁的選項寫法不同（pmore.c#pmore_prefEntry：選項字串帶 `N.` 才印數字熱鍵）：
//   快速設定  `1*預設格式化內容 |2 原始ANSI控制碼 |3 純文字`
//   完整設定  ` *預設格式化內容 | 原始ANSI控制碼 | 純文字`（沒有數字）
// ⇒ 以「第幾段選項帶 `*`」為準，不看數字。段數不是 3、或 `*` 不是恰好一個 ⇒ 認不出回 null。
export function parseRawModeFromPrefRow(rowTexts) {
  if (!rowTexts) return null;
  for (let i = 0; i < rowTexts.length; ++i) {
    const t = rowTexts[i];
    if (!t || !RAW_MODE_ROW_RE.test(t)) continue;
    const options = t.replace(RAW_MODE_ROW_RE, '').split('|');
    if (options.length !== 3) return null;
    const marked = [];
    options.forEach((o, idx) => {
      if (o.indexOf('*') >= 0) marked.push(idx);
    });
    return marked.length === 1 ? marked[0] : null;
  }
  return null;
}

// 「這一幀是不是快速設定頁已經開好了」——程式化切換第一步（送 `\`）的完成判準，
// 通過了才送數字鍵。只認**快速設定頁**：完整設定頁的 1/2/3 不是直選（落 default
// 離開設定頁），文章裡的 1/2/3 更是「跳至第 N 頁」。
export function rawModePrefRowVisible(rowTexts) {
  return prefTitleRow(rowTexts, QUICK_TITLE_RE) >= 0;
}
