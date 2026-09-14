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
  // **altKey 回 null 是刻意的，不要「順手」讓它支援 Alt remap。** 下游 _classifyKey
  // 在呼叫完這裡之後，緊接著就按 e.key 分派白名單：一旦這裡對 Alt 回傳 byte，
  // Alt+J/K/N/P（看板列表還有 Alt+B）會落進 'nav'、Alt+M 落進開文、Alt+0~9 落進
  // jump-digit —— 全部變成「本地動作」而不是送鍵給 PTT，整組 remap 靜默失效。
  // 兩份 session 的 onKeyDown 都已經在 _classifyKey **之前**用 isAltRemapEvent
  // 顯式攔下 Alt remap，那個順序是承重的。
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

// Alt（macOS 的 Option）＝ PTT 的 Ctrl，全 26 字母。本檔的核心不變量：
//
//   **Alt+<letter> 送出的 byte 與 Ctrl+<letter> 逐位元相同；差別只在誰先接手。**
//   Alt 繞過 app 自己的 UI 快捷鍵（複製／全選／貼上 —— 那些 OS 另有入口），
//   但**不繞過**「app 代替 PTT 管狀態」的模擬（好讀模式的 ^F/^B/^H 握著 pmore 的
//   頁指標，裸送會讓長頁與 server 失同步，見 easy_reading.ctrlLetterOf）。
//
// 為什麼要有這條路：macOS 上好幾顆 Ctrl 組合根本按不出來（Cocoa 文字系統把 Ctrl-Y
// 綁成 yank、Ctrl-A/Ctrl-E 綁成行首行尾…），逐顆救火沒有盡頭。給 Alt 一條等價通道
// 之後，往後任何 Ctrl 衝突都有現成退路，不必再改 code。
//
// 協定面安全（已查證 pttbbs 原始碼）：common/sys/vtkbd.c 只認裸 ASCII 控制碼 ＋
// CSI/SS3 序列，**沒有任何 modifier 語意**（ESC[1;5A 的 modifier 參數被直接丟棄）。
// 唯一的 ESC-prefix（Meta）語意在 mbbsd/edit.c，而本 client 從不送 ESC-prefix
// ⇒ Alt→Ctrl 撞不到任何既有解析。詳見 docs/pttbbs-screen-protocol.md §11.8。
//
// 「系統 > 我們」不靠黑名單，靠一個事實：瀏覽器**保留**的快捷鍵根本不會把 keydown
// 送到頁面，收不到就不會 remap ⇒ 零平台偵測、零瀏覽器快捷鍵表。下面這個排除表只放
// 實測到「收得到 keydown、但 preventDefault 之後瀏覽器仍有動作」＝雙重觸發的字母。
// **動它必須同步更新 docs §11.8 的量測表**（量測頁 tools/alt-key-probe.html）。
//
// 2026-09-14 實測 Chrome 152 / Windows 10：26 個字母的 keydown 全部到得了頁面、
// preventDefault 全部攔得住、零組字 ⇒ 排除表為空。
// **但 Alt+D/E/F 在 Chrome 是「可覆寫」快捷鍵**（網址列／選單，不攔就會跑），
// 我們是**選擇**攔下來給 PTT 的（^D TagPruner／^E manage_post／^F 下頁），不是
// 「瀏覽器沒用到」。要還給瀏覽器就把該字母加進這裡。Firefox 的 Alt+F/E/V/S/B/T/H
// 是選單存取鍵，尚未量測，結論可能不同。
export const ALT_REMAP_EXCLUDE = '';
export const ALT_REMAP_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  .split('')
  .filter((c) => ALT_REMAP_EXCLUDE.indexOf(c) < 0)
  .join('');

