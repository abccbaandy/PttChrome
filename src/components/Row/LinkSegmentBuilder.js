import cx from "classnames";
import HyperLink from "./HyperLink";
import ColorSegmentBuilder from "./ColorSegmentBuilder";
import ImagePreviewer, { of, resolveSrcToImageUrl } from "../ImagePreviewer";

// Comment lines are "推 userid: ...". The marker (推/噓/→) is a 2-column DBCS
// char (cols 0-1) and col 2 is the space before the user id — that gap is where
// the floor number is shown (matching the original script).
const FLOOR_BADGE_COL = 2;

export class LinkSegmentBuilder {
  constructor(
    row,
    enableLinkInlinePreview,
    forceWidth,
    highlighted,
    onHyperLinkMouseOver,
    onHyperLinkMouseOut,
    floor
  ) {
    this.row = row;
    this.forceWidth = forceWidth;
    this.highlighted = highlighted;
    this.onHyperLinkMouseOver = onHyperLinkMouseOver;
    this.onHyperLinkMouseOut = onHyperLinkMouseOut;
    this.floor = floor;
    //
    this.segs = [];
    this.inlineLinkPreviews = enableLinkInlinePreview ? [] : false;
    //
    this.colorSegBuilder = null;
    this.col = null;
    this.href = null;
  }

  saveSegment() {
    const element = this.colorSegBuilder.build();
    if (this.href) {
      this.segs.push(
        <HyperLink
          key={this.col}
          href={this.href}
          inner={element}
          data-scol={this.col}
          data-srow={this.row}
          onMouseOver={this.onHyperLinkMouseOver}
          onMouseOut={this.onHyperLinkMouseOut}
        />
      );
      // TODO: Modularize this.
      if (this.inlineLinkPreviews) {
        this.inlineLinkPreviews.push(
          <ImagePreviewer
            key={`${this.col}-${this.href}`}
            request={of(this.href).then(resolveSrcToImageUrl)}
            component={ImagePreviewer.Inline}
          />
        );
      }
    } else {
      this.segs.push(<span key={this.col}>{element}</span>);
    }
    this.colorSegBuilder = null;
  }

  floorBadge() {
    const f = this.floor;
    return (
      <span
        key="floor"
        className="floorBadge"
        data-floor
        title={`第${f.seq}樓 ${f.type}${f.sub}`}
      >
        {f.seq}
      </span>
    );
  }

  readChar(ch, i) {
    // Insert the floor number into the gap before the user id (inside the line).
    if (this.floor && i === FLOOR_BADGE_COL && !this._floorInserted) {
      if (this.colorSegBuilder !== null) this.saveSegment();
      this.segs.push(this.floorBadge());
      this._floorInserted = true;
    }
    if (this.colorSegBuilder !== null && ch.isStartOfURL()) {
      this.saveSegment();
    }
    if (this.colorSegBuilder === null) {
      this.colorSegBuilder = new ColorSegmentBuilder(this.forceWidth);
      this.col = i;
      this.href = ch.isStartOfURL() ? ch.getFullURL() : null;
    }
    this.colorSegBuilder.readChar(ch);
    if (ch.isEndOfURL()) {
      this.saveSegment();
    }
  }

  build() {
    if (this.colorSegBuilder !== null) {
      this.saveSegment();
    }
    return (
      <div>
        <span
          className={cx({ b2: this.highlighted })}
          data-type="bbsline"
          data-row={this.row}
        >
          {this.segs}
        </span>
        <div>{this.inlineLinkPreviews}</div>
      </div>
    );
  }
}

LinkSegmentBuilder.accumulator = (builder, ch, i) => {
  builder.readChar(ch, i);
  return builder;
};

export default LinkSegmentBuilder;
