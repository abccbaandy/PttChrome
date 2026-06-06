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
    floor,
    authorIdStart,
    authorIdEnd
  ) {
    this.row = row;
    this.forceWidth = forceWidth;
    this.highlighted = highlighted;
    this.onHyperLinkMouseOver = onHyperLinkMouseOver;
    this.onHyperLinkMouseOut = onHyperLinkMouseOut;
    this.floor = floor;
    // Same-author (原PO) highlight: wrap cols [authorIdStart, authorIdEnd) — the
    // pusher's user id — in a .commentByAuthor span so only the id is tinted.
    // undefined → not a 原PO comment, skip all wrap logic.
    this.authorIdStart = authorIdStart;
    this.authorIdEnd = authorIdEnd;
    this._inAuthor = false;
    this._authorWrap = null;
    //
    this.segs = [];
    this.inlineLinkPreviews = enableLinkInlinePreview ? [] : false;
    //
    this.colorSegBuilder = null;
    this.col = null;
    this.href = null;
  }

  // Push a built segment to the current target: the author-id wrapper while
  // inside the user-id range, otherwise the row's top-level segment list.
  _pushSeg(node) {
    if (this._inAuthor) this._authorWrap.push(node);
    else this.segs.push(node);
  }

  _flushAuthorWrap() {
    if (this._authorWrap && this._authorWrap.length) {
      this.segs.push(
        <span key="authorId" className="commentByAuthor">
          {this._authorWrap}
        </span>
      );
    }
    this._authorWrap = null;
    this._inAuthor = false;
  }

  saveSegment() {
    const element = this.colorSegBuilder.build();
    if (this.href) {
      this._pushSeg(
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
      this._pushSeg(<span key={this.col}>{element}</span>);
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
    // Open the 原PO id wrapper at the first column of the user id. floor (col 2)
    // is inserted before this, so it stays outside the wrapper.
    if (this.authorIdStart !== undefined && i === this.authorIdStart) {
      if (this.colorSegBuilder !== null) this.saveSegment();
      this._inAuthor = true;
      this._authorWrap = [];
    }
    // Close it once we move past the id (this column is no longer the user id).
    if (this._inAuthor && i === this.authorIdEnd) {
      if (this.colorSegBuilder !== null) this.saveSegment();
      this._flushAuthorWrap();
    }
    // Insert the floor number into the gap before the user id (inside the line).
    if (this.floor && i === FLOOR_BADGE_COL && !this._floorInserted) {
      if (this.colorSegBuilder !== null) this.saveSegment();
      this._pushSeg(this.floorBadge());
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
    // Safety net: a user id running to the end of the line never gets its close
    // boundary, so flush any still-open wrapper here.
    if (this._inAuthor) this._flushAuthorWrap();
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
