// PTT 畫面上「功能鍵提示列」的解析 —— 純函式，零 DOM、零狀態。
//
// 目的：把 `[←]離開 [→]閱讀 [Ctrl-P]發表文章 [d]刪除 …` 與
// ` 文章選讀  (y)回應(X)推文(^X)轉錄 …` 裡的每一組括號變成可點按鈕。
//
// pttbbs 原始碼校準（依 CLAUDE.md「PTT 邏輯不准猜」逐條查證，不是從畫面反推）：
//   mbbsd/bbs.c:663      readtitle()：showtitle() 佔 row 0，緊接 outs("[←]離開 …\n")
//                        ⇒ 看板文章列表的提示列固定在 **row 1**
//   mbbsd/board.c:1330   看板列表：outs("[←][q]回上層 [→][r]閱讀 [↑↓]選擇 …\n")
//                        ⇒ 同樣在 row 1
//   mbbsd/vtuikit.c:722  vs_footer()：一律 move(b_lines, 0) ⇒ 固定在**最後一列**；
//                        `(` / `)` 在該函式裡有獨立配色，是「一個按鍵」的視覺約定
//   mbbsd/pmore.c:2195   文章 footer part3 = "(h)按鍵說明 " + "←[q]離開 "
//                        （`←` 是裸的、沒有括號 ⇒ 依規則不可點；相鄰的 `[q]` 可點且同義）
//   mbbsd/pmore.c:2548   KEY_LEFT 與 'q' 同義（flExit = 1）
//
// **複合鍵逐鍵可點**（2026-09）。`(=[]<>)`（同標題前後篇）、`(/?a)`（搜尋）、
// `(v/V)`（已讀／未讀）、`(R/y)`、`[↑↓]` 這種多鍵組拆成逐個 atom，各自一顆按鈕，
// 「指哪就觸發該鍵」。**絕不可以「取第一個鍵」**：`v` 標已讀 vs `V` 標未讀、
// `d` 刪一封 vs `D` 刪範圍，語意完全相反。拆解規則是**全有全無**——只要有一個字
// 認不出來（`(^Z/F1)` 的 `F1` 查不到 byte、`(0-9)` 是範圍寫法而不是三個鍵），
// **整組**維持純文字，這就是「PTT 邏輯不准猜」在這裡的落點。見 tokenizeKeyGroup。
//
// 邊界（使用者 2026-09 定案 D3）：單鍵組維持「整組含括號可點」（零回歸、hit area
// 大）；複合組**只有 atom 本身可點**，`(` `)` `[` `]` `/` 維持純文字。`(v/V)` 的
// `v` 因此只有一格寬 —— 那是「指哪就觸發該鍵」的必然代價，**不准**在 renderer／CSS
// 加 padding 補回來（會位移等寬格線、破壞 .wpadding 的寬度契約，見 docs/mouse.md）。
//
// **一定要吃 TermChar[] 而不是 rowToText 的產物**：rowToText 把 DBCS 的 lead+trail
// 兩格折成一個字元 ⇒ 文字 index ≠ 格子 col，而 footer 一列有十幾個全形字，偏移是
// 累加的。且 `]` = 0x5D **落在 Big5 trail byte 範圍內**，對裸位元組跑 regex 會誤命中。
// 專案既有慣例是逐格走 chars、isLeadByte 就跳兩格（先例：mention_parse.js、
// bare_domain.js、aid_parse.js），這裡照做。

import { b2u, unescapeStr } from './string_util';
import { KeyMap } from './term_keyboard';

