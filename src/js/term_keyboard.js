'use strict';

export const KeyMap = {
  'Backspace': '\b',
  'Tab': '\t',
  'Enter': '\r',
  'Escape': '\x1b',
  'Home': '\x1b[1~',
  'Insert': '\x1b[2~',
  'Delete': '\x1b[3~',
  'End': '\x1b[4~',
  'PageUp': '\x1b[5~',
  'PageDown': '\x1b[6~',
  'ArrowUp': '\x1b[A',
  'ArrowDown': '\x1b[B',
  'ArrowRight': '\x1b[C',
  'ArrowLeft': '\x1b[D',
  // Edge.
  'Up': '\x1b[A',
  'Down': '\x1b[B',
  'Right': '\x1b[C',
  'Left': '\x1b[D'
};
let CtrlShiftMap = {
  '@': 50,
  '^': 54,
  '_': 109,
  '?': 127,
  '[': 219,
  '\\': 220,
  ']': 221
};
// A -> 1
for (let i = 97; i <= 122; i++) {
  CtrlShiftMap[String.fromCharCode(i)] = i - 96;
}

// Single KeyboardEvent → the escape/byte sequence PTT expects, or null when
// there is no sensible mapping (bare modifiers, F-keys, Alt/Meta combos).
// Used by list_session's native passthrough to SEND THE KEY ITSELF after a
// serialized cursor-sync leg (the event was preventDefaulted, so the normal
// TermKeyboard path never sees it). Mirrors TermKeyboard._onKeyDown/onKeyPress
// minus the double-byte cursor handling (list screens have no DB cursor).
//
// Ctrl-V is NOT special-cased here, unlike in _onKeyDown: this answers "what
// bytes does this key mean to PTT" (objectively \x16), while "which key is
// handed to the browser for paste" is a UI-layer decision. Unreachable anyway —
// list_session.onKeyDown returns on its clipboard whitelist ('c'/'a'/'v'/'x')
// before either _classifyKey or _beginNativePassthrough can call us.
export function keyEventToBytes(e) {
  if (e.altKey || e.metaKey) return null;
  if (e.ctrlKey) {
    if (e.shiftKey) return null;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const code = CtrlShiftMap[key];
    return code ? String.fromCharCode(code) : null;
  }
  const mapped = KeyMap[e.key];
  if (mapped) return mapped;
  if (e.key.length === 1) return e.key;
  return null;
}

// This is where an old upstream FIXME sat: "Under Mac, IME inputs will be sent as
// key of modified char. Need to use key code directly." It is DONE, don't re-open it.
// The only handler that must read a LETTER off an event Mac may have modified is the
// Alt remap, and altRemapCharCode below reads e.code — the modern "key code directly"
// (e.keyCode is deprecated). Nothing else in this class needs it:
//   - Ctrl and Meta are not composing modifiers, so e.key is the plain letter there.
//   - Real IME composition never reaches this class: term_view's keyEventFilter drops
//     keyCode 229 (e.key 'Process') before dispatching, and the composed text arrives
//     via compositionend/input → onTextInput → _convSend instead. See the note above
//     easy_reading.noteTextInput for what that path still has to compensate for.

const ALT_REMAP_LETTERS = 'RTWV';

// The letter an Alt-remap keydown means → its control code ('V' → 22), or null
// when the key isn't one of ours.
//
// e.key first, e.code as the fallback. On Windows/Linux Alt+V reports key 'v', so
// the first branch keeps honouring whatever letter the user's LAYOUT produced.
// macOS is different: Option is a COMPOSING modifier, so ⌥V/⌥R/⌥T/⌥W arrive as
// √(U+221A)/®/†/∑ and e.key is no longer a letter at all — matching on it there
// silently matches nothing (^V, ^R, ^T, ^W all dead on Mac). e.code is the
// physical key position, untouched by Option, and reads 'KeyV' on both platforms.
// Guard the code branch too: e.code is absent on synthesized events.
export function altRemapCharCode(e) {
  const key = typeof e.key === 'string' && e.key.length === 1 ? e.key.toUpperCase() : '';
  if (key && ALT_REMAP_LETTERS.indexOf(key) >= 0)
    return key.charCodeAt(0) - 64;
  const physical = /^Key([A-Z])$/.exec(e.code || '');
  if (physical && ALT_REMAP_LETTERS.indexOf(physical[1]) >= 0)
    return physical[1].charCodeAt(0) - 64;
  return null;
}

