import LinkSegmentBuilder from "./LinkSegmentBuilder";

// floor: { seq, sub, type } | undefined  → render a floor badge before the line.
// hidden: true → blacklisted row; keep the bbsrow (so the fixed terminal grid
//   stays aligned) but hide its content. The easy-reading path drops the row
//   entirely instead of passing hidden, so there it occupies no space at all.
export const Row = ({
  chars,
  row,
  enableLinkInlinePreview,
  forceWidth,
  highlighted,
  floor,
  hidden,
  onHyperLinkMouseOver,
  onHyperLinkMouseOut
}) => (
  <span
    type="bbsrow"
    srow={row}
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
          floor
        )
      )
      .build()}
  </span>
);

export default Row;
