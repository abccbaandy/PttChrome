// 一列 → DOM。原 src/components/Row/index.jsx 的純 JS 版。
//
// 產出的外層 <span type="bbsrow" srow=…> 與內層 <span data-type="bbsline"
// data-row=…> 是**外部契約**（不是實作細節）：
//   data-type/data-row  term_view.getRowLineElement → countCol → getSelectionColRow
//                       （滑鼠選取／ANSI 複製的 row/col 反查）
//   type/srow           main.css 的合併塊排版與 #mainContainer > span 的 display:block
//   data-pusher(-col)   pttchrome 的點推文列高亮 + 滑鼠防誤觸欄位判定
//   data-list-author/-title  右鍵快速加黑名單
// 動它們之前先看 CLAUDE.md 與 tests/unit/fixtures/screen_golden/。
import cx from "classnames";
import { el } from "./dom";
import LinkSegmentBuilder from "./link_segment";
import { shouldForceWidth } from "./color_segment";
import { forceWidthStyle } from "./word_segment";

// Render a plain notice string (blacklistNotice) into the same monospace grid the
// normal char path uses: ASCII/narrow chars flow as text, full-width glyphs (●, □,
// CJK …) get an explicit inline-block of `forceWidth` px so they occupy exactly two
// cells and line up with every other row. Narrow runs are grouped into one span to
// keep the node count small.
function noticeSegments(text, forceWidth) {
  const out = [];
  let run = "";
  const flush = () => {
    if (run) {
      out.push(el("span", null, run));
      run = "";
    }
  };
  for (let i = 0; i < text.length; ++i) {
    const ch = text[i];
    if (shouldForceWidth(ch)) {
      flush();
      out.push(
        el(
          "span",
          { class: "wpadding", style: forceWidthStyle(forceWidth) },
          ch,
        ),
      );
    } else {
      run += ch;
    }
  }
  flush();
  return out;
}

// floor: { seq, sub, type } | undefined  → render a floor badge before the line.
// hidden: true → blacklisted row; keep the bbsrow (so the fixed terminal grid
//   stays aligned) but hide its content. The easy-reading path drops the row
//   entirely instead of passing hidden, so there it occupies no space at all.
// pusher: lower-cased comment author id (when this row is a 推/噓/→ line) →
//   exposed as data-pusher so a click can highlight all rows by the same pusher.
// pusherContentCol: 該推文列內容文字的起始欄 → data-pusher-col。滑鼠的防誤觸模式
//   用它把左邊「型別符＋id＋冒號」排除在可點區之外（App.mouse_click），好把 cols
//   0-6 還給文章的左側退出帶。
// highlightColStart: 底色從第幾欄畫起（0/undefined＝整列）。與可點區同源，見
//   js/mouse_regions.clickableColStart 與 LinkSegmentBuilder 的包裝邏輯。
// listAuthor / listTitle: board-list row's author id / raw-case title (see
//   js/screen_annotations#computeAnnotations) → exposed as data-list-author /
//   data-list-title so the right-click quick-add-blacklist menu can read the row
//   under the cursor.
// pusherHighlight: true → this comment is by the currently selected pusher; tint
//   the WHOLE row via .pusherHighlight (char spans are b0/transparent, so the
//   tint shows through without overriding any ANSI colours).
// authorIdStart/authorIdEnd: cols [start, end) of the user id when this comment is
//   by the 原PO → wrap just the id in .commentByAuthor (see LinkSegmentBuilder).
// blacklistNotice: native-list blacklisted row → render this deleted-style notice
//   「(本文已被黑名單) <作者>」instead of the original char cells. Bypasses
//   LinkSegmentBuilder (no links / colours), but still forces full-width glyphs to
//   two cells (noticeSegments) so it lines up with the rest of the grid, cursor row
//   included. Easy-reading list hides such rows instead, so this only fires natively.
//
// 回傳 { node, slots }：slots ＝ 這一列建立的延遲載入佔位盒，renderer 換掉這一列
// 時**必須**逐一 destroy()（React 卸載時自動做的事，純 JS 要自己做）。
export function buildRow({
  chars,
  row,
  enableLinkInlinePreview,
  forceWidth,
  highlightClass,
  highlightColStart,
  floor,
  hidden,
  pusher,
  pusherContentCol,
  listAuthor,
  listTitle,
  pusherHighlight,
  authorIdStart,
  authorIdEnd,
  fixedUrls,
  mentions,
  aids,
  giveaways,
  bareDomains,
  blacklistNotice,
  onHyperLinkMouseOver,
  onHyperLinkMouseOut,
  sizeMode,
}) {
  if (blacklistNotice) {
    return {
      node: el("span", { type: "bbsrow", srow: row }, [
        // keep the cursor highlight bar on this row too, same as every other
        // native list row (colour comes from the pref — see cursor_highlight.js)
        el(
          "span",
          {
            class: cx(highlightClass),
            "data-type": "bbsline",
            "data-row": row,
          },
          noticeSegments(blacklistNotice, forceWidth),
        ),
      ]),
      slots: [],
    };
  }

  const builder = new LinkSegmentBuilder(
    row,
    enableLinkInlinePreview,
    forceWidth,
    highlightClass,
    highlightColStart,
    onHyperLinkMouseOver,
    onHyperLinkMouseOut,
    floor,
    authorIdStart,
    authorIdEnd,
    fixedUrls,
    mentions,
    aids,
    giveaways,
    bareDomains,
    sizeMode,
  );
  for (let i = 0; i < chars.length; ++i) builder.readChar(chars[i], i);

  return {
    node: el(
      "span",
      {
        type: "bbsrow",
        srow: row,
        "data-pusher": pusher,
        "data-pusher-col": pusherContentCol,
        "data-list-author": listAuthor,
        "data-list-title": listTitle,
        class: pusherHighlight ? "pusherHighlight" : undefined,
        style: hidden ? { visibility: "hidden" } : undefined,
      },
      builder.build(),
    ),
    slots: builder.slots,
  };
}

export default buildRow;
