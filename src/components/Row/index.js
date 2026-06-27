import LinkSegmentBuilder from "./LinkSegmentBuilder";

// floor: { seq, sub, type } | undefined  → render a floor badge before the line.
// hidden: true → blacklisted row; keep the bbsrow (so the fixed terminal grid
//   stays aligned) but hide its content. The easy-reading path drops the row
//   entirely instead of passing hidden, so there it occupies no space at all.
// pusher: lower-cased comment author id (when this row is a 推/噓/→ line) →
//   exposed as data-pusher so a click can highlight all rows by the same pusher.
// pusherHighlight: true → this comment is by the currently selected pusher; tint
//   the WHOLE row via .pusherHighlight (char spans are b0/transparent, so the
//   tint shows through without overriding any ANSI colours).
// authorIdStart/authorIdEnd: cols [start, end) of the user id when this comment is
//   by the 原PO → wrap just the id in .commentByAuthor (see LinkSegmentBuilder).
export const Row = ({
  chars,
  row,
  enableLinkInlinePreview,
  forceWidth,
  highlighted,
  floor,
  hidden,
  pusher,
  pusherHighlight,
  authorIdStart,
  authorIdEnd,
  fixedUrls,
  mentions,
  onHyperLinkMouseOver,
  onHyperLinkMouseOut,
}) => (
  <span
    type="bbsrow"
    srow={row}
    data-pusher={pusher}
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
        ),
      )
      .build()}
  </span>
);

export default Row;
