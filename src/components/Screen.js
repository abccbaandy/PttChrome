import Row from "./Row";
import ImagePreviewer, {
  of,
  resolveSrcToImageUrl,
  resolveWithImageDOM
} from "./ImagePreviewer";
import {
  rowToText,
  annotateComment,
  parseListAuthor,
  parseListTitle,
  matchTitleBlacklist,
  FloorCounter
} from "../js/comment_parse";
import { detectFixableUrls } from "../js/url_fix";
import { detectMentions } from "../js/mention_parse";

// NOTE: articleAuthor (原PO id) is tracked by term_view across page-downs and
// passed in via enhance — the "作者" header only appears on the first page, so we
// cannot re-derive it from `lines` here on later pages.

// PttChrome pageState (see term_buf.js#setPageState): 2 = board list, 3 = reading.
const PAGE_LIST = 2;
const PAGE_READING = 3;

// Per-row { floor } / { hidden } annotations for the Enhanced Add-on. Native grid
// is fixed-size, so a blacklisted row is hidden (visibility:hidden) rather than
// removed — removing it would desync the terminal grid. Floor numbers here count
// only within the visible page (cross-page numbering needs easy reading; see plan).
function computeAnnotations(lines, enhance) {
  const result = new Array(lines.length);
  if (!enhance) return result;
  const {
    blacklist,
    titleBlacklist,
    showFloorNumbers,
    highlightAuthor,
    articleAuthor,
    selectedPusher,
    pageState,
    autoFixUrl,
    easyReading,
    enableXMention,
    inListContext
  } = enhance;
  const hasBlacklist = blacklist && blacklist.size > 0;
  const hasTitleBlacklist = titleBlacklist && titleBlacklist.length > 0;
  if (pageState === PAGE_READING) {
    // Floor numbers are shown only in easy reading, where the FloorCounter walks
    // the whole accumulated article (accurate). The native per-page counter resets
    // every page-down → inaccurate, so no floorCounter is passed there and
    // annotateComment skips floors entirely (see comment_parse.js). Auto-fix URL
    // detection below still runs on every row regardless of mode.
    const ctx = {
      blacklist,
      showFloorNumbers,
      floorCounter: easyReading ? new FloorCounter() : undefined,
      highlightAuthor,
      articleAuthor,
      selectedPusher
    };
    for (let row = 0; row < lines.length; ++row) {
      const text = rowToText(lines[row]);
      const ann = annotateComment(text, ctx) || undefined;
      // Auto-fix runs on every row (article body included), independent of the
      // comment annotation. The fixed-URL line only renders in easy-reading mode
      // (see LinkSegmentBuilder); detection itself is cheap and returns [] for
      // almost every row.
      let fixedUrls;
      if (autoFixUrl) {
        const fixes = detectFixableUrls(text);
        if (fixes.length) fixedUrls = fixes;
      }
      // X(Twitter) @handle auto-links. Detect on the raw TermChar[] (DBCS-aware —
      // see mention_parse.js) and link every format-valid @handle. Existence
      // verification is currently OFF (unavatar's 25/day cap made it unusable; see
      // docs/enhanced-addon.md for the worker approach to bring it back), so a
      // mention that points at a non-existent account is still linked. Skip hidden
      // (blacklisted) rows, and same-author comment rows whose id is already
      // wrapped by authorIdStart/End (an overlapping mention <a> would fight it).
      let mentions;
      if (
        enableXMention &&
        !(ann && (ann.hidden || ann.authorIdStart !== undefined))
      ) {
        const found = detectMentions(lines[row]);
        for (let k = 0; k < found.length; ++k) {
          const m = found[k];
          (mentions || (mentions = [])).push({
            startCol: m.startCol,
            endCol: m.endCol,
            handle: m.handle,
            href: "https://x.com/" + m.handle
          });
        }
      }
      let r = ann;
      if (fixedUrls) r = { ...(r || {}), fixedUrls };
      if (mentions) r = { ...(r || {}), mentions };
      result[row] = r;
    }
  } else if (
    (pageState === PAGE_LIST || inListContext) &&
    (hasBlacklist || hasTitleBlacklist)
  ) {
    // inListContext keeps list blacklist hiding alive across overlay prompts (e.g.
    // the v 設定已讀未讀記錄 sub-screen) whose status row stops parsing as LIST(2).
    // READING is the preceding `if`, so this never runs while reading an article.
    for (let row = 0; row < lines.length; ++row) {
      const text = rowToText(lines[row]);
      let hide = false;
      if (hasBlacklist) {
        const author = parseListAuthor(text);
        if (author && blacklist.has(author)) hide = true;
      }
      if (!hide && hasTitleBlacklist) {
        if (matchTitleBlacklist(parseListTitle(text), titleBlacklist))
          hide = true;
      }
      if (hide) result[row] = { hidden: true };
    }
  }
  return result;
}