export class TermKeyboard {
  // isLeftDB: function() -> bool
  // isCurDB: function() -> bool
  // send: function(data)
  constructor(isLeftDB, isCurDB, send) {
    this._checkLeftDB = isLeftDB;
    this._checkCurDB = isCurDB;
    this._sendFunc = send;
  }

  _send(data) {
    this._sendFunc(data);
    return true;
  }

  _sendCharCode(code) {
    return this._send(String.fromCharCode(code));
  }

  _checkDB(key) {
    switch (key) {
      case 'Backspace':
      case 'ArrowLeft':
        return this._checkLeftDB();
      case 'Delete':
      case 'ArrowRight':
        return this._checkCurDB();
    }
    return false;
  }

  onKeyDown(e) {
    if (this._onKeyDown(e))
      e.preventDefault();
  }

  _onKeyDown(e) {
    // Windows/Command key.
    if (e.getModifierState('Meta')) {
      return false;
    }

    if (!e.ctrlKey && !e.altKey) {
      // Shift-Insert as paste.
      if (e.shiftKey && e.key == 'Insert') {
        return false;
      }

      let mapped = KeyMap[e.key];
      if (mapped) {
        if (this._checkDB(e.key)) {
          return this._send(mapped + mapped);
        } else {
          return this._send(mapped);
        }
      } else if (e.key.length == 1) {
        // Normal char is handled in keypress. See comment in onKeyPress.
        return false;
      }
    } else if (e.ctrlKey && !e.altKey && !e.shiftKey) {
      // Use lowercase no even capslock's on.
      let key = e.key.length == 1 ? e.key.toLowerCase() : e.key;
      // Ctrl-V hands over to the browser's native paste, exactly like the
      // Shift-Insert `return false` above. Sending CtrlShiftMap['v'] = 22 also
      // preventDefaults the keydown, and a cancelled keydown means the browser
      // never generates a `paste` event: the listener on the hidden input #t
      // (pttchrome.jsx) never fires, App.onDOMPaste never runs, and BOTH the
      // text route and imageUpload.tryClipboardImage (screenshot upload) die.
      // Deliberately NOT doPaste() instead — that one only reads clipboard
      // text, which would silently drop pasted images.
      // ^V itself moved to Alt-V (see the alt branch below); it is a real PTT
      // command (pttbbs edit.c Ctrl('V') toggles ANSI color mode, bbs.c
      // read_comms maps it to do_post_vote), and Ctrl-Shift-V is already taken
      // by term_view's doPaste.
      // On macOS this leaves Ctrl-V a DEAD key, and that is deliberate — not a bug
      // to "fix" later. Paste there is Cmd-V, which the Meta check at the top of
      // this function already hands to the browser; Cocoa binds Ctrl-V to
      // scrollPageDown:, so it pastes nothing. Mac users keep both halves anyway
      // (Cmd-V pastes, Alt-V sends ^V). Making this key platform-dependent was
      // considered and rejected: someone on a Windows keyboard reflexively hitting
      // Ctrl-V would then send ^V (toggling ANSI color mode) instead of pasting.
      if (key === 'v') return false;
      let mappedCode = CtrlShiftMap[key];
      if (mappedCode) {
        return this._sendCharCode(mappedCode);
      }
    } else if (!e.ctrlKey && e.altKey && !e.shiftKey) {
      // Remapped keys (r/t/w), which conflict with browser shortcuts. 'v' is here
      // for a different reason: Ctrl-V is not a browser shortcut we work around, it
      // is one we deliberately gave away (see the ctrl branch above), so this is the
      // ONLY way left to send ^V. Capslock and macOS's composed Option chars are
      // both handled by altRemapCharCode.
      const charCode = altRemapCharCode(e);
      if (charCode !== null) {
        // Ctrl+key
        return this._sendCharCode(charCode);
      }
    }
    return false;
  }

  onKeyPress(e) {
    // Firefox on Mac issues keyCode for the key that starts composition (while
    // other browsers send 229), so a normal char is handled using keypress. We
    // can't move all key handling here since ctrl- and alt-compounds are
    // handled by browsers before keypress.
    if (!e.ctrlKey && !e.altKey && e.key.length == 1) {
      e.preventDefault();
      return this._send(e.key)
    }
    return false;
  }
}
