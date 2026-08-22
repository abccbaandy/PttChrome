import { ScreenController } from "../render/screen";
import { buildRow } from "../render/row";

// 每個螢幕容器（#screenRoot）一個 ScreenController。它擁有 #mainContainer，是
// 核心畫面（文章列表／列表好讀／文章／文章好讀）**唯一**的渲染路徑。
//
// 2026-08 之前這裡是 React：renderScreen 把 <Screen> render 進去，term_view 再
// 透過 ref 拿命令式 handle。改成純 JS 後 controller 自己就是 handle，介面不變
// （term_view 的 this.componentScreen.setCursorHighlight(...) 一行都沒動）。
const controllers = new WeakMap();

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
// BBSWin, so a tiny per-row render here does not fight the screen container's
// owner (that one is rendered solely via renderScreen / ScreenController).
export function renderOverlayRow(chars, forceWidth, cont) {
  const built = buildRow({ chars, row: 0, forceWidth });
  cont.replaceChildren(built.node);
}

export function renderScreen(
  lines,
  forceWidth,
  enableLinkInlinePreview,
  enableLinkHoverPreview,
  cont,
  enhance,
) {
  let controller = controllers.get(cont);
  if (!controller) {
    controller = new ScreenController(cont);
    controllers.set(cont, controller);
  }
  controller.update({
    lines,
    forceWidth,
    enableLinkInlinePreview,
    enableLinkHoverPreview,
    enhance,
  });
  return controller;
}
