// 手機版面收起來的列（docs/mobile.md「收起終端機標頭／狀態列」）：保留外部契約
// （外層 span[type=bbsrow][srow]、內層 [data-type=bbsline][data-row]，選取複製反查與
// 游標底色都靠它），但不佔高度（main.css `.mobileCollapsedRow` display:none）。
//
// 用在：選單大按鈕的空白列與標題／狀態列、列表卡片的 header／footer、好讀文章檔頭的
// 分隔線。每一處都只看「該列自己」決定要不要收 ⇒ dirty-row patch 的列獨立前提不破
// （screen_annotations.annotationsAreRowIndependent 不必動）。
//
// `extraClass`：呼叫端自己的語意 class（`menuBlankRow`），測試與 CSS 用來分辨來源。
import { el } from "./dom";

export function buildCollapsedRow(row, extraClass) {
  return el(
    "span",
    {
      type: "bbsrow",
      srow: row,
      class: "mobileCollapsedRow" + (extraClass ? " " + extraClass : ""),
    },
    el("span", { "data-type": "bbsline", "data-row": row }),
  );
}
