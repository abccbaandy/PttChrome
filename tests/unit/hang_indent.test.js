// @unit-env browser
// 手機好讀文章折行後的懸掛縮排（P86，js/hang_indent.js、main.css `.hangIndent`）。
// 症狀：換行版面把 80 欄的列折行，行首用空白排好的段落（盤後漲停名單、條列第二行）續行一律
// 回到最左邊，夾在兩行縮排之間像另一行字。
// 鎖：①縮排格數（半形、全形、混合）與不套的情況②真樣式下續行左緣對齊第一行文字③文字不變
// （複製不變）④開關關掉、或不在換行版面（桌機 golden）時一個屬性都不加。
import mainCss from "../../src/css/main.css?raw";
import { hangIndentOf, HANG_MAX_CELLS } from "../../src/js/hang_indent";
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { row, seg, link, SCENARIOS } from "./helpers/screen_fixtures";
import { annotationsKey, sameKey } from "../../src/js/screen_annotate_cache";

let style;
beforeAll(() => {
  style = document.createElement("style");
  style.textContent = mainCss;
  document.head.appendChild(style);
});
afterAll(() => style.remove());
afterEach(() => unmountAll());

describe("hangIndentOf", () => {
  test("半形、全形、混合各算各的", () => {
    expect(hangIndentOf("    某某、某某")).toEqual({ half: 4, full: 0 });
    expect(hangIndentOf("　　段落開頭")).toEqual({ half: 0, full: 2 });
    expect(hangIndentOf("  　 混合")).toEqual({ half: 3, full: 1 });
  });

  test("行首沒有空白、整列空白、超過上限都不套", () => {
    expect(hangIndentOf("一般段落")).toBeNull();
    expect(hangIndentOf("")).toBeNull();
    expect(hangIndentOf("        　   ")).toBeNull();
    expect(hangIndentOf(" ".repeat(HANG_MAX_CELLS + 1) + "置中標題")).toBeNull();
    expect(hangIndentOf(" ".repeat(HANG_MAX_CELLS) + "x")).toEqual({
      half: HANG_MAX_CELLS,
      full: 0,
    });
    // 全形一個算兩格。
    expect(hangIndentOf("　".repeat(HANG_MAX_CELLS / 2 + 1) + "x")).toBeNull();
  });
});

const easy = SCENARIOS.find((s) => s.name === "article_easy_reading");
const NAMES = "虹、鈺邦、旭-KY、聯發科、台積電、鴻海、廣達、緯創、英業達、仁寶、和碩、華碩";
const LINES = [
  ...easy.lines.slice(0, 4),
  row(seg("漲停：")),
  row(seg("      " + NAMES)),
  row(seg("　　" + NAMES)),
  row(seg(NAMES)),
];
const INDENTED = 5;
const FULLWIDTH = 6;
const PLAIN = 7;

function mount(hangIndent, reflow = true) {
  const m = mountScreen({
    ...easy,
    lines: LINES,
    enhance: { ...easy.enhance, commentCards: reflow, hangIndent },
  });
  if (reflow) m.root.classList.add("mobileReflow");
  m.root.style.width = "320px";
  m.root.style.fontSize = "20px";
  m.root.style.lineHeight = "20px";
  return m;
}

const rowNode = (m, r) => m.container.querySelector(`span[type="bbsrow"][srow="${r}"]`);

// 每一行（line box）最左邊那個字的 x。用 Range 逐字量，第一個非空白字的 x 是第一行的
// 文字起點，之後每換一行的第一個字是續行起點。
function lineStarts(node) {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const starts = [];
  let lastTop = null;
  let firstText = null;
  const left = node.getBoundingClientRect().left;
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    for (let i = 0; i < t.length; ++i) {
      const ch = t.data[i];
      const r = document.createRange();
      r.setStart(t, i);
      r.setEnd(t, i + 1);
      const rect = r.getClientRects()[0];
      if (!rect || !rect.width) continue;
      if (lastTop === null || rect.top > lastTop + 5) {
        starts.push(rect.left - left);
        lastTop = rect.top;
      }
      if (firstText === null && ch.trim()) firstText = rect.left - left;
    }
  }
  return { starts, firstText };
}

