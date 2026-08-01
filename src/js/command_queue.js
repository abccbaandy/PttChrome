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
// doc: frame boundaries are unreliable). Timing is only used to trigger the
// v5 PROBE, never to conclude:
//   - soft timeout: re-armed on EVERY settle while the command is in flight
//     (a settle that doesn't satisfy expect still proves the link is alive —
//     a slow multi-write response keeps extending its own deadline);
//   - hard timeout: armed once at send, absolute cap. NEVER re-armed after
//     that — the probe branch used to re-arm it, handing a wedged command a
//     SECOND full hard window (worst case 2×hard ≈ 20s of frozen list render,
//     the 「畫面停住十幾秒才切原生」 report). The probe gets its own short
//     window instead (probeTimeoutMs).
// v5 deterministic-transaction contract (protocol §6):
//   - cmd.fullRepaint: append \f (Ctrl+L) to the sent keys — igetch's global
//     hotkey forces ONE full-frame repaint after the command's response, so
//     the expect always gets a complete screen to judge (zero-response
//     ambiguity gone). Safe even if the server is mid-getdata/pmore (§6).
//   - timeout → PROBE: instead of failing, send a bare \f (zero-side-effect
//     "where am I" probe) and give expect ONE more look at the guaranteed
//     full frame. Truthy → onDone as usual (the response was just slow/lost);
//     falsy → onFail('miss', facts) — a REAL answer, the caller reclassifies
//     the known-complete screen. A second silent timeout (probe unanswered =
//     link dead) → onFail('timeout'). Opt out with cmd.probe === false.
//
// Zero dependencies: send and the timer functions are injected so unit tests
// drive it with vitest fake timers and the app binds it to conn.send.
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
  // Optional diagnostics tap (app wires it to debugRecorder?.log). Null by
  // default = zero cost; when a hang is reproduced the recording carries the
  // full per-command timeline (which kind, how long, done/miss/timeout).
  this._onEvent = opts.onEvent || null;
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
  //   fullRepaint:   append \f to keys — response ends in a guaranteed full
  //                  frame (protocol §6), for transactions whose bare response
  //                  is ambiguous (jump landings, zero-response edges),
  //   probe:         default true — on timeout send a bare \f and let expect
  //                  judge the full frame before failing; false = fail direct,
  //   timeoutMs:     soft timeout (default 3000) — triggers the probe, not
  //                  the failure,
  //   hardTimeoutMs: absolute cap from send (default 10000), never re-armed,
  //   probeTimeoutMs: how long the probe's full frame gets (default 2000),
  //   onDone(result), onFail(reason, facts) — reason 'miss' carries the
  //                  probed full frame's facts; 'timeout' = link silent,
  //   onFlushed():   opt-in notification that flush() dropped this command
  //                  while in flight — flush stays SILENT for everyone else
  //                  (callers whose own state machine self-converges from the
  //                  native mirror), but a caller holding an input-blocking
  //                  flag (AidNavigation.active) must be able to release it.
  // }
  enqueue: function(cmd) {
    this._emit('enqueue', cmd);
    this._pending.push(cmd);
    this._maybeSendNext();
  },

  // Evaluate the in-flight command against a settled screen. Call on every
  // screenSettled BEFORE the state-machine reducer runs, so the reducer sees
  // inFlightKind AFTER completion is accounted for.
  // Returns how the settle was CONSUMED by the in-flight command — 'done'
  // (expect satisfied) or 'miss' (probe frame conclusively rejected) — else
  // null. The caller must mark such settles as command-owned: a completing
  // settle reads inFlightKind null right after, and a non-clean-list
  // completion frame (board-tail probe, jump park) would otherwise look like
  // an ownerless transient to the reducer's catch-all（2026-07-14 錄製檔：
  // 整板一頁的 prefetch edge 探針幀誤降級 functionMode）.
  onSettle: function(snapshot, facts) {
    const cmd = this._inFlight;
    if (!cmd) return null;
    const result = cmd.expect(snapshot, facts);
    if (result) {
      this._emit('done', cmd);
      this._finish();
      if (cmd.onDone) cmd.onDone(result);
      this._maybeSendNext();
      return 'done';
    } else if (cmd._probed) {
      // The probe's full frame arrived and expect still says no — that is a
      // definitive MISS, not a maybe: hand the known-complete screen's facts
      // to the caller for reclassification (v5: failures are explicit).
      this._emit('miss', cmd);
      this._finish();
      if (cmd.onFail) cmd.onFail('miss', facts);
      this._maybeSendNext();
      return 'miss';
    }
    // Response still in progress — the settle proves activity, extend.
    this._emit('settle-pending', cmd);
    this._armSoft(cmd);
    return null;
  },

  // A FOREGROUND transaction is queued behind a background command: cut the
  // in-flight command's remaining wait down to `ms` so the queue hands over in
  // ~a round-trip instead of its full soft/hard budget. The short deadline
  // triggers the ordinary \f probe (zero side effects, guaranteed full-frame
  // answer — protocol §6), so this is NOT a cancellation: the command stays in
  // flight and keeps its pairing, and its answer is still judged by content.
  // Deliberately never _finish()es early — that is what turns an on-the-wire
  // response into an ownerless settle able to satisfy the next transaction's
  // expect (invariant 7's live race: the leave-board expect ate a prefetch
  // anchor's landing).
  // Without this, pressing Enter/←/digits right after a burst of page keys
  // froze the list render for the in-flight prefetch's ENTIRE budget before a
  // single byte of the user's command went out（回報：「畫面停住、顯示處理中，
  // 過一陣子才復原」）.
  expedite: function(ms) {
    const cmd = this._inFlight;
    if (!cmd || cmd._probed || cmd.probe === false) return;
    this._emit('expedite', cmd);
    this._armSoft(cmd, ms || 250);
  },

  // Drop everything, silently (no onFail): entering functionMode / pref off /
  // leaving the board. Whatever response is still on the wire gets absorbed by
  // the native mirror, which renders anything correctly.
  flush: function() {
    const cmd = this._inFlight;
    if (cmd) this._emit('flush', cmd);
    this._finish();
    this._pending = [];
    // opt-in only (see cmd.onFlushed): everyone else keeps the silent contract.
    if (cmd && cmd.onFlushed) cmd.onFlushed();
  },

  // Drop only the queued-but-unsent commands, keeping the in-flight one so its
  // response stays PAIRED (v5): flushing an in-flight command turns its
  // still-on-the-wire response into an ownerless settle that can prematurely
  // satisfy the next transaction's expect (live race: the leave-board expect
  // ate a prefetch anchor's landing). A T2 transaction enqueued after this
  // waits its turn behind the in-flight command — serialization is the fix.
  flushPending: function() {
    this._pending = [];
  },

  // Drop only the pending commands whose kind starts with `prefix` — a failed
  // prefetch anchor must cancel its paired page command but never a user
  // transaction serialized behind it (the preamble's flushPending may have
  // already replaced the page command with the transaction).
  flushPendingKind: function(prefix) {
    this._pending = this._pending.filter(function(c) {
      return (c.kind || '').indexOf(prefix) !== 0;
    });
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
    cmd._probed = false;
    cmd._sentAt = Date.now();
    this._armBoth(cmd);
    this._emit('send', cmd);
    this._send(cmd.fullRepaint ? cmd.keys + '\f' : cmd.keys);
  },

  _armBoth: function(cmd) {
    this._armSoft(cmd);
    this._clearTimeout(this._hardTimer);
    this._hardTimer = this._setTimeout(() => {
      this._timedOut(cmd);
    }, cmd.hardTimeoutMs || 10000);
  },

  // ms omitted = the command's own soft window; expedite/probe pass a short one.
  _armSoft: function(cmd, ms) {
    this._clearTimeout(this._softTimer);
    this._softTimer = this._setTimeout(() => {
      this._timedOut(cmd);
    }, ms || cmd.timeoutMs || 3000);
  },

  // Quiet link. First time (probe allowed): force a full frame with a bare \f
  // and let onSettle's expect judge it. Second time / probe opted out: fail.
  _timedOut: function(cmd) {
    if (this._inFlight !== cmd) return; // already completed/flushed
    if (cmd.probe !== false && !cmd._probed) {
      cmd._probed = true;
      // SOFT only: re-arming hard here would grant a second full hard window
      // (2×hard worst case). The hard timer armed at send stays the absolute
      // deadline; if it already fired, this short probe window is the cap.
      this._armSoft(cmd, cmd.probeTimeoutMs || 2000);
      this._emit('probe', cmd);
      this._send('\f');
      return;
    }
    this._emit('fail', cmd);
    this._finish();
    if (cmd.onFail) cmd.onFail('timeout');
    this._maybeSendNext();
  },

  _emit: function(name, cmd) {
    if (!this._onEvent) return;
    this._onEvent(name, {
      kind: cmd.kind || null,
      sinceSentMs: cmd._sentAt ? Date.now() - cmd._sentAt : null,
      pendingLen: this._pending.length,
      probed: !!cmd._probed
    });
  },

  _finish: function() {
    this._clearTimeout(this._softTimer);
    this._clearTimeout(this._hardTimer);
    this._softTimer = null;
    this._hardTimer = null;
    this._inFlight = null;
  }
};
