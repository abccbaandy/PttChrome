// 手機推文卡片：好讀文章換行版面（term_view.reflow，docs/mobile.md「推文卡片」）下，
// 推文列不再照 80 欄原樣 pre-wrap —— 那樣時間戳前面的一大段補位空白會先折行，時間
// 被擠到下一行最左邊。改成兩段：
//   標頭列  推/噓/→ ・樓號 ・id                    IP  時間（右靠、縮小淡化）
//   內容    完整內容，自然換行；同作者合併的每一則各一行
// 只在 enhance.commentCards（手機＋好讀長頁）時由 render/screen.js 取代 buildRow；桌機
// 零改動（golden 快照不經過這裡）。
//
// 欄位一律按 cell 切（comment_merge.commentContentCells 的邊界，推文格式出處見該檔檔頭）；
// 內容用 LinkSegmentBuilder 以**原本的欄號**讀 ⇒ fixedUrls／mentions／AID／預覽等
// 以欄位標記的範圍全部照舊對得上。時間與 IP 是一般文字，可選取複製。
//
// 保留的外部契約（同 row.js 檔頭）：
//   外層 span[type=bbsrow][srow][data-pusher][data-pusher-col]  —— .commentSpacing 的
//     直接子選擇器、長按選單的推文者黑名單（closest('[data-pusher]')）、點推文高亮、
//     pageRowTop／currentLineIndex 量 srow
//   [data-type=bbsline][data-row]  —— 選取反查、游標底色（標頭列＋內容每一行都有）
//   .floorBadge[data-floor]、textContent＝樓號  —— 樓層徽章（卡片裡改成一般行內字，
//     css `.commentCard .floorBadge`）
//   回傳 { node, slots }：slots 交給 screen.js#_adopt（延遲載入佔位盒的生命週期）
import cx from "classnames";
import { el } from "./dom";
import LinkSegmentBuilder from "./link_segment";
import { cardSegment } from "./list_card";
import { commentContentCells } from "../js/comment_merge";

const ASCII_ID_RE = /[0-9A-Za-z]/;

// id 的 cell 範圍 [3, idEnd)（推文格式：cols 0-1 型別符、col 2 空格、col 3 起 id）。
function idEndCol(chars) {
  let i = 3;
  while (i < chars.length && chars[i] && ASCII_ID_RE.test(chars[i].ch)) ++i;
  return i;
}

function floorBadge(floor) {
  const text = String(floor.seq);
  return el(
    "span",
    {
      class: "floorBadge",
      "data-floor": "true",
      title: `第${floor.seq}樓 ${floor.type}${floor.sub}`,
    },
    el("span", { class: "floorBadgeNum" }, text),
  );
}

// 單一推文列的區段；認不出推文形狀回 null（caller 退回 buildRow）。
export function commentCardRegions(chars) {
  const info = commentContentCells(chars);
  if (!info) return null;
  return {
    contentStart: info.start,
    contentEnd: info.end,
    tailStart: info.end,
    timeStart: info.timeStart,
    timeEnd: info.timeStart + info.time.length,
  };
}

// 合併推文塊（comment_merge.buildMergedCommentChars 的產物，ann.mergeCommentRun）的區段。
export function mergedCommentCardRegions(m) {
  if (!m || m.tailStart == null || m.timeStart == null) return null;
  return {
    contentStart: m.contentStart,
    contentEnd: m.tailStart,
    tailStart: m.tailStart,
    timeStart: m.timeStart,
    timeEnd: m.chars.length,
  };
}

export function buildCommentCard({
  chars,
  regions,
  row,
  forceWidth,
  enableLinkInlinePreview,
  highlightClass,
  floor,
  pusher,
  pusherContentCol,
  pusherHighlight,
  authorIdStart,
  fixedUrls,
  mentions,
  aids,
  giveaways,
  bareDomains,
  onHyperLinkMouseOver,
  onHyperLinkMouseOut,
  sizeMode,
}) {
  const r = regions;
  const idEnd = idEndCol(chars);
  const seg = (a, b, cls) => cardSegment(chars, a, b, forceWidth, row, cls);

  const head = el(
    "span",
    {
      class: cx("commentCardHead", highlightClass),
      "data-type": "bbsline",
      "data-row": row,
    },
    [
      seg(0, 2, "commentCardTag"),
      floor ? floorBadge(floor) : null,
      seg(
        3,
        idEnd,
        cx("commentCardId", { commentByAuthor: authorIdStart !== undefined }),
      ),
      el("span", { class: "commentCardMeta" }, [
        seg(r.tailStart, r.timeStart, "commentCardIp"),
        seg(r.timeStart, r.timeEnd, "commentCardTime"),
      ]),
    ],
  );

  // 內容：原欄號餵 LinkSegmentBuilder（連結範圍以欄號標記）。合併塊的換行 cell
  // 會讓 builder 自己分行（每行一個 bbsline＋預覽 div）。
  const builder = new LinkSegmentBuilder(
    row,
    enableLinkInlinePreview,
    forceWidth,
    highlightClass,
    undefined,
    onHyperLinkMouseOver,
    onHyperLinkMouseOut,
    undefined,
    undefined,
    undefined,
    fixedUrls,
    mentions,
    aids,
    giveaways,
    bareDomains,
    sizeMode,
  );
  for (let i = r.contentStart; i < r.contentEnd; ++i)
    builder.readChar(chars[i], i);

  return {
    node: el(
      "span",
      {
        type: "bbsrow",
        srow: row,
        "data-pusher": pusher,
        "data-pusher-col": pusherContentCol,
        class: cx("commentCard", { pusherHighlight }),
      },
      [head, el("span", { class: "commentCardText" }, builder.build())],
    ),
    slots: builder.slots,
  };
}

export default buildCommentCard;
