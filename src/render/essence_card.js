// 手機精華區卡片（P88，docs/mobile.md「精華區卡片」）。只在 enhance.menuCards === 'essence'
// （手機＋精華區列表，term_view._frameSurface）時由 render/screen.js#_renderRow 取代 buildRow；
// 桌機零改動（golden 快照不經過這裡）。版面、點擊、游標整套沿用信件卡片／主功能表大按鈕
// （render/mail_card.js）：外層帶 data-menu-row ⇒ App.mouse_click 以 DOM 目標取列、送原生
// 「移游標＋⏎」（App._sendRowEnter），不經 clientToPos（卡片高 ≠ chh）。
//
// 兩行：圖示＋標題（目錄是資料夾＋右邊 ›）；編選者・日期。認不出的列（parseEssenceRow
// 回 null）照舊畫格線。row 0（標題列）改畫一列小字「Gossip 精華區 › 目前這一層」。
import cx from "classnames";
import { el } from "./dom";
import { rowToText } from "../js/comment_parse";
import { essenceCrumb, parseEssenceRow } from "../js/essence_list";
import { i18n } from "../js/i18n";

export const ESSENCE_CARD_PX = 60;

const ICON = { dir: "📁", file: "📄", other: "📄" };

export function buildEssenceCard({ chars, row, highlightClass }) {
  const m = parseEssenceRow(rowToText(chars).replace(/\s+$/, ""));
  if (!m) return null;
  const dir = m.kind === "dir";
  const meta = (dir ? i18n("essence_dir") + " · " : "") + m.editor + " · " + m.date;
  return {
    node: el(
      "span",
      {
        type: "bbsrow",
        srow: row,
        class: cx("menuCard", "essenceCard", dir && "essenceCardDir"),
        "data-menu-row": row,
      },
      el(
        "span",
        {
          class: cx("menuCardBody", "essenceCardBody", highlightClass),
          "data-type": "bbsline",
          "data-row": row,
        },
        [
          el("span", { class: "essenceCardIcon", "aria-hidden": "true" }, ICON[m.kind]),
          el("span", { class: "essenceCardText" }, [
            el("span", { class: "essenceCardTitle" }, m.title),
            el("span", { class: "essenceCardMeta" }, meta),
          ]),
          dir ? el("span", { class: "essenceCardChevron", "aria-hidden": "true" }, "›") : null,
        ],
      ),
    ),
  };
}

// 標題列（row 0）→ 一列小字的所在位置。外部契約同 collapsed_row（bbsrow／bbsline／data-row）。
export function buildEssenceCrumb({ chars, row }) {
  const c = essenceCrumb(rowToText(chars));
  const head = (c.board ? c.board + " " : "") + i18n("essence_crumb");
  const text = c.title ? head + " › " + c.title : head;
  return el(
    "span",
    { type: "bbsrow", srow: row, class: "essenceCrumb" },
    el("span", { "data-type": "bbsline", "data-row": row }, text),
  );
}
