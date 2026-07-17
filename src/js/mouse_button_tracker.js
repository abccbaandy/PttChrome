// Tracks left/right mouse button hold state for wheel-action mapping
// (plain scroll = arrow, right-hold = page, left-hold = thread).
// Pure logic, no DOM: unit-tested in tests/unit/mouse_button_tracker.test.js.
//
// A lost mouseup (window blur while holding, modal swallowing the event)
// must never leave a button flag stuck — callers reset() on blur and
// syncFromButtons(e.buttons) on every wheel event as self-healing.
export class MouseButtonTracker {
  constructor() {
    this.left = false;
    this.right = false;
  }

  // e.button: 0=left, 1=middle, 2=right
  onMouseDown(button) {
    if (button === 0) this.left = true;
    else if (button === 2) this.right = true;
  }

  onMouseUp(button) {
    if (button === 0) this.left = false;
    else if (button === 2) this.right = false;
  }

  reset() {
    this.left = false;
    this.right = false;
  }

  // MouseEvent.buttons bitmask: bit0=left, bit1=right. Authoritative on
  // every mouse event; undefined on legacy 'mousewheel' → leave state as-is.
  syncFromButtons(buttons) {
    if (buttons === undefined) return;
    this.left = (buttons & 1) !== 0;
    this.right = (buttons & 2) !== 0;
  }
}
