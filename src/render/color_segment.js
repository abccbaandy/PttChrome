// Big5 DBCS 併字 + 同色分段。原 src/components/Row/ColorSegmentBuilder.js 的純 JS
// 版——邏輯一字未改（它本來就是純 class，只有 build() 的產物從 React element 換成
// DOM 節點），註解沿用。
import WordSegmentBuilder from "./word_segment";
import { b2u, isDBCSLead } from "../js/string_util";
import { symbolTable } from "../js/symbol_table";

function isBadDBCS(u) {
  return symbolTable["x" + u.charCodeAt(0).toString(16)] == 3;
}

// Unicode East Asian Width = W/F 的 CJK 區塊：任何 CJK 字型的 advance 都是 1em。
function isCjkWide(c) {
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0x303e) ||
    (c >= 0x3041 && c <= 0x33ff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xa000 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
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

  readChar(ch) {
    if (!this.lead) {
      if (isDBCSLead(ch.ch)) {
        this.lead = ch;
        return;
      }

      this.appendNormalChar(ch.ch, ch.getColor());
      return;
    }
    const { lead } = this;
    const leadColor = lead.getColor();
    this.lead = null;
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
    this.beginSegment();
    return this.segs;
  }
}

ColorSegmentBuilder.accumulator = (builder, ch) => {
  builder.readChar(ch);
  return builder;
};

export default ColorSegmentBuilder;