// 具名鍵 → 送出的 byte 序列。**一律轉接 KeyMap**（term_keyboard 的同一份表），
// 不另抄第三份，否則哪天改了跳脫序列這裡會靜默對不上。
const NAMED_KEYS = {
  '←': KeyMap['ArrowLeft'],
  '→': KeyMap['ArrowRight'],
  '↑': KeyMap['ArrowUp'],
  '↓': KeyMap['ArrowDown'],
  'PgUp': KeyMap['PageUp'],
  'PgDn': KeyMap['PageDown'],
  'Home': KeyMap['Home'],
  'End': KeyMap['End'],
  'Enter': KeyMap['Enter'],
  'Esc': KeyMap['Escape'],
  'Tab': KeyMap['Tab'],
  'Del': KeyMap['Delete'],
  '空白鍵': ' '
};

// 具名鍵的比對**大小寫不敏感**：pttbbs 同一顆鍵在不同檔案裡寫法不一致
// （`enter` announce.c:271／`TAB` talk.c:1355／`END`・`DEL` psb.c:205,648）。
// 這張表是「小寫名 → 原名」的反查索引，NAMED_KEYS 本身維持原樣（可讀）。
const NAMED_KEYS_CI = (() => {
  const m = new Map();
  for (const k of Object.keys(NAMED_KEYS)) m.set(k.toLowerCase(), NAMED_KEYS[k]);
  return m;
})();

// 串接掃描時要優先吃掉的多字元具名鍵，**長的排前面**（`Enter` 必須贏過 `End`）。
const NAMED_KEYS_BY_LEN = Object.keys(NAMED_KEYS)
  .filter((k) => k.length > 1)
  .sort((a, b) => b.length - a.length);

// `Ctrl-P` / `Ctrl-p` / `CTRL-P` → `^P`（再交給 unescapeStr）。PTT 兩種寫法都出現過
// （bbs.c 用 `[Ctrl-P]`、pmore/編輯器用 `(^X)`）。
const CTRL_RE = /^Ctrl-([@-_?])$/i;

// 一列的 TermChar[] → { text, colOf }。
// text 的折疊規則與 comment_parse.rowToText **完全相同**（含 b2u）；
// colOf[k] = 第 k 個文字字元的**起始格號**，長度 = text.length + 1，
// 最後一項是列尾（＝chars.length），供 exclusive 邊界直接取用。
export function decodeRowWithCols(chars) {
  let text = '';
  const colOf = [];
  if (!chars) return { text, colOf: [0] };
  for (let i = 0; i < chars.length; ++i) {
    const c = chars[i];
    if (!c) continue;
    colOf.push(i);
    if (c.isLeadByte) {
      const next = chars[i + 1];
      const b5 = c.ch + (next ? next.ch : '');
      text += b5.length === 1 ? b5 : b2u(b5);
      i++; // 跳過 trail byte
    } else {
      text += c.ch;
    }
  }
  colOf.push(chars.length);
  return { text, colOf };
}

// 括號內那一串 → 要送出的 bytes（不是單一按鍵則回 null）。
export function keyBytesFor(inner) {
  if (!inner) return null;
  const named = NAMED_KEYS_CI.get(inner.toLowerCase());
  if (named != null) return named;
  const ctrl = CTRL_RE.exec(inner);
  if (ctrl) {
    // unescapeStr 只認大寫的 ^@..^_（與 ^?），先正規化。
    return unescapeStr('^' + ctrl[1].toUpperCase());
  }
  if (inner.length === 2 && inner.charAt(0) === '^') {
    const out = unescapeStr(inner);
    // 不是合法的 caret notation 時 unescapeStr 會原樣吐回（長度仍是 2）。
    return out.length === 1 ? out : null;
  }
  if (inner.length === 1) {
    const code = inner.charCodeAt(0);
    // ASCII 可見字元才算按鍵。空白與 DEL 以上一律不認。
    if (code > 0x20 && code < 0x7f) return inner;
  }
  return null;
}

// **範圍寫法**（`0-9` `1-9` `2 - 9` `0~255`）—— 是「從 x 到 y」而不是三個鍵。
// 必須排在 keyBytesFor 之後檢查：`Ctrl-P` 也符合這條 regex。
const RANGE_RE = /^[0-9A-Za-z]+\s*[-~]\s*[0-9A-Za-z]+$/;

