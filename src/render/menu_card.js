// 手機主功能表的大按鈕（docs/mobile.md「Phase 5」）。只在 enhance.menuCards（手機＋
// 主功能表，term_view.menuCards）時由 render/screen.js#_renderRow 取代 buildRow；
// 桌機零改動（golden 快照不經過這裡）。
//
// 只換**選單項列**（menu_items.parseMenuItemRow，依據 mbbsd/menu.c#menu_renderer）：
// 上半的 ANSI 圖／心情點播、標題列、狀態列照舊是縮小的 80 欄格線（使用者定案：
// 保留縮小在上方）。按鈕高 MENU_CARD_PX（CSS `.menuCard` 同值，unit 守），字級固定
// MOBILE_ROW_FONT_PX —— 不跟著 .main 的 font-size（＝塞滿寬的 chh，約 10px）走。
//
// 文字刻意**不走 LinkSegmentBuilder**：它的全形字盒（`.wpadding`）寬度被
// term_view.fixedResize 直接改成 chh px，放進 16px 的按鈕會疊字。選單項只有
// `(X)desc` 一種內容，沒有連結可言。
//
// 保留的外部契約（同 row.js 檔頭）：外層 span[type=bbsrow][srow]、內層
// [data-type=bbsline][data-row]（游標底色 screen.js#_toggleRowClass 靠它，class 下在
// 按鈕本體 ⇒ 整顆按鈕上色）。另加 data-menu-row：點擊由 DOM 目標取列
// （mobile_layout.menuCardTargetRow），不經 clientToPos（按鈕高 ≠ chh）。
import cx from "classnames";
import { el } from "./dom";
import { rowToText } from "../js/comment_parse";
import { parseMenuItemRow } from "../js/menu_items";
import { buildCollapsedRow } from "./collapsed_row";

export const MENU_CARD_PX = 44;

// 選單項 → { key, desc }；不是選單項回 null。desc ＝ `(X)` 之後的整段（保留中間的
// 對齊空白，按鈕用 white-space: pre，各項 (X) 起點一致 ⇒ 中文名稱仍對齊）。
export function menuCardParts(chars) {
  const text = rowToText(chars).replace(/\s+$/, "");
  const item = parseMenuItemRow(text);
  if (!item) return null;
  const open = text.indexOf("(" + item.key + ")");
  return { key: item.key, desc: text.slice(open + 3) };
}

// 這一列是不是整列空白（menuCards 模式下收起來，讓出高度給按鈕）。
export function isBlankRow(chars) {
  return !rowToText(chars).trim();
}

export function buildMenuCard({ chars, row, highlightClass }) {
  const parts = menuCardParts(chars);
  if (!parts) return null;
  return {
    node: el(
      "span",
      {
        type: "bbsrow",
        srow: row,
        class: "menuCard",
        "data-menu-row": row,
      },
      el(
        "span",
        {
          class: cx("menuCardBody", highlightClass),
          "data-type": "bbsline",
          "data-row": row,
        },
        [
          el("span", { class: "menuCardKey" }, "(" + parts.key + ")"),
          el("span", { class: "menuCardDesc" }, parts.desc),
        ],
      ),
    ),
  };
}

// menuCards 模式的空白列：保留 bbsrow／data-row 契約，但不佔高度（共用 collapsed_row.js）。
export function buildMenuBlankRow(row) {
  return buildCollapsedRow(row, "menuBlankRow");
}
