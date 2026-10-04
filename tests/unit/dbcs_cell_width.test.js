// @unit-env browser
// 每個 Big5 DBCS 字在終端機上都佔 2 欄，畫面上就必須正好 2×chw 寬，不管字型。
//
// 字型給的 advance 只有 CJK 區塊（漢字、注音、全形符號…）可靠是 1em；其餘 Unicode
// 是窄字或 East Asian Ambiguous 的（‼ … — → ─ ● Α Ω、圈數字、UAO 的 PUA…），
// 終端機字型沒收那個字形時會 fallback 到西文字型、只畫 1 格 ⇒ 該列之後的字整排左移。
// 實錄：Stock 板推文「Nice大 太神了吧‼  但給更需要的版友‼」的時間戳右緣差了
// 1 或 2 個半形寬（‼ = Big5 91F7，UAO 擴充區，SymMingLiu／MingLiu 都沒收）。
// 規則與 e2e screen_sanity 的 grid 檢查同一條：最後一個字的右緣 ＝ (欄位+1)×chw。
import { mountRow, unmountAll } from "./helpers/mount_screen";
import { loadBig5Tables } from "./helpers/load_big5_tables";
import { isDBCSLead, u2b } from "../../src/js/string_util";
import { symbolTable } from "../../src/js/symbol_table";
import symMingLiuUrl from "../../src/fonts/symmingliu.woff?url";

loadBig5Tables();

const FONT_PX = 20; // chw = 10，全形 = forceWidth = 20
const CHW = FONT_PX / 2;

const COLOR = {
  fg: 7,
  bg: 0,
  blink: false,
  equals(o) {
    return !!o && o.fg === this.fg && o.bg === this.bg && o.blink === this.blink;
  },
};

function cell(ch, lead) {
  return {
    ch,
    isLeadByte: !!lead,
    getColor: () => COLOR,
    isStartOfURL: () => false,
    isEndOfURL: () => false,
    getFullURL: () => null,
  };
}

// 位元組字串（一字元一位元組）→ cells，DBCS 頭尾配對標 isLeadByte。
function bytesToCells(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; ++i) {
    const lead = isDBCSLead(bytes[i]) && i + 1 < bytes.length;
    out.push(cell(bytes[i], lead));
    if (lead) out.push(cell(bytes[++i], false));
  }
  return out;
}

function padRow(cells) {
  while (cells.length < 80) cells.push(cell(" ", false));
  return cells;
}

let fontReady;
beforeAll(async () => {
  const face = new FontFace("SymMingLiu", `url(${symMingLiuUrl})`);
  fontReady = await face.load();
  document.fonts.add(fontReady);
});
afterEach(unmountAll);

function mountTerminalRow(cells) {
  const m = mountRow({ chars: cells, forceWidth: FONT_PX });
  // 與 #mainContainer 同一套排版前提：等寬字型堆疊、white-space: pre、整數字級。
  Object.assign(m.root.style, {
    fontFamily: "MingLiu, SymMingLiu, monospace",
    fontSize: `${FONT_PX}px`,
    lineHeight: `${FONT_PX}px`,
    whiteSpace: "pre",
    width: "max-content",
  });
  return m;
}

// 最後一個非空白字元的右緣（相對該列左緣）。
function lastGlyphRight(root) {
  const line = root.querySelector('[data-type="bbsline"]');
  const left = line.getBoundingClientRect().left;
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let last = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.data.replace(/\s+$/, "");
    if (t) last = { node: n, idx: t.length - 1 };
  }
  const r = document.createRange();
  r.setStart(last.node, last.idx);
  r.setEnd(last.node, last.idx + 1);
  return r.getBoundingClientRect().right - left;
}

test("‼（Big5 91F7）之後的字仍對齊格線（實錄 Stock 推文列）", () => {
  const bang = u2b("‼");
  expect(bang).toBe("\x91\xf7");
  // 全用 ASCII 夾 ‼：只有 ‼ 的寬度會影響結果，不受 CJK fallback 字型干擾。
  const bytes = `-> HiuAnOP     : Nice ${bang}  ok ${bang}       10/02 15:19`;
  const cells = padRow(bytesToCells(bytes));
  const lastCol = bytes.length - 1;
  const { root } = mountTerminalRow(cells);
  expect(lastGlyphRight(root)).toBeCloseTo((lastCol + 1) * CHW, 0);
});

// CJK 區塊（Unicode East Asian Width = W/F）：任何 CJK 字型的 advance 都是 1em，
// 不需要撐寬。區塊外的一律不信任字型。
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

test("整張 b2u 表：CJK 區塊以外的 DBCS 字都正好 2 格寬", () => {
  const b2u = globalThis.lib.b2uArray;
  const pairs = [];
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      const pos = (lead << 8) | trail;
      const code = (b2u[2 * pos] << 8) | b2u[2 * pos + 1];
      if (!code || isCjkWide(code)) continue;
      if (symbolTable["x" + code.toString(16)] == 3) continue; // 壞字，畫成 ??
      pairs.push({ bytes: String.fromCharCode(lead, trail), code });
    }
  }
  expect(pairs.length).toBeGreaterThan(900);

  const bad = [];
  for (let i = 0; i < pairs.length; i += 39) {
    const chunk = pairs.slice(i, i + 39);
    const { root } = mountTerminalRow(padRow(bytesToCells(chunk.map((p) => p.bytes).join(""))));
    const line = root.querySelector('[data-type="bbsline"]');
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let k = 0;
    for (let n = walker.nextNode(); n && k < chunk.length; n = walker.nextNode()) {
      for (let j = 0; j < n.data.length && k < chunk.length; j++) {
        const r = document.createRange();
        r.setStart(n, j);
        r.setEnd(n, j + 1);
        // 字元所在的格子盒：撐寬過的是 .wpadding inline-block，否則就是字形本身。
        const box = n.parentElement.closest(".wpadding") || r;
        const rect = box.getBoundingClientRect();
        const p = chunk[k];
        // 只量寬度：左緣會被前一個錯寬的字連帶推歪，報出來的就不是兇手。
        if (Math.abs(rect.width - FONT_PX) > 0.5) {
          bad.push(`U+${p.code.toString(16).toUpperCase()} ${String.fromCharCode(p.code)} w=${rect.width.toFixed(1)}`);
        }
        k++;
      }
    }
    unmountAll();
  }
  expect({ count: bad.length, sample: bad.slice(0, 40) }).toEqual({ count: 0, sample: [] });
});