// 括號內容 → `[{ text, keyBytes } | { sep: true, text }]`；**認不出來回 null**
// （＝整組維持純文字）。回傳的 text 串接起來**必等於 inner**，呼叫端靠這點算位移。
//
// 規則順序不可調換：
//   1. 整組本來就是一個鍵（`Ctrl-P` `^X` `PgUp` `y`）→ 一個 atom。**必須最前面**，
//      否則 `Ctrl-P` 會被第 2 條的範圍規則吃成「Ctrl 到 P」。
//   2. 範圍寫法 → null。
//   3. 含 `/` 且切完每段都非空 → **每一段都必須恰好是一個 atom**，否則整組 null
//      （放寬成「段內可再串接」會把 `^Z/F1` 拆成 `^Z`,`F`,`1`＝憑空捏造按鍵）。
//      `/` 本身輸出成 `{sep:true}`，不可點。
//      注意 `(/?a)`：切出來第一段是空字串 ⇒ 不走這條，落到第 4 條串接掃描。
//   4. 串接掃描：多字元具名鍵（長的優先）→ `Ctrl-X`／`^X` → 單一 ASCII 可見字元；
//      任何一步認不出來就整組 null。
export function tokenizeKeyGroup(inner) {
  if (!inner) return null;

  const whole = keyBytesFor(inner);
  if (whole != null) return [{ text: inner, keyBytes: whole }];

  if (RANGE_RE.test(inner)) return null;

  if (inner.indexOf('/') >= 0) {
    const parts = inner.split('/');
    if (parts.every((p) => p.length > 0)) {
      const out = [];
      for (let k = 0; k < parts.length; ++k) {
        if (k) out.push({ sep: true, text: '/' });
        const bytes = keyBytesFor(parts[k]);
        if (bytes == null) return null;
        out.push({ text: parts[k], keyBytes: bytes });
      }
      return out;
    }
  }

  // **串接裡出現數字幾乎一定是「一個數值」而不是「一個一個鍵」。**
  // 現場：pmore 狀態列的百分比 —— 新版 `(%3d%%)`（pmore.c:2144）在 100 時沒有
  // 前導空白 ⇒ `(100%)`；舊版狀態列 `(%d%%)`（pmore.c:2125）連 53 都沒有 ⇒
  // `(53%)`。不擋的話這一列會多出 `1` `0` `0` `%` 四顆**送得出去**的按鈕，
  // 而 `%` 在 pmore 是推文、數字是跳頁（more.c / pmore.c 的獨立 case）。
  // pttbbs 全站真正的複合鍵組沒有一組含數字（唯一的 `[0wb]` 長在 getdata 提示上，
  // 另由「輸入欄開著不畫按鈕」那條擋掉）。
  // 這條只管串接：單鍵組（`(1)`）走規則 1、範圍（`(0-9)`）走規則 2，都不受影響。
  if (/[0-9]/.test(inner)) return null;

  const out = [];
  let i = 0;
  scan: while (i < inner.length) {
    for (const name of NAMED_KEYS_BY_LEN) {
      const cand = inner.substr(i, name.length);
      if (cand.toLowerCase() === name.toLowerCase()) {
        out.push({ text: cand, keyBytes: NAMED_KEYS[name] });
        i += name.length;
        continue scan;
      }
    }
    // `Ctrl-X`（6 字）與 caret notation `^X`（2 字）。
    for (const len of [6, 2]) {
      if (i + len > inner.length) continue;
      const cand = inner.substr(i, len);
      const bytes = keyBytesFor(cand);
      if (bytes != null) {
        out.push({ text: cand, keyBytes: bytes });
        i += len;
        continue scan;
      }
    }
    const one = inner.charAt(i);
    const bytes = keyBytesFor(one);
    if (bytes == null) return null; // 全有全無
    out.push({ text: one, keyBytes: bytes });
    i += 1;
  }
  return out.length ? out : null;
}

