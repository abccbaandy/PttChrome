import Row from "./Row";
import ImagePreviewer, {
  of,
  resolveSrcToImageUrl,
  resolveWithImageDOM
} from "./ImagePreviewer";
import {
  rowToText,
  parseComment,
  parseListAuthor,
  FloorCounter
} from "../js/comment_parse";

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
  const { blacklist, showFloorNumbers, pageState } = enhance;
  const hasBlacklist = blacklist && blacklist.size > 0;
  if (pageState === PAGE_READING) {
    const counter = new FloorCounter();
    for (let row = 0; row < lines.length; ++row) {
      const c = parseComment(rowToText(lines[row]));
      if (!c) continue;
      // Count every comment first (blacklisted ones still occupy a floor).
      const floor = showFloorNumbers ? counter.next(c.type) : undefined;
      if (hasBlacklist && blacklist.has(c.userid)) {
        result[row] = { hidden: true };
      } else if (floor) {
        result[row] = { floor };
      }
    }
  } else if (pageState === PAGE_LIST && hasBlacklist) {
    for (let row = 0; row < lines.length; ++row) {
      const author = parseListAuthor(rowToText(lines[row]));
      if (author && blacklist.has(author)) {
        result[row] = { hidden: true };
      }
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
    return (
      <div id="mainContainer" onMouseMove={this.handleMouseMove}>
        {this.props.lines.map((chars, row) => (
          <Row
            key={row}
            chars={chars}
            row={row}
            forceWidth={this.props.forceWidth}
            enableLinkInlinePreview={this.props.enableLinkInlinePreview}
            highlighted={this.state.currentHighlighted === row}
            floor={annotations[row] && annotations[row].floor}
            hidden={annotations[row] && annotations[row].hidden}
            onHyperLinkMouseOver={this.handleHyperLinkMouseOver}
            onHyperLinkMouseOut={this.handleHyperLinkMouseOut}
          />
        ))}
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
