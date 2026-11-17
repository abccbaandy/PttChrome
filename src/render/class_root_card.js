// 手機「分類看板」根目錄的大按鈕（P99）。只在 enhance.menuCards === 'classroot'（手機＋
// term_view._classRootCardsNow）時由 render/screen.js#_renderRow 取代 buildRow；桌機零改動。
//
// 版面同主功能表大按鈕（menu_card.js，P68）：左邊群組名稱大字（去掉 ◎ 前綴）、右邊說明
// 小字灰色、最右一個 ›。點擊同主功能表：data-menu-row 取列（mobile_layout.menuCardTargetRow），
// App 送「移游標＋⏎」，送之前驗游標列與目標列都是群組列（class_root.classRootCursorRowOk）。
// 保留的外部契約同 menu_card.js：外層 span[type=bbsrow][srow]、內層 [data-type=bbsline][data-row]。
import cx from "classnames";
import { el } from "./dom";
import { rowToText } from "../js/comment_parse";
import { parseClassRootRow } from "../js/class_root";

export function buildClassRootCard({ chars, row, highlightClass }) {
  const m = parseClassRootRow(rowToText(chars));
  if (!m) return null;
  const name = m.name.replace(/^◎\s*/, "") || m.name;
  return {
    node: el(
      "span",
      {
        type: "bbsrow",
        srow: row,
        class: cx("menuCard", "classRootCard"),
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
          el("span", { class: "menuCardName" }, name),
          m.desc ? el("span", { class: "menuCardEn classRootCardDesc" }, m.desc) : null,
          el("span", { class: "classRootCardChevron", "aria-hidden": "true" }, "›"),
        ],
      ),
    ),
  };
}