// 純字串層的 token 掃描（好寫 unit）。回傳的 start/end 是**文字空間**的 index，
// end 為 exclusive。**每個 atom 一筆**：
//
//   單鍵組（`[d]` `(y)` `[PgUp]`）  範圍**含括號**——邊界因此必落在 ASCII 的
//                                   `(` `[` `)` `]` 上，絕不會切在 DBCS 的 trail
//                                   cell 中間，順帶讓點擊區大一點（維持現況）。
//   複合組（`[↑↓]` `(v/V)`）        範圍**只有 atom 本身**，括號與 `/` 維持純文字
//                                   （D3：「指哪就觸發該鍵」不容許把 `/` 或 `)`
//                                   算進某一顆按鈕）。每個 atom 都是完整字元，
//                                   所以邊界一樣不會切在 trail cell 上。
export function findFunctionKeyTokens(text) {
  const out = [];
  if (!text) return out;
  for (let i = 0; i < text.length; ++i) {
    const open = text.charAt(i);
    const close = open === '[' ? ']' : open === '(' ? ')' : null;
    if (!close) continue;
    const end = text.indexOf(close, i + 1);
    if (end < 0) continue;
    const inner = text.slice(i + 1, end);
    // 巢狀／跨組保護。`(` 組**允許** inner 含 `[` `]`（`(=[]<>)` 的方括號就是兩顆
    // 按鍵本身），仍禁止圓括號；`[` 組維持「不得含任何括號」。
    if (open === '[' ? /[[\]()]/.test(inner) : /[()]/.test(inner)) continue;
    const atoms = tokenizeKeyGroup(inner);
    if (!atoms) continue;
    if (atoms.length === 1 && atoms[0].text === inner) {
      out.push({ start: i, end: end + 1, inner, label: open + inner + close });
    } else {
      let at = i + 1; // inner 的第一個字元
      for (const a of atoms) {
        if (!a.sep)
          out.push({
            start: at,
            end: at + a.text.length,
            inner: a.text,
            label: a.text
          });
        at += a.text.length;
      }
    }
    i = end; // 同一組括號不重複掃
  }
  return out;
}

// TermChar[] → 格子空間的可點功能鍵。
// endCol 為 **exclusive**，與 aids / mentions 同語意（LinkSegmentBuilder.readChar 的 i）。
export function parseFunctionKeys(chars) {
  if (!chars || !chars.length) return null;
  const { text, colOf } = decodeRowWithCols(chars);
  const tokens = findFunctionKeyTokens(text);
  if (!tokens.length) return null;
  const out = [];
  for (const t of tokens) {
    const startCol = colOf[t.start];
    const endCol = colOf[t.end];
    if (startCol == null || endCol == null || endCol <= startCol) continue;
    out.push({
      startCol,
      endCol,
      keyBytes: keyBytesFor(t.inner),
      label: t.label
    });
  }
  return out.length ? out : null;
}

// 這個畫面要掃哪幾列。
//
// **由 term_view 算好交給 computeAnnotations**，不在標註層自行推導：好讀累積長頁的
// lines 是 buf.pageLines（數千列），`lines.length - 1` 是**內文最後一行**而不是狀態
// 列，推導必錯。回 null ＝這個畫面沒有功能鍵列。
export function functionKeyRows(pageState, rows) {
  if (!rows || rows < 2) return null;
  switch (pageState) {
    // 1 MENU（主功能表／看板列表）、2 LIST（文章列表）、4 LIST 變體：
    // 提示列在 row 1（bbs.c:663 / board.c:1330），vs_footer 在最後一列。
    case 1:
    case 2:
    case 4:
      return [1, rows - 1];
    // 3 READING：pmore 只有底部 footer。
    case 3:
      return [rows - 1];
    default:
      return null;
  }
}