// The letter an Alt-remap keydown means → its control code ('V' → 22), or null
// when the key isn't one of ours.
//
// e.key first, e.code as the fallback. On Windows/Linux Alt+V reports key 'v', so
// the first branch keeps honouring whatever letter the user's LAYOUT produced.
// macOS is different: Option is a COMPOSING modifier, so e.key is not a letter at
// all there — matching on it alone silently matches nothing. e.code is the physical
// key position, untouched by Option, and reads 'KeyV' on both platforms.
// Guard the code branch too: e.code is absent on synthesized events.
//
// 四種 macOS 形態都只有 e.code 接得住（全 26 字母 remap 之後每一種都會真的出現，
// 不像當年 RTWV 只碰得到第一種）：
//   1. 組字輸出：⌥V/⌥R/⌥T/⌥W → √(U+221A)/®/†/∑，e.key 根本不是字母。
//   2. **dead key**：⌥E/⌥I/⌥N/⌥U 是組合重音的 dead key，e.key === 'Dead'。
//      （它們還會讓 keydown 回報 keyCode 229，得在 term_view 的 keyEventFilter 開例外，
//        否則事件在進到這裡之前就被當成 IME 丟掉 —— 見該處註解。）
//   3. 'ß'.toUpperCase() === 'SS'（長度 2）⇒ 第一個分支的 length===1 守門自動擋掉。
//   4. 'µ'.toUpperCase() 是**希臘大寫 Μ(U+039C)**，不是 ASCII 'M' ⇒ indexOf 不會誤中。
// 反過來 'ı'(U+0131).toUpperCase() === 'I' **會**由 e.key 分支命中 ^I —— 與 e.code
// 的結論一致，無害。
export function altRemapCharCode(e) {
  const key = typeof e.key === 'string' && e.key.length === 1 ? e.key.toUpperCase() : '';
  if (key && ALT_REMAP_LETTERS.indexOf(key) >= 0)
    return key.charCodeAt(0) - 64;
  const physical = /^Key([A-Z])$/.exec(e.code || '');
  if (physical && ALT_REMAP_LETTERS.indexOf(physical[1]) >= 0)
    return physical[1].charCodeAt(0) - 64;
  return null;
}

// 「這個 keydown 是不是一次『Alt 當 Ctrl』的送鍵？」——**四個消費端唯一的判準**：
//   1. TermKeyboard._onKeyDown 的 alt 分支（真正送 byte 的地方）
//   2. list_session.onKeyDown / board_list_session.onKeyDown 的早期攔截
//      （Ctrl 鍵會吃真游標那一列 ⇒ 必須先跑 cursor-sync 腿，見 docs §11.7）
//   3. term_view 的 keyEventFilter（macOS dead key 的 keyCode 229 例外）
//   4. term_view 的組字抑制窗與 live-helper 取消
// 這組條件以前是逐處手抄的，註解還明文要求「必須與 TermKeyboard._onKeyDown 對齊」——
// 手抄必定漂移，而漂移的症狀是**啞巴鍵**（這裡接手了、原生那邊卻不送，按了沒反應）。
// 收斂成一個述詞就沒有對齊問題。
//
// AltGr（Windows US-International）是 ctrlKey+altKey ⇒ 被 !ctrlKey 正確排除；它打出的
// 字元仍走 keypress → #t → onInput 那條路，不可被搶走。
export function isAltRemapEvent(e) {
  return (
    !!e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && altRemapCharCode(e) !== null
  );
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
    } else if (isAltRemapEvent(e)) {
      // Alt（mac 的 Option）＝ PTT 的 Ctrl，全 26 字母，byte 與 Ctrl 版完全相同
      // （不變量與理由見檔頭 ALT_REMAP_EXCLUDE 上方那段）。
      // 'v' 在這裡有額外的份量：Ctrl-V 是我們**主動讓給**瀏覽器貼上的（見上面的 ctrl
      // 分支），所以 Alt-V 是送出 ^V 的唯一管道。
      // 同理 Alt-C/Alt-A/Alt-X 是送出 ^C/^A/^X 的唯一可靠管道 —— Ctrl 版被 term_view
      // 的複製／全選吃掉了（doSelectAll 更是無條件吃）。
      // CapsLock 與 macOS 的 Option 組字輸出都由 altRemapCharCode 處理。
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
