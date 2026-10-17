// @unit-env browser
// UTF-8 線路的 Unicode 格（src/js/unicode_cells.js）畫到畫面上：
//   - 文字是原字（不是 ?／？），右半格 WIDE_TRAIL 不會變成可見字元或被複製出去；
//   - 格線不歪：全形 Unicode 字盒 2 格寬、半形 Unicode 字盒 1 格寬（.hpadding），
//     不管 fallback 字型的 advance（規則同 dbcs_cell_width.test.js）；
//   - 右半格被蓋掉的孤兒左半照原樣畫，孤兒右半畫成 ?。
// 走真 UTF-8 解碼 → AnsiParser → TermBuf → buildRow，不手捏格子。
import { mountRow, unmountAll } from "./helpers/mount_screen";
import { loadBig5Tables } from "./helpers/load_big5_tables";
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { createUtf8Inbound } from "../../src/js/wire_charset";
import { WIDE_TRAIL, setUnicodeCells } from "../../src/js/unicode_cells";
import symMingLiuUrl from "../../src/fonts/symmingliu.woff?url";

loadBig5Tables();

const FONT_PX = 20;
const CHW = FONT_PX / 2;
const ESC = "\x1b";

function wire(text) {
  return String.fromCharCode(...new TextEncoder().encode(text));
}

function rowFrom(text) {
  const buf = new TermBuf(80, 24);
  buf.setView({
    update() {},
    updateCursorPos() {},
    refreshCursorVisibility() {},
    blinkOn: false,
    charset: "big5",
  });
  buf.useMouseBrowsing = false;
  new AnsiParser(buf).feed(createUtf8Inbound().decode(wire(text)));
  buf.notify();
  return buf.lines[0];
}

function mount(chars) {
  const m = mountRow({ chars, forceWidth: FONT_PX });
  Object.assign(m.root.style, {
    // 與 #mainContainer 同一套排版前提（dbcs_cell_width.test.js）：半形 0.5em 的終端機字型。
    fontFamily: "MingLiu, SymMingLiu, monospace",
    fontSize: `${FONT_PX}px`,
    lineHeight: `${FONT_PX}px`,
    whiteSpace: "pre",
    width: "max-content",
  });
  return m;
}

function lineText(root) {
  return root.querySelector('[data-type="bbsline"]').textContent;
}

beforeAll(async () => {
  const face = new FontFace("SymMingLiu", `url(${symMingLiuUrl})`);
  document.fonts.add(await face.load());
  setUnicodeCells(true);
});
afterAll(() => setUnicodeCells(false));
afterEach(unmountAll);

test("韓文／簡體／ġ 畫出原字，沒有右半格字元", () => {
  const { root } = mount(rowFrom("한국 简体 ġ"));
  const text = lineText(root);
  expect(text.trimEnd()).toBe("한국 简体 ġ");
  expect(text).not.toContain(WIDE_TRAIL);
  expect(text).not.toContain("?");
});

test("格線：⭐（U+2B50，全形）與 ġ、泰文（半形）之後的字仍對齊", () => {
  // 只用不在 CJK 區塊的字：它們全靠固定寬度的字盒，量得到的就是我們的排版。
  // （U+FFFD 不行：symbol_table 把它列為壞字，畫成 ??。）
  const chars = rowFrom("A⭐ġกZ");
  const { root } = mount(chars);
  const line = root.querySelector('[data-type="bbsline"]');
  const left = line.getBoundingClientRect().left;
  const wide = line.querySelector(".wpadding");
  const narrow = [...line.querySelectorAll(".hpadding")];
  expect(wide.getBoundingClientRect().width).toBeCloseTo(FONT_PX, 0);
  expect(narrow.map((n) => n.textContent)).toEqual(["ġ", "ก"]);
  for (const n of narrow) expect(n.getBoundingClientRect().width).toBeCloseTo(CHW, 0);
  // Z 在 col 5（A=0、⭐=1-2、ġ=3、ก=4）
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let zRect = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const at = n.data.indexOf("Z");
    if (at < 0) continue;
    const r = document.createRange();
    r.setStart(n, at);
    r.setEnd(n, at + 1);
    zRect = r.getBoundingClientRect();
  }
  expect(zRect.left - left).toBeCloseTo(5 * CHW, 0);
});

test("右半格被蓋掉：左半照原樣畫、蓋上去的字照畫；孤兒右半畫成 ?", () => {
  // server 在右半格（col 1）寫 X ⇒ 한 失去右半
  const orphanLead = rowFrom("한" + ESC + "[1;2HX");
  expect(lineText(mount(orphanLead).root).trimEnd()).toBe("한X");
  unmountAll();
  // server 在左半格（col 0）寫 Y ⇒ 右半格落單
  const orphanTrail = rowFrom("한" + ESC + "[1;1HY");
  expect(lineText(mount(orphanTrail).root).trimEnd()).toBe("Y?");
});
