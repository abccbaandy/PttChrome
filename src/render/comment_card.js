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
import {
  rowToText,
  parseModernCommentHeader,
  cellColOf,
} from "../js/comment_parse";
import { i18n } from "../js/i18n";

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
// P82（pref mergedCommentEachTime）：m.lineTails 有值 ⇒ 每一則的段尾都留在 chars 裡
// （comment_merge opts.eachTime）。卡片版型：標頭的 IP／時間改用**第一則**的（它就接在
// 標頭下面那一行），第二則起的段尾從內容裡拿掉、改在那一行右邊畫淡灰「時:分」。
export function mergedCommentCardRegions(m) {
  if (!m || m.tailStart == null || m.timeStart == null) return null;
  const lt = m.lineTails;
  if (lt && lt.length >= 2 && lt.every(Boolean)) {
    return {
      contentStart: m.contentStart,
      contentEnd: m.tailStart,
      tailStart: lt[0].tailStart,
      timeStart: lt[0].timeStart,
      timeEnd: lt[0].timeEnd,
      lineTails: lt,
    };
  }
  return {
    contentStart: m.contentStart,
    contentEnd: m.tailStart,
    tailStart: m.tailStart,
    timeStart: m.timeStart,
    timeEnd: m.chars.length,
  };
}

// 段尾的「時:分」那幾格：時間戳是 "M/DD HH:MM"（月份 1～2 位），取空白之後。
function hourMinuteStart(chars, timeStart, timeEnd) {
  for (let i = timeStart; i < timeEnd; ++i)
    if (chars[i] && chars[i].ch === " ") return i + 1;
  return timeStart;
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
  newCommentsStart,
  justPushed,
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
          commentByAuthor:
            authorIdStart !== undefined &&
            authorIdKind !== "self" &&
            authorIdKind !== "follow",
          commentBySelf: authorIdKind === "self",
          commentByFollow: authorIdKind === "follow",
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
  // 每則標時間：第 1～n-1 則的段尾不進內容（末則的段尾本來就在 contentEnd 之後）。
  const tails = r.lineTails ? r.lineTails.slice(0, -1) : null;
  let t = 0;
  for (let i = r.contentStart; i < r.contentEnd; ++i) {
    if (tails && t < tails.length && i >= tails[t].tailStart) {
      if (i < tails[t].timeEnd) continue;
      ++t;
    }
    builder.readChar(chars[i], i);
  }
  const text = builder.build();
  if (r.lineTails) {
    // builder 的多行輸出：每行一個 [data-type=bbsline]（依序）。第二行起在行首放一個
    // 靠右浮動的「時:分」（浮動元素要排在同一行的文字前面才會跟它同一行）。
    // 字畫在 ::before（data-time）：長按「複製推文」、選取複製都只拿到內容，不夾時間。
    const lines = [...text.children].filter(
      (n) => n.getAttribute && n.getAttribute("data-type") === "bbsline",
    );
    for (let k = 1; k < r.lineTails.length && k < lines.length; ++k) {
      const lt = r.lineTails[k];
      let hm = "";
      for (let i = hourMinuteStart(chars, lt.timeStart, lt.timeEnd); i < lt.timeEnd; ++i)
        hm += chars[i] ? chars[i].ch : "";
      if (!hm) continue;
      lines[k].insertBefore(
        el("span", { class: "commentCardLineTime", "data-time": hm }),
        lines[k].firstChild,
      );
    }
  }

  return {
    node: el(
      "span",
      {
        type: "bbsrow",
        srow: row,
        "data-pusher": pusher,
        "data-pusher-col": pusherContentCol,
        class: cx("commentCard", { pusherHighlight, mentionsSelf, newCommentsStart, justPushed }),
        "data-new-comments": newCommentsStart ? i18n("new_comments_divider") : undefined,
      },
      [head, el("span", { class: "commentCardText" }, text)],
    ),
    slots: builder.slots,
  };
}

