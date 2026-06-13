import Row from "../components/Row";
import Screen from "../components/Screen";

export class ColorState {
  constructor(fg, bg, blink) {
    this.fg = fg;
    this.bg = bg;
    this.blink = blink;
  }

  equals(oth) {
    if (oth instanceof ColorState) {
      return this.fg == oth.fg && this.bg == oth.bg && this.blink == oth.blink;
    }
    return false;
  }
}

// Render a single row into an overlay container that is NOT #mainContainer
// (the easy-reading footer #easyReadingLastRow and reply preview
// #easyReadingReplyRow). Those are standalone divs under BBSWindow, so a tiny
// per-row ReactDOM.render here does not fight React for #mainContainer ownership
// (that container is rendered solely via renderScreen / <Screen>).
export function renderOverlayRow(chars, forceWidth, cont) {
  return ReactDOM.render(
    <Row chars={chars} row={0} forceWidth={forceWidth} />,
    cont
  );
}

export function renderScreen(lines, forceWidth, enableLinkInlinePreview, enableLinkHoverPreview, cont, enhance) {
  return ReactDOM.render(
    <Screen
      lines={lines}
      forceWidth={forceWidth}
      enableLinkInlinePreview={enableLinkInlinePreview}
      enableLinkHoverPreview={enableLinkHoverPreview}
      enhance={enhance}
    />, cont);
}
