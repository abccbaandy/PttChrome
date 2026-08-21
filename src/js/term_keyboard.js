'use strict';

const KeyMap = {
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

// FIXME: Under Mac, IME inputs will be sent as key of modified char.
// Need to use key code directly.

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
      if (key === 'v') return false;
      let mappedCode = CtrlShiftMap[key];
      if (mappedCode) {
        return this._sendCharCode(mappedCode);
      }
    } else if (!e.ctrlKey && e.altKey && !e.shiftKey) {
      // Remapped keys, which conflict browser shortcuts.
      // Use lowercase no even capslock's on.
      switch (e.key.toLowerCase()) {
        case 'r':
        case 't':
        case 'w':
        // 'v' is here for a different reason than r/t/w: Ctrl-V is not a browser
        // shortcut we work around, it is one we deliberately gave away (see the
        // ctrl branch above), so this is the ONLY way left to send ^V.
        case 'v':
          // Ctrl+key
          return this._sendCharCode(e.key.toUpperCase().charCodeAt(0) - 64);
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
