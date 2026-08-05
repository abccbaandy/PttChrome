import cx from "classnames";
import LinkSegmentBuilder from "./LinkSegmentBuilder";
import { shouldForceWidth } from "./ColorSegmentBuilder";
import { forceWidthStyle } from "./WordSegmentBuilder/ForceWidthWord";

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
      out.push(<span key={out.length}>{run}</span>);
      run = "";
    }
  };
  for (let i = 0; i < text.length; ++i) {
    const ch = text[i];
    if (shouldForceWidth(ch)) {
      flush();
      out.push(
        <span
          key={out.length}
          className="wpadding"
          style={forceWidthStyle(forceWidth)}
        >
          {ch}
        </span>,
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
// listAuthor / listTitle: board-list row's author id / raw-case title (see
//   Screen#computeAnnotations) → exposed as data-list-author / data-list-title so
//   the right-click quick-add-blacklist menu can read the row under the cursor.
// pusherHighlight: true → this comment is by the currently selected pusher; tint
//   the WHOLE row via .pusherHighlight (char spans are b0/transparent, so the
//   tint shows through without overriding any ANSI colours).
// authorIdStart/authorIdEnd: cols [start, end) of the user id when this comment is
//   by the 原PO → wrap just the id in .commentByAuthor (see LinkSegmentBuilder).
// blacklistNotice: native-list blacklisted row → render this deleted-style notice
//   「(本文已被黑名單) <作者>」instead of the original char cells (see
//   Screen#computeAnnotations). Bypasses LinkSegmentBuilder (no links / colours), but
//   still forces full-width glyphs to two cells (noticeSegments) so it lines up with
//   the rest of the grid, cursor row included. Easy-reading list hides such rows
//   instead, so this only fires natively.
export const Row = ({
  chars,
  row,
  enableLinkInlinePreview,
  forceWidth,
  highlighted,
  floor,
  hidden,
  pusher,
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
}) => {
  if (blacklistNotice)
    return (
      <span type="bbsrow" srow={row}>
        {/* keep the native mouse-browse highlight (b2 green bar) on hover, same as
            every other native list row */}
        <span
          className={cx({ b2: highlighted })}
          data-type="bbsline"
          data-row={row}
        >
          {noticeSegments(blacklistNotice, forceWidth)}
        </span>
      </span>
    );
  return (
    <span
      type="bbsrow"
      srow={row}
      data-pusher={pusher}
      data-list-author={listAuthor}
      data-list-title={listTitle}
      className={pusherHighlight ? "pusherHighlight" : undefined}
      style={hidden ? { visibility: "hidden" } : undefined}
    >
      {chars
        .reduce(
          LinkSegmentBuilder.accumulator,
          new LinkSegmentBuilder(
            row,
            enableLinkInlinePreview,
            forceWidth,
            highlighted,
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
          ),
        )
        .build()}
    </span>
  );
};

export default Row;
