// 「開燈」：隱藏文字（前景色 == 背景色）的逐列偵測（純函式，無 DOM）。
//
// PTT 的隱藏文字慣例是把字用低亮度黑字寫在黑底上（`ESC[30m`），讀者按 `\`
// 切成純文字模式「開燈」。本專案要做的是把它變成一顆按鈕，但**有一半救不回來**：
//
// PTT server 在送出畫面之前就把「fg == bg」的**半形**格換成空白了
// （`mbbsd/pfterm.c` 的 `PFTERM_DISABLE_HIDDEN_MESSAGE`，條件精確等於
// 「fg == bg 且 BOLD=0 且 BLINK=0 且 自己與下一格都不是 DBCS」）。所以：
//
//   軌 A  fg===bg 且**有字** ── DBCS（中文）與帶 BLINK 的半形沒被擦掉，
//                              真的送到瀏覽器了 ⇒ 純 CSS 提亮即可（.lightsOn）。
//   軌 B  fg===bg 且**是空白** ── 內容根本沒送過來，本地怎麼改 CSS 都救不回來
//                              ⇒ 只能替使用者切 rawmode 讓 server 重送。
//
// 兩條都已由使用者自建的測試文逐格實證（同一篇文章的兩種模式對照，見
// docs/pttbbs-screen-protocol.md）：`abc test2`（9 個半形）整段被擦成空白，
// `中文測試2` 的四個中文原樣送達、末尾那個半形 `2` 被擦掉一格。
//
// 判準刻意只有一條 `fg === bg`，一條式涵蓋 `ESC[30m`／`ESC[30;40m`／`ESC[34;44m`／
// `ESC[37;47m`／`ESC[7;30;40m`（reverse 編碼）。**刻意不涵蓋** `ESC[1;30m`
// （fg=8 深灰）—— 那是 pmore 進設定頁時 grayout 整片上半畫面用的，判準若寫成
// `fg===0` 會在每次按 `\` 時整頁誤判。也**不要**加「顏色相近」的模糊判定。
//
// 顏色一律經 `TermChar.getColor()` 取（它內部就是 getFg()/getBg()，已把 bright 與
// invert 攤平）。**不要改成直接呼叫 getFg/getBg**：`getColor` 是渲染鏈對 TermChar
// 的既有介面（row/word_segment 每一格都在用），測試 fixture 也只實作那六個成員。
//
// 守護：tests/unit/hidden_text.test.js（每一條都對應一個實測樣本）。

// 軌 B 的連續空白格門檻，依背景色分兩組——單一數字不是漏抓就是誤報。
//
//   黑底（bg === 0，＝PTT 文章的常態）：`fg=0/bg=0` 的空白**只可能**來自 server
//     明確送過 `ESC[30m`／`ESC[30;40m`。`ESC[K` 擦出來的格走 `copyFromNewChar()`
//     → `resetAttr()` ⇒ fg=7/bg=0，**不繼承當前 SGR**，不會製造假訊號。取 2 只是
//     避開單格裝飾（實測真樣本是 9 格與 60 格）。
//   彩底（bg !== 0）：狀態列／選單有大量彩底空白。實測誤報：文章狀態列 `ESC[0;47m`
//     之後有 2 格 fg=7/bg=7 —— 門檻 8 正好把它擋掉，這也是「掃描不必特別排除
//     狀態列」的原因（排除最後一列會破壞好讀累積長頁的逐列獨立性）。
export const ERASED_RUN_MIN_DARK = 2;
export const ERASED_RUN_MIN_COLOR = 8;

function isBlankCell(ch) {
  // '' 是 UTF-8 模式下全形字的右半格（term_buf.puts）；沒有字形，與空白同義。
  return ch.ch === ' ' || ch.ch === '' || ch.ch === '\u0000';
}

// 一列（TermChar[]）→ { lit, erased }。
//   lit    ── 這一列有軌 A 的隱藏字（本地提亮救得回來）
//   erased ── 這一列有軌 B 的隱藏字（server 已擦掉，只能切 rawmode 重取）
//
// **逐列獨立**：不看鄰列、不看列號。好讀累積長頁的增量重算（只掃新增的列再累加）
// 因此與全量重算等價，見 screen_annotations.js 的 `from` 迴圈。
export function detectHiddenRow(chars) {
  let lit = false;
  let erased = false;
  let runLen = 0;
  let runBg = -1;
  const flushRun = () => {
    if (!runLen) return;
    const min = runBg === 0 ? ERASED_RUN_MIN_DARK : ERASED_RUN_MIN_COLOR;
    if (runLen >= min) erased = true;
    runLen = 0;
    runBg = -1;
  };
  for (let i = 0; i < chars.length; ++i) {
    const ch = chars[i];
    const c = ch && ch.getColor ? ch.getColor() : null;
    if (!c || c.fg !== c.bg) {
      flushRun();
      continue;
    }
    if (!isBlankCell(ch)) {
      lit = true;
      flushRun();
      continue;
    }
    if (runLen && c.bg !== runBg) flushRun();
    runBg = c.bg;
    ++runLen;
  }
  flushRun();
  return { lit, erased };
}