// ---------------------------------------------------------------------------
// 新格式推文（P60，pref mobileModernCommentCards；格式見 comment_parse.parseModernCommentHeader
// 檔頭，兩代都吃）。一則推文跨多列，每列仍是自己的 bbsrow（dirty-row patch 的列獨立前提）：
//   標頭列 → .commentCard.modernCommentCard：「id #樓號（已編輯）…… IP 日期 時間」＋內容
//            （87c3a1f3 之後內容就在標頭列上；之前的「[N] id … creation」標頭列沒有內容）
//   續行   → .commentCard.commentCardCont：只有內容（從 ann.modernBodyCol 讀）
// 分隔線畫在標頭卡片的**上緣**（續行不知道自己是不是最後一列，畫在下緣會切開同一則）。
// 刪除的推文（「留言已刪除」「留言已隱藏 (…)」「留言不顯示 (…)」）內容灰色。
// 欄位一律換算成 cell（cellColOf），內容照原欄號餵 LinkSegmentBuilder（連結範圍照舊）。

const MODERN_SEQ_TAIL_RE = /\[(~?)(\d+)\]\s*$/;
const MODERN_TIME_TAIL_RE =
  /(?:\d{1,3}(?:\.\d{1,3}){3} )?\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}\s*$/;

// 標頭列的區段（cell 空間，半開）；認不出回 null（caller 退回 buildRow）。
export function modernCommentCardRegions(chars) {
  const text = rowToText(chars);
  const h = parseModernCommentHeader(text);
  if (!h) return null;
  const idStart = h.idCol;
  const idEnd = idStart + h.user.length;
  let contentStart = null;
  let contentEnd = null;
  let metaStart = null;
  let metaEnd = null;
  let edited = false;
  if (h.bodyCol != null) {
    // 87c3a1f3 之後：「id: 內容 …… meta [N]」。id／空白／冒號都是半形 ⇒ 字元索引＝cell。
    const seq = MODERN_SEQ_TAIL_RE.exec(text);
    if (!seq) return null;
    edited = seq[1] === "~";
    const contentEndIdx = h.bodyCol + h.content.length;
    contentStart = h.bodyCol;
    contentEnd = cellColOf(text, contentEndIdx);
    metaStart = contentEnd;
    metaEnd = cellColOf(text, seq.index);
  } else {
    // 768b172a 之前：「[N] id …… creation」或「[N] id 留言已刪除」，內容在後面的「│」列。
    const t = MODERN_TIME_TAIL_RE.exec(text);
    const afterId = text.indexOf(h.user, 0) + h.user.length;
    if (h.deleted) {
      const at = text.indexOf(h.deleted, afterId);
      contentStart = cellColOf(text, at);
      contentEnd = cellColOf(text, at + h.deleted.length);
    } else if (t) {
      metaStart = cellColOf(text, t.index);
      metaEnd = cellColOf(text, text.trimEnd().length);
    }
  }
  // 年份不畫（卡片寬度有限；同舊格式推文只有「月/日 時間」）：記下「/YYYY」那 5 格。
  let yearStart = null;
  if (metaStart != null) {
    const re = /\d{2}\/\d{2}(\/\d{4}) /g;
    let ym;
    while ((ym = re.exec(text))) {
      const col = cellColOf(text, ym.index + 5);
      if (col >= metaStart && col < metaEnd) yearStart = col;
    }
  }
  return {
    seq: h.seq,
    yearStart,
    edited,
    deleted: !!h.deleted,
    idStart,
    idEnd,
    contentStart,
    contentEnd,
    metaStart,
    metaEnd,
  };
}

function modernSeqBadge(seq) {
  return el(
    "span",
    { class: "floorBadge", "data-floor": "true", title: `第${seq}樓` },
    el("span", { class: "floorBadgeNum" }, String(seq)),
  );
}