export class Screen extends React.Component {
  setCurrentHighlighted = currentHighlighted => {
    this.setState({ currentHighlighted });
  };

  state = {
    currentHighlighted: undefined,
    currentImagePreview: undefined,
    left: undefined,
    top: undefined
  };

  componentWillReceiveProps(nextProps) {
    if (this.props.lines !== nextProps.lines) {
      this.setState({ currentImagePreview: undefined });
    }
  }

  handleMouseMove = ({ clientX, clientY }) => {
    if (this.state.currentImagePreview) {
      this.setState({
        left: clientX,
        top: clientY
      });
    }
  };

  handleHyperLinkMouseOver = ({ currentTarget: { href } }) => {
    if (this.props.enableLinkHoverPreview) {
      this.setState({
        currentImagePreview: of(href)
          .then(resolveSrcToImageUrl)
          .then(resolveWithImageDOM)
      });
    }
  };

  handleHyperLinkMouseOut = () => {
    this.setState({ currentImagePreview: undefined });
  };

  render() {
    const annotations = computeAnnotations(
      this.props.lines,
      this.props.enhance
    );
    // dropHidden: easy-reading accumulates a single growing scroll page, so a
    // blacklisted comment is removed entirely (render null → no DOM node, no blank
    // line). The fixed native grid instead keeps the row and hides it
    // (visibility:hidden via <Row hidden>) so the terminal alignment is preserved.
    // Rendering null does NOT shift the map index, so surviving rows keep their
    // absolute pageLines index in `row`/`data-row` and selection across the gap
    // (term_buf.getText uses the absolute row index) stays correct.
    const dropHidden = !!(this.props.enhance && this.props.enhance.dropHidden);
    return (
      <div id="mainContainer" onMouseMove={this.handleMouseMove}>
        {this.props.lines.map((chars, row) => {
          const ann = annotations[row];
          if (dropHidden && ann && ann.hidden) return null;
          return (
            <Row
              key={row}
              chars={chars}
              row={row}
              forceWidth={this.props.forceWidth}
              enableLinkInlinePreview={this.props.enableLinkInlinePreview}
              highlighted={this.state.currentHighlighted === row}
              floor={ann && ann.floor}
              hidden={ann && ann.hidden}
              pusher={ann && ann.pusher}
              pusherHighlight={ann && ann.pusherHighlight}
              authorIdStart={ann && ann.authorIdStart}
              authorIdEnd={ann && ann.authorIdEnd}
              fixedUrls={ann && ann.fixedUrls}
              mentions={ann && ann.mentions}
              onHyperLinkMouseOver={this.handleHyperLinkMouseOver}
              onHyperLinkMouseOut={this.handleHyperLinkMouseOut}
            />
          );
        })}
        {this.state.currentImagePreview && (
          <ImagePreviewer
            request={this.state.currentImagePreview}
            component={ImagePreviewer.OnHover}
            left={this.state.left}
            top={this.state.top}
          />
        )}
      </div>
    );
  }
}

export default Screen;