describe("換行版面的真樣式", () => {
  test("半形縮排：續行左緣對齊第一行的第一個字", () => {
    const m = mount(true);
    const node = rowNode(m, INDENTED);
    expect(node.classList.contains("hangIndent")).toBe(true);
    const { starts, firstText } = lineStarts(node);
    expect(starts.length).toBeGreaterThan(1);
    expect(starts[0]).toBeLessThan(1);
    for (const s of starts.slice(1)) expect(Math.abs(s - firstText)).toBeLessThan(1.5);
  });

  test("全形縮排：續行對齊兩個全形空白之後", () => {
    const m = mount(true);
    const node = rowNode(m, FULLWIDTH);
    const { starts, firstText } = lineStarts(node);
    expect(starts.length).toBeGreaterThan(1);
    expect(firstText).toBeGreaterThan(30);
    for (const s of starts.slice(1)) expect(Math.abs(s - firstText)).toBeLessThan(1.5);
  });

  test("行首沒有空白的列照舊從最左邊折", () => {
    const m = mount(true);
    const node = rowNode(m, PLAIN);
    expect(node.classList.contains("hangIndent")).toBe(false);
    const { starts } = lineStarts(node);
    expect(starts.length).toBeGreaterThan(1);
    for (const s of starts) expect(s).toBeLessThan(1);
  });

  test("文字一個字都不變（複製不變）", () => {
    const on = mount(true);
    const textOn = rowNode(on, INDENTED).textContent;
    unmountAll();
    const off = mount(false);
    expect(rowNode(off, INDENTED).textContent).toBe(textOn);
  });

  test("開關關掉：續行回到最左邊、不加 class", () => {
    const m = mount(false);
    const node = rowNode(m, INDENTED);
    expect(node.classList.contains("hangIndent")).toBe(false);
    expect(node.style.getPropertyValue("--hangHalf")).toBe("");
    const { starts } = lineStarts(node);
    expect(starts.length).toBeGreaterThan(1);
    expect(starts[1]).toBeLessThan(1);
  });

  test("縮排列裡的圖片預覽盒拉回列的左緣、用滿寬（縮排只給文字）", () => {
    const m = mountScreen({
      ...easy,
      lines: [...LINES.slice(0, 4), row(seg("    "), link("https://i.imgur.com/abcdefg.jpg"))],
      enhance: { ...easy.enhance, commentCards: true, hangIndent: true },
    });
    m.root.classList.add("mobileReflow");
    m.root.style.width = "320px";
    m.root.style.fontSize = "20px";
    const node = rowNode(m, 4);
    expect(node.classList.contains("hangIndent")).toBe(true);
    const slot = node.querySelector(".inlinePreviewSlot");
    expect(slot).not.toBeNull();    const r = node.getBoundingClientRect();
    const s = slot.getBoundingClientRect();
    expect(Math.abs(s.left - r.left)).toBeLessThan(1);
    expect(Math.abs(s.width - r.width)).toBeLessThan(1);
  });

  test("切開關會換 annotationsKey（整批重畫）", () => {
    const k = (on) =>
      annotationsKey({ lines: LINES, enhance: { ...easy.enhance, commentCards: true, hangIndent: on } });
    expect(sameKey(k(true), k(false))).toBe(false);
  });

  test("不在換行版面（commentCards 關，桌機）：就算開關開著也不加", () => {
    const m = mount(true, false);
    const node = rowNode(m, INDENTED);
    expect(node.classList.contains("hangIndent")).toBe(false);
    expect(node.getAttribute("style")).toBeNull();
  });
});