function authorIdClasses(authorIdStart, authorIdKind) {
  return {
    commentByAuthor:
      authorIdStart !== undefined &&
      authorIdKind !== "self" &&
      authorIdKind !== "follow",
    commentBySelf: authorIdKind === "self",
    commentByFollow: authorIdKind === "follow",
  };
}

function contentBuilder(o, chars, start, end) {
  const builder = new LinkSegmentBuilder(
    o.row,
    o.enableLinkInlinePreview,
    o.forceWidth,
    o.highlightClass,
    undefined,
    o.onHyperLinkMouseOver,
    o.onHyperLinkMouseOut,
    undefined,
    undefined,
    undefined,
    o.fixedUrls,
    o.mentions,
    o.aids,
    o.giveaways,
    o.bareDomains,
    o.sizeMode,
  );
  for (let i = start; i < end; ++i) builder.readChar(chars[i], i);
  return builder;
}

// 尾端空白不讀（pre-wrap 會把補位空白折成空行）。
function trimmedEnd(chars, start, end) {
  let b = Math.min(end, chars.length);
  while (b > start && chars[b - 1] && !chars[b - 1].isLeadByte && /^[ \u3000]?$/.test(chars[b - 1].ch)) b--;
  return b;
}

export function buildModernCommentCard(o) {
  const { chars, regions: r, row } = o;
  const seg = (a, b, cls) => cardSegment(chars, a, b, o.forceWidth, row, cls);
  const head = el(
    "span",
    {
      class: cx("commentCardHead", o.highlightClass),
      "data-type": "bbsline",
      "data-row": row,
    },
    [
      seg(
        r.idStart,
        r.idEnd,
        cx("commentCardId", authorIdClasses(o.authorIdStart, o.authorIdKind)),
      ),
      modernSeqBadge(r.seq),
      r.edited
        ? el("span", { class: "commentCardEdited" }, i18n("commentCard_edited"))
        : null,
      r.metaStart != null
        ? el(
            "span",
            { class: "commentCardMeta" },
            r.yearStart != null
              ? [
                  seg(r.metaStart, r.yearStart, "commentCardTime"),
                  seg(r.yearStart + 5, r.metaEnd, "commentCardClock"),
                ]
              : [seg(r.metaStart, r.metaEnd, "commentCardTime")],
          )
        : null,
    ],
  );
  let slots = [];
  const kids = [head];
  if (r.contentStart != null) {
    const end = trimmedEnd(chars, r.contentStart, r.contentEnd);
    const builder = contentBuilder(o, chars, r.contentStart, end);
    kids.push(
      el(
        "span",
        { class: cx("commentCardText", { commentCardDeleted: r.deleted }) },
        builder.build(),
      ),
    );
    slots = builder.slots;
  }
  return {
    node: el(
      "span",
      {
        type: "bbsrow",
        srow: row,
        "data-pusher": o.pusher,
        class: cx("commentCard", "modernCommentCard", {
          pusherHighlight: o.pusherHighlight,
          mentionsSelf: o.mentionsSelf,
          newCommentsStart: o.newCommentsStart,
          justPushed: o.justPushed,
        }),
        "data-new-comments": o.newCommentsStart
          ? i18n("new_comments_divider")
          : undefined,
      },
      kids,
    ),
    slots,
  };
}

// 續行：只有內容。bodyCol 之前是縮排（空白或「│」）。
export function buildModernCommentCont(o) {
  const { chars, row, bodyCol } = o;
  if (bodyCol == null || !chars || bodyCol >= chars.length) return null;
  const end = trimmedEnd(chars, bodyCol, chars.length);
  if (end <= bodyCol) return null;
  const builder = contentBuilder(o, chars, bodyCol, end);
  return {
    node: el(
      "span",
      {
        type: "bbsrow",
        srow: row,
        class: cx("commentCard", "commentCardCont", {
          mentionsSelf: o.mentionsSelf,
        }),
      },
      [el("span", { class: "commentCardText" }, builder.build())],
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
