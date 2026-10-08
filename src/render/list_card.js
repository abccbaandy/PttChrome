// 手機 Phase 4：列表好讀 body 列的卡片版（docs/mobile.md「Phase 4」）。
// 只在 term_view.listCards（手機＋列表好讀視窗）時由 render/screen.js#_renderRow 取代
// buildRow；桌機零改動（golden 快照不經過這裡）。
//
// 一筆 ＝ 固定 LIST_CARD_ROWS（2.5）個列高＝兩行內容＋0.5 列間距：list_scroll.js 的
// 位置↔scrollTop 換算是純乘除，卡片高一旦不固定整套捲動數學就失效（CSS `.listCard`
// 鎖 height: 2.5em，em ＝ chh；間距是 border-box 內的 padding-block）。
//
// 欄位一律**按 cell 切**（TermChar 陣列恆 80 格、DBCS 佔兩格）——不走 rowToText 的
// 字串索引，所以舊游標 ●／置底 ★ 這類全形前綴造成的位移（comment_parse.realignListColumns
// 要補的那件事）在這裡不存在。顏色沿用 LinkSegmentBuilder，與原列逐格同色。
// 欄位出處（不猜，CLAUDE.md）：
//   文章列表 pttbbs `mbbsd/bbs.c#readdoent`：%7d 序號 [0,7)、標記 [7,9)、推文數 [9,11)、
//     日期 %-6.5s [11,17)、作者 %-13.12s（12 字＋1 空白）[17,30)、標題（含 □/R:/轉
//     前綴）從 30 起。切點與 comment_parse 同一組（parseListAuthor [17,29)、
//     parseListTitleRaw 從 29 起）：col 29 恆為作者欄的補白，前後空白一律剪掉。
//   看板列表 pttbbs `mbbsd/board.c#brdlist_renderer`：%7d 序號 [0,7)、隱板字 [7]、
//     未讀 ˇ [8,10)、板名 %-13s [10,23)、類別 %5.5s [23,28)、◎ [28,30)、中文敘述
//     %-34.34s [30,64)、人氣 3 格 [64,67)、板主 [67,80)。目錄列／禁入列／分隔線的
//     前 30 格同形（brdlist_folder／brdlist_hidden／brdlist_separator）。
//
// 保留的外部契約（同 row.js 檔頭）：外層 span[type=bbsrow][srow]、data-list-author／
// data-list-title（右鍵加黑名單）、內層 [data-type=bbsline][data-row]（游標底色
// screen.js#_toggleRowClass 靠它，class 下在卡片本體 ⇒ 整張卡片上色）。
import cx from "classnames";
import { el } from "./dom";
import LinkSegmentBuilder from "./link_segment";
import {
  LIST_AUTHOR_COL_START,
  LIST_AUTHOR_COL_END,
  hasServerCursorMark,
} from "../js/comment_parse";

// [start, end) cell 範圍 → 一段上色的 DOM（沒有內容回 null）。邊界落在 DBCS 中間時
// 往外擴成完整的字；前後空白剪掉（卡片的欄位不需要補齊寬度，右對齊的序號也不必）。
export function cardSegment(chars, start, end, forceWidth, row, className) {
  const line = chars || [];
  let a = Math.max(0, start);
  let b = Math.min(line.length, end);
  if (a > 0 && line[a - 1] && line[a - 1].isLeadByte) a--;
  if (b > 0 && b < line.length && line[b - 1] && line[b - 1].isLeadByte) b++;
  while (b > a && isBlankCell(line[b - 1])) b--;
  while (a < b && isBlankCell(line[a])) a++;
  if (b <= a) return null;
  const builder = new LinkSegmentBuilder(row, false, forceWidth);
  for (let i = a; i < b; ++i) builder.readChar(line[i], i);
  return el("span", { class: className }, builder.build());
}

function isBlankCell(ch) {
  return (
    !ch ||
    ((ch.ch === " " || ch.ch === "" || ch.ch === "\u3000") && !ch.isLeadByte)
  );
}

// 兩種列表各自的「兩行裡放哪些 cell 範圍」。純資料，測試直接讀。
export const CARD_LAYOUT = {
  article: {
    // 標題一行；第二行＝原列的前段（序號・標記・推文數・日期）＋作者。
    title: [[LIST_AUTHOR_COL_END, 80, "listCardTitleText"]],
    meta: [
      [0, LIST_AUTHOR_COL_START, "listCardInfo"],
      [LIST_AUTHOR_COL_START, LIST_AUTHOR_COL_END, "listCardAuthor"],
    ],
  },
  board: {
    // 第一行：序號・未讀・板名・類別＋人氣；第二行：◎中文敘述＋板主。
    title: [
      [0, 28, "listCardInfo"],
      [64, 67, "listCardPopularity"],
    ],
    meta: [
      [28, 64, "listCardTitleText"],
      [67, 80, "listCardBM"],
    ],
  },
};

export function buildListCard({
  chars,
  row,
  kind,
  forceWidth,
  highlightClass,
  listAuthor,
  listTitle,
  listRead,
}) {
  const layout = CARD_LAYOUT[kind] || CARD_LAYOUT.article;
  // 游標記號（labelListCursor 的半形 `>`，舊 server 的全形 ● 佔兩格）蓋在 cell 0：
  // 它不是空白，cardSegment 剪不掉 ⇒ 連同後面 %7d 的補白一起留下，游標那張卡片整行
  // 右移。抽出來放進每張卡片都有的固定寬游標欄，欄位一律從記號之後切。
  const cursorCells = hasServerCursorMark(chars, 0)
    ? chars[0].isLeadByte
      ? 2
      : 1
    : 0;
  const line = (parts) =>
    parts.map(([a, b, cls]) =>
      cardSegment(chars, Math.max(a, cursorCells), b, forceWidth, row, cls),
    );
  return {
    node: el(
      "span",
      {
        type: "bbsrow",
        srow: row,
        class: "listCard",
        "data-list-author": listAuthor,
        "data-list-title": listTitle,
        "data-list-read": listRead ? "" : undefined,
      },
      el(
        "span",
        {
          class: cx("listCardBody", highlightClass),
          "data-type": "bbsline",
          "data-row": row,
        },
        [
          el("span", { class: "listCardLine listCardTitle" }, [
            el("span", { class: "listCardCursor" }, cursorCells ? ">" : " "),
            ...line(layout.title),
          ]),
          el("span", { class: "listCardLine listCardMeta" }, line(layout.meta)),
        ],
      ),
    ),
    slots: [],
  };
}

export default buildListCard;
