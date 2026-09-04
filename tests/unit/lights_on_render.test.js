// 「開燈」的渲染接線守護（仿 merge_image_caption_render.test.js）：
//   - 偵測到隱藏文字 ⇒ 浮動按鈕出現；沒偵測到就不出現（原生模式也要出現）；
//   - 點一下在 #mainContainer 加上 .lightsOn（軌 A：容器 class 決定樣式，
//     不重建任何一列），再點一次移除；
//   - 軌 B（server 已擦掉的內容）點下去要呼叫 enhance.onLightsRawMode(2)；
//     只有軌 A 命中時**不可以**動 rawmode（沒必要打擾 server）；
//   - rawMode 已是純文字 ⇒ 按鈕維持「關燈」且照樣出現（畫面上已經沒有隱藏文字
//     可偵測，少了這條使用者會關不掉燈）；
//   - articleId 變（換文章／退出再進）⇒ 軌 A 的 class 重置。
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { MFDISP_RAW_PLAIN } from "../../src/js/pmore_pref";

afterEach(unmountAll);

const color = (fg, bg) => ({
  fg,
  bg,
  blink: false,
  equals(o) {
    return !!o && o.fg === this.fg && o.bg === this.bg && o.blink === this.blink;
  },
});
const NORMAL = color(7, 0);
const HIDDEN = color(0, 0);

function cell(c, col) {
  return {
    ch: c,
    isLeadByte: false,
    isStartOfURL: () => false,
    isEndOfURL: () => false,
    getFullURL: () => null,
    getColor: () => col,
  };
}
const line = (str, col = NORMAL) => str.split("").map((c) => cell(c, col));

const PLAIN_LINES = [line("作者  someone (x) 看板  Test"), line("一般內文")];
// 軌 A：fg===bg 且有字（DBCS 中文那一半沒被 server 擦掉）。
const LIT_LINES = [line("一般內文"), line("hidden", HIDDEN)];
// 軌 B：fg===bg 且是空白（server 擦掉的隱藏網址，實測 60 格）。
const ERASED_LINES = [line("一般內文"), line(" ".repeat(60), HIDDEN)];

const FORCE_WIDTH = 20;

function render(lines, extra) {
  return mountScreen({
    lines,
    forceWidth: FORCE_WIDTH,
    enableLinkInlinePreview: false,
    enableLinkHoverPreview: false,
    enhance: Object.assign(
      { pageState: 3, easyReading: true, dropHidden: true, articleId: 1 },
      extra,
    ),
  });
}

const btn = (c) => c.querySelector("#lightsOnBtn");

describe("開燈按鈕的出現條件", () => {
  test("沒有隱藏文字 → 不出現", () => {
    const s = render(PLAIN_LINES);
    expect(btn(s.container)).toBe(null);
  });

  test("軌 A（有字的隱藏格）→ 出現", () => {
    const s = render(LIT_LINES);
    expect(btn(s.container)).not.toBe(null);
  });

  test("軌 B（被擦成空白的隱藏格）→ 出現", () => {
    const s = render(ERASED_LINES);
    expect(btn(s.container)).not.toBe(null);
  });

  test("原生模式（好讀關閉）一樣出現 —— 隱藏文字在原生也看不見", () => {
    const s = render(LIT_LINES, { easyReading: false });
    expect(btn(s.container)).not.toBe(null);
  });

  test("非文章頁（列表）不出現", () => {
    const s = render(LIT_LINES, { pageState: 2 });
    expect(btn(s.container)).toBe(null);
  });

  test("已切成純文字模式 → 即使畫面上偵測不到隱藏文字也要出現（不然關不掉燈）", () => {
    const s = render(PLAIN_LINES, { rawMode: MFDISP_RAW_PLAIN });
    const b = btn(s.container);
    expect(b).not.toBe(null);
    expect(b.getAttribute("data-lights")).toBe("on");
  });
});

describe("軌 A：容器 class", () => {
  test("點一下加上 .lightsOn，再點一次移除（不重建任何一列）", () => {
    const s = render(LIT_LINES);
    const rowsBefore = Array.from(
      s.container.querySelectorAll('[data-type="bbsline"]'),
    );
    expect(s.container.classList.contains("lightsOn")).toBe(false);
    btn(s.container).click();
    expect(s.container.classList.contains("lightsOn")).toBe(true);
    expect(btn(s.container).getAttribute("data-lights")).toBe("on");
    const rowsAfter = Array.from(
      s.container.querySelectorAll('[data-type="bbsline"]'),
    );
    expect(rowsAfter).toEqual(rowsBefore);
    btn(s.container).click();
    expect(s.container.classList.contains("lightsOn")).toBe(false);
    expect(btn(s.container).getAttribute("data-lights")).toBe("off");
  });

  test("換文章（articleId 變）→ class 被清掉", () => {
    const s = render(LIT_LINES);
    btn(s.container).click();
    expect(s.container.classList.contains("lightsOn")).toBe(true);
    s.update({
      lines: LIT_LINES,
      forceWidth: FORCE_WIDTH,
      enableLinkInlinePreview: false,
      enableLinkHoverPreview: false,
      enhance: {
        pageState: 3,
        easyReading: true,
        dropHidden: true,
        articleId: 2,
      },
    });
    expect(s.container.classList.contains("lightsOn")).toBe(false);
  });
});

describe("軌 B：請 App 切 pmore 的色彩顯示模式", () => {
  test("偵測到被擦掉的內容 → 開燈時要求切成純文字(2)", () => {
    const calls = [];
    const s = render(ERASED_LINES, { onLightsRawMode: (m) => calls.push(m) });
    btn(s.container).click();
    expect(calls).toEqual([MFDISP_RAW_PLAIN]);
  });

  test("只有軌 A 命中 → 不動 rawmode（內容本來就在，沒必要打擾 server）", () => {
    const calls = [];
    const s = render(LIT_LINES, { onLightsRawMode: (m) => calls.push(m) });
    btn(s.container).click();
    expect(calls).toEqual([]);
  });

  test("已在純文字模式時關燈 → 切回預設格式化(0)", () => {
    const calls = [];
    const s = render(PLAIN_LINES, {
      rawMode: MFDISP_RAW_PLAIN,
      onLightsRawMode: (m) => calls.push(m),
    });
    btn(s.container).click();
    expect(calls).toEqual([0]);
  });
});
