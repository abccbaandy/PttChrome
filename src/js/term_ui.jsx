import React from "react";
import Row from "../components/Row";
import Screen from "../components/Screen";
import { renderInto } from "./react_root";

// 每個 #mainContainer 容器一份 { ref, handle }。React 18 root.render() 回傳 undefined，
// 但 term_view 需要命令式呼叫 Screen.setCursorHighlight（游標底色列）。改用 ref 取得
// Screen 實例；handle 是穩定物件（同一容器只建一次），其方法 lazy 解 ref.current，
// 不依賴 render() 後 ref 是否同步填充——首次上色發生在使用者操作時，ref 早已 commit。
const screenHandles = new WeakMap();

function getScreenHandle(cont) {
  let entry = screenHandles.get(cont);
  if (!entry) {
    const ref = React.createRef();
    entry = {
      ref,
      handle: {
        setCursorHighlight: state => {
          if (ref.current) ref.current.setCursorHighlight(state);
        }
      }
    };
    screenHandles.set(cont, entry);
  }
  return entry;
}

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

// Render a single row into an overlay container that is NOT the screen root
// (the easy-reading footer #easyReadingLastRow). It is a standalone div under
// BBSWindow, so a tiny per-row render here does not fight React for the screen
// container's ownership (that one is rendered solely via renderScreen / <Screen>).
export function renderOverlayRow(chars, forceWidth, cont) {
  renderInto(cont, <Row chars={chars} row={0} forceWidth={forceWidth} />);
}

export function renderScreen(lines, forceWidth, enableLinkInlinePreview, enableLinkHoverPreview, cont, enhance) {
  const { ref, handle } = getScreenHandle(cont);
  renderInto(
    cont,
    <Screen
      ref={ref}
      lines={lines}
      forceWidth={forceWidth}
      enableLinkInlinePreview={enableLinkInlinePreview}
      enableLinkHoverPreview={enableLinkHoverPreview}
      enhance={enhance}
    />
  );
  return handle;
}
