// Big5 DBCS 併字 + 同色分段。原 src/components/Row/ColorSegmentBuilder.js 的純 JS
// 版——邏輯一字未改（它本來就是純 class，只有 build() 的產物從 React element 換成
// DOM 節點），註解沿用。
import WordSegmentBuilder from "./word_segment";
import { b2u, isDBCSLead } from "../js/string_util";
import { WIDE_TRAIL, cellPairs } from "../js/unicode_cells";
import { symbolTable } from "../js/symbol_table";

function isBadDBCS(u) {
  return symbolTable["x" + u.charCodeAt(0).toString(16)] == 3;
}

// 字型 advance 可靠是 1em 的 CJK 區塊（中日文字型的設計格就是 1em 方框）：部首、CJK 標點、
// 假名、注音、漢字、相容漢字、直排／小型標點、全形字。
// 刻意**不含**韓文（Hangul 字母／音節、相容字母、帶圈／括號韓文、KS X 1001 帶進來的 ㎏ ㎡ 方塊
// 單位）與彝文：East Asian Width 雖是 W，韓文字型的 advance 不是 1em（macOS 的 Apple SD
// Gothic Neo ≈ 0.87em），彝文多半沒字型、fallback 成窄字 ⇒ 交給撐寬。
// 守護 tests/unit/dbcs_cell_width.test.js（規則）、unicode_cells_render.test.js（韓文格線）。
function isCjkWide(c) {
  return (
    (c >= 0x2e80 && c <= 0x2ffb) ||
    (c >= 0x3000 && c <= 0x302d) ||
    (c >= 0x3030 && c <= 0x303e) ||
    (c >= 0x3041 && c <= 0x312f) ||
    (c >= 0x3190 && c <= 0x31ee) ||
    (c >= 0x31f0 && c <= 0x31ff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xf900 && c <= 0xfa2d) ||
    (c >= 0xfa30 && c <= 0xfa6d) ||
    (c >= 0xfe10 && c <= 0xfe19) ||
    (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff01 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6)
  );
}

// 非 ASCII 字是否要包成固定寬（forceWidth＝兩格）的 .wpadding。
// Big5 的 DBCS 字在終端機上一律佔 2 欄，但字型的 advance 只有 CJK 區塊可靠是 1em；
// 其餘（× ‼ … ─ ● Α Ω、圈數字、UAO 的 PUA…）在 Unicode 是窄字或 Ambiguous，
// 終端機字型沒收該字形就 fallback 成西文字型的 1 格 ⇒ 該列後半整排左移。
// 不能列白名單：哪些字有收取決於使用者的字型（local MingLiu／SymMingLiu／系統
// fallback），所以 CJK 區塊以外一律撐寬。守護 tests/unit/dbcs_cell_width.test.js。
export function shouldForceWidth(u) {
  const c = u.charCodeAt(0);
  return c >= 0x80 && !isCjkWide(c);
}

export class ColorSegmentBuilder {
  constructor(forceWidth) {
    this.segs = [];
    this.wordBuilder = WordSegmentBuilder.NullObject;
    this.forceWidth = forceWidth;
    this.lead = null;
  }

  beginSegment(color) {
    this.segs.push(this.wordBuilder.build());
    this.wordBuilder = new WordSegmentBuilder(color);
  }

  appendNormalChar(text, color) {
    if (!this.wordBuilder.isLastSegmentSameColor(color))
      this.beginSegment(color);
    this.wordBuilder.appendNormalText(text);
  }

  // UTF-8 線路的半形 Unicode 格（js/unicode_cells.js）：Big5 收不下的半形字（ġ、
  // 泰文、阿拉伯文…）。終端機字型多半沒收這些字形，fallback 字型的 advance 不是半個
  // 全形寬 ⇒ 跟全形字一樣固定寬度（半格，.hpadding）。左半被蓋掉的孤兒右半格畫成 ?
  // （與 Big5 的半個字同一個降級；server 的 pfterm 也會補送 ?）。
  appendUnicodeNarrowCell(ch) {
    const color = ch.getColor();
    if (ch.ch === WIDE_TRAIL || !this.forceWidth) {
      this.appendNormalChar(ch.ch === WIDE_TRAIL ? "?" : ch.ch, color);
      return;
    }
    if (!this.wordBuilder.isLastSegmentSameColor(color))
      this.beginSegment(color);
    this.wordBuilder.appendHalfWidthWord(ch.ch, this.forceWidth / 2);
  }

  readChar(ch) {
    if (!this.lead) {
      if (isDBCSLead(ch.ch)) {
        this.lead = ch;
        return;
      }

      if (ch.ch.charCodeAt(0) > 0xff) {
        this.appendUnicodeNarrowCell(ch);
        return;
      }
      this.appendNormalChar(ch.ch, ch.getColor());
      return;
    }
    const { lead } = this;
    const leadColor = lead.getColor();
    this.lead = null;
    if (!cellPairs(lead.ch, ch.ch)) {
      this.appendNormalChar(lead.ch, leadColor);
      this.readChar(ch);
      return;
    }
    const text = b2u(lead.ch + ch.ch);
    if (text.length !== 1) {
      // Conversion error.
      this.appendNormalChar("?", leadColor);
      this.appendNormalChar(ch.ch == "\x20" ? " " : "?", ch.getColor());
      return;
    }
    if (isBadDBCS(text)) {
      this.appendNormalChar("?", leadColor);
      this.appendNormalChar("?", ch.getColor());
      return;
    }
    if (!leadColor.equals(ch.getColor())) {
      this.beginSegment(leadColor);
      this.wordBuilder.appendTwoColorWord(
        text,
        leadColor,
        ch.getColor(),
        this.forceWidth,
      );
      return;
    }
    const forceWidth = shouldForceWidth(text) ? this.forceWidth : 0;
    if (!forceWidth) {
      this.appendNormalChar(text, leadColor);
      return;
    }
    if (!this.wordBuilder.isLastSegmentSameColor(leadColor))
      this.beginSegment(leadColor);
    this.wordBuilder.appendForceWidthWord(text, forceWidth);
  }

  // 回傳 DOM 節點陣列（可能夾雜 null —— NullObject 的起手式，由 dom.el 跳過）。
  build() {
    // 列尾懸著的全形 Unicode 左半格（沒有右半）照原樣畫；Big5 的半個字維持丟掉。
    if (this.lead && !cellPairs(this.lead.ch, "")) {
      this.appendNormalChar(this.lead.ch, this.lead.getColor());
      this.lead = null;
    }
    this.beginSegment();
    return this.segs;
  }
}

ColorSegmentBuilder.accumulator = (builder, ch) => {
  builder.readChar(ch);
  return builder;
};

export default ColorSegmentBuilder;
