// 游標整列提亮（pref cursorRowBrighten）的樣式層 + CSS 契約。
//
// 還原 pttbbs e18a7182 的 cursor_show()：開 UF_MENU_LIGHTBAR 時
// grayout(row, row+1, GRAYOUT_COLORBOLD) → 整列 FTATTR_BOLD / ESC[1m
// ＝前景色提亮一階、**背景不變**（有底色的那個是 GRAYOUT_STANDOUT，另一個 pref）。
// 考證見 docs/pttbbs-screen-protocol.md。
//
// 這裡鎖三件事：
//  (1) 樣式層與來源層正交：兩種樣式可疊、可全關（全關＝回 "" ＝不標示）；
//  (2) 「提亮一階」的色值真的等於 q(n+8) —— 靠 CSS 值比對，改錯色會紅；
//  (3) 整段 .cursorBrighten **不含 font-weight** —— 等寬格線上字重一變整列位移，
//      .wpadding 的寬度契約（term_view.fixedResize 直接掃 DOM 改它）跟著壞，
//      同 main.css 的 .fnKey 禁令。demo 原稿用的正是 font-weight:700，很容易被抄回來。
import fs from "node:fs";
import path from "node:path";
import {
  CURSOR_BRIGHTEN_CLASS,
  cursorHighlightClasses,
  DEFAULT_HIGHLIGHT_BG,
} from "../../src/js/cursor_highlight";

const CSS = fs.readFileSync(
  path.join(__dirname, "..", "..", "src", "css", "color.css"),
  "utf8",
);
// 註解先剝掉，才不會把說明文字裡的 font-weight / 色碼當成宣告。
const STRIPPED = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

// 取某個選擇器的宣告區塊（選擇器要完整跳脫所有 regex meta 字元，含反斜線本身）。
const ruleBody = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, "m");
  const m = STRIPPED.match(re);
  if (!m) throw new Error(`color.css 找不到規則 ${selector}`);
  return m[2];
};

const colorOf = (selector) => {
  const m = ruleBody(selector).match(/(?:^|;)\s*color\s*:\s*([^;]+)/);
  if (!m) throw new Error(`${selector} 沒有宣告 color`);
  return m[1].trim().toLowerCase();
};

// .cursorBrighten 開頭的每一條規則的宣告區塊（含上班模式那一組）。
const brightenBlocks = () =>
  [...STRIPPED.matchAll(/\.cursorBrighten[^{}]*\{([^}]*)\}/g)].map((m) => m[1]);

describe("cursorHighlightClasses（樣式層）", () => {
  test("只開提亮 → 只有提亮 class，沒有任何背景 class", () => {
    const cls = cursorHighlightClasses({
      brighten: true,
      background: false,
      colorIndex: 2,
    });
    expect(cls).toBe(CURSOR_BRIGHTEN_CLASS);
    expect(cls).not.toMatch(/\bb\d+\b/);
  });

  test("只開底色 → 沿用既有的 bN 對映", () => {
    expect(
      cursorHighlightClasses({
        brighten: false,
        background: true,
        colorIndex: 4,
      }),
    ).toBe("b4");
  });

  test("兩個都開 → 疊在同一列，提亮固定排前面（cls 字串是前後幀的比對鍵）", () => {
    expect(
      cursorHighlightClasses({
        brighten: true,
        background: true,
        colorIndex: 6,
      }),
    ).toBe(`${CURSOR_BRIGHTEN_CLASS} b6`);
  });

  test("兩個都關 → 空字串（呼叫端據此整條跳過，不是畫一個沒有樣式的 class）", () => {
    expect(
      cursorHighlightClasses({
        brighten: false,
        background: false,
        colorIndex: 2,
      }),
    ).toBe("");
    expect(cursorHighlightClasses()).toBe("");
  });

  test("底色開著但顏色值壞掉 → 仍走既有 fallback，不會整個消失", () => {
    expect(
      cursorHighlightClasses({
        brighten: false,
        background: true,
        colorIndex: 99,
      }),
    ).toBe("b" + DEFAULT_HIGHLIGHT_BG);
  });
});

describe("color.css 的 .cursorBrighten 契約", () => {
  test("q0..q7 提亮一階＝取 q8..q15 的色值（ESC[1m 語意，與 TermChar.getFg 同源）", () => {
    for (let n = 0; n <= 7; ++n) {
      expect(colorOf(`.cursorBrighten .q${n}`)).toBe(colorOf(`.q${n + 8}`));
    }
  });

  test("已經是亮色的 q8..q15 不再另外指定色值（沒有更亮的一階可去）", () => {
    for (let n = 8; n <= 15; ++n) {
      expect(STRIPPED).not.toMatch(
        new RegExp(`\\.cursorBrighten\\s+\\.q${n}\\s*\\{`),
      );
    }
  });

  test("改用 text-shadow 讓已經是亮色的字也看得出變化（不參與 layout）", () => {
    expect(ruleBody(".cursorBrighten")).toMatch(/text-shadow\s*:/);
  });

  test("整組 .cursorBrighten 規則不得出現 font-weight（等寬格線會整列位移）", () => {
    const blocks = brightenBlocks();
    expect(blocks.length).toBeGreaterThan(0);
    for (const body of blocks) expect(body).not.toMatch(/font-weight/);
  });

  test("不動背景：整組規則不得宣告 background", () => {
    for (const body of brightenBlocks())
      expect(body).not.toMatch(/background/);
  });

  test("上班模式有自己的一組（否則靜音調色盤會把提亮整個蓋掉）", () => {
    for (let n = 0; n <= 7; ++n) {
      expect(() =>
        colorOf(`.work-mode-active .cursorBrighten .q${n}`),
      ).not.toThrow();
    }
  });
});
