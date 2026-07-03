// Serialized machine-key queue for list easy reading (v4 principle C).
//
// pttbbs skips repaints while client keys are still in its input buffer
// (typeahead, mbbsd/screen.c:310 — see docs/pttbbs-screen-protocol.md §2), so
// two machine keys in flight guarantee the intermediate screen is swallowed and
// any per-response detection races. This queue enforces ONE in-flight command:
// send keys → wait for a settled screen that satisfies `expect` → only then
// send the next.
//
// Completion is decided by CONTENT (the expect predicate over the settle
// snapshot/facts), never by timing or packet boundaries (§3 of the protocol
// doc: frame boundaries are unreliable). Timing is only used to give up:
//   - soft timeout: re-armed on EVERY settle while the command is in flight
//     (a settle that doesn't satisfy expect still proves the link is alive —
//     a slow multi-write response keeps extending its own deadline);
//   - hard timeout: armed once at send, absolute cap.
// What a timeout MEANS is the caller's business (prefetch → benign "treat as
// end of board"; open-article → self-heal to functionMode).
//
// Zero dependencies: send and the timer functions are injected so unit tests
// drive it with jest fake timers and the app binds it to conn.send.
export function CommandQueue(opts) {
  this._send = opts.send;
  // Wrap the globals instead of storing them bare: calling a detached
  // setTimeout as this._setTimeout(...) makes `this` the queue → Chrome throws
  // "Illegal invocation" (jsdom is lenient, the browser is not).
  this._setTimeout =
    opts.setTimeout ||
    function(fn, ms) {
      return setTimeout(fn, ms);
    };
  this._clearTimeout =
    opts.clearTimeout ||
    function(t) {
      clearTimeout(t);
    };
  this._inFlight = null;
  this._pending = [];
  this._softTimer = null;
  this._hardTimer = null;
}

CommandQueue.prototype = {
  // cmd = {
  //   keys:          string to send verbatim,
  //   kind:          caller tag surfaced via inFlightKind (reducer context),
  //   expect(snapshot, facts): truthy when the settled screen IS the response —
  //                  the truthy value is passed to onDone (so an expect can
  //                  report HOW it completed, e.g. { edge: true }),
  //   timeoutMs:     soft timeout (default 3000),
  //   hardTimeoutMs: absolute cap (default 10000),
  //   onDone(result), onFail(reason),
  // }
  enqueue: function(cmd) {
    this._pending.push(cmd);
    this._maybeSendNext();
  },

  // Evaluate the in-flight command against a settled screen. Call on every
  // screenSettled BEFORE the state-machine reducer runs, so the reducer sees
  // inFlightKind AFTER completion is accounted for.
  onSettle: function(snapshot, facts) {
    const cmd = this._inFlight;
    if (!cmd) return;
    const result = cmd.expect(snapshot, facts);
    if (result) {
      this._finish();
      if (cmd.onDone) cmd.onDone(result);
      this._maybeSendNext();
    } else {
      // Response still in progress — the settle proves activity, extend.
      this._armSoft(cmd);
    }
  },

  // Drop everything, silently (no onFail): entering functionMode / pref off /
  // leaving the board. Whatever response is still on the wire gets absorbed by
  // the native mirror, which renders anything correctly.
  flush: function() {
    this._finish();
    this._pending = [];
  },

  get inFlightKind() {
    return this._inFlight ? this._inFlight.kind : null;
  },

  get idle() {
    return !this._inFlight && this._pending.length === 0;
  },

  _maybeSendNext: function() {
    if (this._inFlight || this._pending.length === 0) return;
    const cmd = this._pending.shift();
    this._inFlight = cmd;
    this._armSoft(cmd);
    this._hardTimer = this._setTimeout(() => {
      this._fail(cmd, 'timeout');
    }, cmd.hardTimeoutMs || 10000);
    this._send(cmd.keys);
  },

  _armSoft: function(cmd) {
    this._clearTimeout(this._softTimer);
    this._softTimer = this._setTimeout(() => {
      this._fail(cmd, 'timeout');
    }, cmd.timeoutMs || 3000);
  },

  _fail: function(cmd, reason) {
    if (this._inFlight !== cmd) return; // already completed/flushed
    this._finish();
    if (cmd.onFail) cmd.onFail(reason);
    this._maybeSendNext();
  },

  _finish: function() {
    this._clearTimeout(this._softTimer);
    this._clearTimeout(this._hardTimer);
    this._softTimer = null;
    this._hardTimer = null;
    this._inFlight = null;
  }
};
