// 手機推文卡片：好讀文章換行版面（term_view.reflow，docs/mobile.md「推文卡片」）下，
// 推文列不再照 80 欄原樣 pre-wrap —— 那樣時間戳前面的一大段補位空白會先折行，時間
// 被擠到下一行最左邊。版型是兩段：
//   推/噓/→ id 樓號 ……………………………… IP 時間   ← 標頭一行（時間靠右）
//   內容（滿寬、自然換行；同作者合併的每一則另起一行）
// 作者跟內容分開 ⇒ 內容吃整個寬度，合併推文（一個標頭、多則內容）一眼看得出是同一人。
// 冒號不畫（標頭與內容已分行）。
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
//     IP／時間在標頭的 bbsline 裡（.commentCardMeta）
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
  authorIdKind,
  mentionsSelf,
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

  const meta = el("span", { class: "commentCardMeta" }, [
    seg(r.tailStart, r.timeStart, "commentCardIp"),
    seg(r.timeStart, r.timeEnd, "commentCardTime"),
  ]);
  const head = el(
    "span",
    {
      class: cx("commentCardHead", highlightClass),
      "data-type": "bbsline",
      "data-row": row,
    },
    [
      seg(0, 2, "commentCardTag"),
      seg(
        3,
        idEnd,
        cx("commentCardId", {
          commentByAuthor: authorIdStart !== undefined && authorIdKind !== "self",
          commentBySelf: authorIdKind === "self",
        }),
      ),
      floor ? floorBadge(floor) : null,
      meta,
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
        class: cx("commentCard", { pusherHighlight, mentionsSelf }),
      },
      [head, el("span", { class: "commentCardText" }, builder.build())],
    ),
    slots: builder.slots,
  };
}

// 長按選單的「複製推文」（docs/mobile.md「推文卡片」）：推文內容從卡片左緣起、第一個字
// 貼著螢幕邊，選取把手拉不過去（還會跟系統的邊緣返回手勢搶）⇒ 不靠選取，直接讀卡片。
// 內容每則一個 bbsline（合併塊的換行 cell 由 LinkSegmentBuilder 切行）；預覽 div 沒有
// bbsline，不會混進來。畫面每格的空白是 &nbsp;，換回一般空白。
//   line  手指下那一則（單則卡片＝唯一那則；合併塊按在標頭上＝null，不知道是哪一則）
//   all   整張卡片的內容，每則一行
//   count 則數（>1 ＝合併塊，選單多給「複製整段」）
// 不在推文卡片上 ⇒ null（桌機沒有卡片，這個選項永遠不出現）。
const cardLineText = (node) =>
  node.textContent.replace(/ /g, " ").trim();

export function commentCardCopyText(target) {
  const card =
    target && target.closest ? target.closest(".commentCard") : null;
  if (!card) return null;
  const body = card.querySelector(":scope > .commentCardText");
  if (!body) return null;
  const lineNodes = Array.from(
    body.querySelectorAll('[data-type="bbsline"]'),
  ).filter((n) => cardLineText(n));
  if (!lineNodes.length) return null;
  const hit = target.closest('[data-type="bbsline"]');
  const line =
    lineNodes.length === 1
      ? cardLineText(lineNodes[0])
      : hit && lineNodes.includes(hit)
        ? cardLineText(hit)
        : null;
  return {
    line,
    all: lineNodes.map(cardLineText).join("\n"),
    count: lineNodes.length,
  };
}

export default buildCommentCard;
