// 手機信件列表卡片（P31，docs/mobile.md「信件列表卡片」）。只在 enhance.menuCards === 'mail'
// （手機＋信件列表，term_view._frameSurface）時由 render/screen.js#_renderRow 取代 buildRow；
// 桌機零改動（golden 快照不經過這裡）。版面、點擊、游標整套沿用主功能表大按鈕
// （render/menu_card.js）：外層同樣帶 data-menu-row ⇒ App.mouse_click 以 DOM 目標取列、
// 送原生「移游標＋⏎」（App._sendRowEnter），不經 clientToPos（卡片高 ≠ chh）。
//
// 兩行：標題（未讀粗體＋圓點、R:／轉 小標）；寄件人・日期。認不出的列（parseMailRow
// 回 null）照舊畫格線。
import cx from "classnames";
import { el } from "./dom";
import { rowToText } from "../js/comment_parse";
import { parseMailRow } from "../js/mail_list";

export const MAIL_CARD_PX = 60;

const KIND_TAG = { reply: "R:", forward: "轉" };

export function buildMailCard({ chars, row, highlightClass }) {
  const m = parseMailRow(rowToText(chars).replace(/\s+$/, ""));
  if (!m) return null;
  const tag = KIND_TAG[m.kind];
  return {
    node: el(
      "span",
      {
        type: "bbsrow",
        srow: row,
        class: cx("menuCard", "mailCard", m.unread && "mailCardUnread"),
        "data-menu-row": row,
      },
      el(
        "span",
        {
          class: cx("menuCardBody", "mailCardBody", highlightClass),
          "data-type": "bbsline",
          "data-row": row,
        },
        [
          el("span", { class: "mailCardTitle" }, [
            m.unread ? el("span", { class: "mailCardDot", "aria-hidden": "true" }) : null,
            tag ? el("span", { class: "mailCardTag" }, tag) : null,
            el("span", { class: "mailCardSubject" }, m.title),
          ]),
          el("span", { class: "mailCardMeta" }, m.author + " · " + m.date.trim()),
        ],
      ),
    ),
  };
}
