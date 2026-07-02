export function TouchController(app) {
  this.app = app;
  this.highlightCopy = false;
  this.touchStarted = false;
  this.touchedCenter = { x: 0, y: 0 };
  this.setupHandlers();
}

// Distinguish a tap from a drag/pan without a gesture library (was hammerjs):
// a pointer sequence that moves less than TAP_SLOP px and lasts under TAP_TIME
// ms counts as a tap; anything longer/further is treated as a pan.
var TAP_SLOP = 10;
var TAP_TIME = 300;

TouchController.prototype.setupHandlers = function() {
  var self = this;
  var app = this.app;

  document.body.ontouchmove = function(e) {
    if (e.touches.length != 1) return false;
    return true;
  };

  document.body.ontouchstart = function(e) {
    self.touchStarted = true;
    app.inputArea.blur();
  };

  document.body.ontouchend = function(e) {
    if (app.buf.pageState == 2 && app.buf.highlightCursor &&
        app.buf.nowHighlight != -1) {
      app.onMouse_click(self.touchedCenter.x, self.touchedCenter.y);
      app.buf.nowHighlight = -1;
      app.buf.highlightCursor = self.highlightCopy;
      app.BBSWin.style.cursor = 'auto';
      self.touchStarted = false;
      app.inputArea.focus();
    }
  };

  // Touch gestures on the BBS window (replaces hammerjs pan/tap). Only touch
  // pointers are handled; mouse/pen fall through to the desktop mouse handlers
  // (window mousedown/up in pttchrome.js), so non-touch behaviour is untouched.
  var win = app.BBSWin;
  var activeId = null;
  var startX = 0;
  var startY = 0;
  var startAt = 0;
  var moved = false;

  win.addEventListener('pointerdown', function(e) {
    if (e.pointerType !== 'touch') return;
    activeId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startAt = Date.now();
    moved = false;
    // Suppress the compatibility mouse events the browser synthesizes from a
    // touch (hammerjs did this via srcEvent.preventDefault) so a tap doesn't
    // also fire window mousedown → mouse_down.
    e.preventDefault();
  });

  win.addEventListener('pointermove', function(e) {
    if (e.pointerType !== 'touch' || e.pointerId !== activeId) return;
    if (!moved) {
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      if (dx * dx + dy * dy > TAP_SLOP * TAP_SLOP) moved = true;
    }
    // Pan: drag moves the highlight cursor while in the list-highlight state.
    if (moved && app.buf.pageState == 2) {
      e.preventDefault();
      self.highlightCopy = app.buf.highlightCursor;
      app.buf.highlightCursor = true;
      app.onMouse_move(e.clientX, e.clientY);
      self.touchedCenter.x = e.clientX;
      self.touchedCenter.y = e.clientY;
    }
  });

  win.addEventListener('pointerup', function(e) {
    if (e.pointerType !== 'touch' || e.pointerId !== activeId) return;
    activeId = null;
    // A pan's terminating click is handled by document.body.ontouchend (paired
    // with the pan above via highlightCursor/nowHighlight); only fire the tap
    // path for a short, near-stationary press.
    var isTap = !moved && Date.now() - startAt < TAP_TIME;
    if (!isTap) return;
    // Tap: move the cursor to the touch point and click it (select that row).
    self.highlightCopy = app.buf.highlightCursor;
    app.buf.highlightCursor = false;
    app.onMouse_move(e.clientX, e.clientY);
    app.onMouse_click(e.clientX, e.clientY);
    app.buf.nowHighlight = -1;
    app.buf.highlightCursor = self.highlightCopy;
    app.BBSWin.style.cursor = 'auto';
    self.touchStarted = false;
    app.inputArea.focus();
  });

  win.addEventListener('pointercancel', function(e) {
    if (e.pointerType === 'touch' && e.pointerId === activeId) activeId = null;
  });
};
