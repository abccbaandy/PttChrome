// 同色文字段 → DOM。原 src/components/Row/WordSegmentBuilder/（index.jsx +
// ColorSpan / TwoColorWord / ForceWidthWord 四檔）的純 JS 版，四合一。
//
// 產物與舊版逐字相同：
//   ColorSpan       <span class="q{fg} b{bg} [qq{bg}]">…</span>
//   ForceWidthWord  <span class="wpadding" style="display: inline-block; width: Npx;">字</span>
//   TwoColorWord    <span class="…" style="…" data-text="字">字</span>
//
// .wpadding 是硬契約：term_view.fixedResize() 直接 querySelectorAll('.wpadding')
// 逐個改 style.width（字級縮放）。改 class 名等於讓縮放靜默失效。
import cx from "classnames";
import { el } from "./dom";

export function forceWidthStyle(forceWidth) {
  return forceWidth
    ? { display: "inline-block", width: `${forceWidth}px` }
    : undefined;
}

function forceWidthWord(inner, forceWidth) {
  return el(
    "span",
    { class: "wpadding", style: forceWidthStyle(forceWidth) },
    inner,
  );
}

// 一個全形字的頭尾兩格屬性不同時走這裡：字身用尾色，頭色靠 .o::after 疊一份
// content:attr(data-text) 的複製字、裁掉右半；背景兩半用 .bAbB 漸層。
//
// qq2 = 這條路徑的閃爍（對應一般色段 build() 的 qq{bg}）。ColorState.equals 比
// fg/bg/**blink**，所以只要有一格在閃就會落到這裡，上游卻完全沒接 ⇒ 整個字不閃。
// **整字一起閃**，不做半形精度：::after 是疊在字身上的複製字而不是遮罩，單獨關掉
// 它只會露出底下那份字身。兩格 blink 屬性不同本來就代表 server 寫了半個字。
function twoColorWord(textValue, colorLead, colorTail, forceWidth) {
  return el(
    "span",
    {
      class: cx({
        [`q${colorLead.fg}`]: colorLead.fg === colorTail.fg,
        [`w${colorLead.fg}`]: colorLead.fg !== colorTail.fg,
        [`q${colorTail.fg}`]: colorLead.fg !== colorTail.fg,
        o: colorLead.fg !== colorTail.fg,
        [`b${colorLead.bg}`]: colorLead.bg === colorTail.bg,
        [`b${colorLead.bg}b${colorTail.bg}`]: colorLead.bg !== colorTail.bg,
        qq2: colorLead.blink || colorTail.blink,
        wpadding: forceWidth,
      }),
      style: forceWidthStyle(forceWidth),
      "data-text": textValue,
    },
    textValue,
  );
}

export class WordSegmentBuilder {
  constructor(colorState) {
    this.colorState = colorState;
    this.inner = [];
  }

  isLastSegmentSameColor(color) {
    return this.colorState.equals(color);
  }

  appendNormalText(textValue) {
    const last = this.inner[this.inner.length - 1];
    if (typeof last === "string") {
      this.inner[this.inner.length - 1] = last + textValue;
    } else {
      this.inner.push(textValue);
    }
  }

  appendForceWidthWord(textValue, forceWidth) {
    this.inner.push(forceWidthWord(textValue, forceWidth));
  }

  appendTwoColorWord(textValue, colorLead, colorTail, forceWidth) {
    this.inner.push(twoColorWord(textValue, colorLead, colorTail, forceWidth));
  }

  build() {
    const c = this.colorState;
    return el(
      "span",
      {
        class: cx(`q${c.fg}`, `b${c.bg}`, { [`qq${c.bg}`]: c.blink }),
      },
      this.inner,
    );
  }
}

// 起手式的空 builder：還沒有任何顏色段時 build() 什麼都不產（對應舊版回 false，
// 由 React 當成「不 render」；這裡回 null，appendChildren 一樣跳過）。
WordSegmentBuilder.NullObject = {
  isLastSegmentSameColor() {
    return false;
  },
  build() {
    return null;
  },
};

export default WordSegmentBuilder;
