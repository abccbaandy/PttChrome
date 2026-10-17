// server 字寬（src/js/ucs_width.js ＝ pttbbs common/sys/string.c#ucs_width）。
//
// 鎖的行為：client 的格寬與 pfterm 逐字一致（MB_IS_UTF8 的 server 用它排游標，
// 差一格整列錯位）。代表值逐一對過 wcwidth.c 的分支；本機有 3rd_script/pttbbs 時
// 另外把三張表跟原始碼逐項比對（3rd_script 不進 repo，CI 上跳過）。
import fs from "node:fs";
import path from "node:path";
import {
  AMB_BMP_LOW,
  AMB_BMP_SYM,
  COMBINING,
  isCjkAmbiguous,
  mkWcwidth,
  ucsWidth,
} from "../../src/js/ucs_width";

describe("ucsWidth（mk_wcwidth_cjk，負值當 0）", () => {
  test.each([
    [0x41, 1, "ASCII"],
    [0x00, 0, "NUL"],
    [0x1b, 0, "C0 控制字元（mk_wcwidth 回 -1）"],
    [0x85, 0, "C1 控制字元"],
    [0x0121, 1, "logind 探針 ġ：半形（CPR 回 col 2 的前提）"],
    [0x00e9, 2, "é 是 East Asian Ambiguous ⇒ CJK 版 2 格"],
    [0x00c0, 1, "À 不是 Ambiguous"],
    [0x0301, 0, "組合重音符"],
    [0x200d, 0, "ZWJ"],
    [0xfe0f, 0, "VS16"],
    [0x4e2d, 2, "中"],
    [0xac00, 2, "한（Hangul Syllables）"],
    [0x3042, 2, "あ"],
    [0x303f, 1, "U+303F 是 CJK 區塊裡唯一的例外"],
    [0xff71, 1, "半形片假名 ｱ"],
    [0xff01, 2, "全形 ！"],
    [0x2713, 1, "✓"],
    [0x263a, 1, "☺"],
    [0x2605, 2, "★（Ambiguous）"],
    [0xe000, 2, "PUA（Ambiguous）"],
    [0xfffd, 2, "U+FFFD（Ambiguous）"],
    [0x1f600, 2, "😀（U+1F000–1FFFF 全算 Ambiguous）"],
    [0x0e01, 1, "泰文子音"],
    [0x0e31, 0, "泰文母音符號（combining）"],
    [0x10a01, 0, "BMP 以外的 combining"],
    [0x20000, 2, "CJK Ext B"],
  ])("U+%s → %i（%s）", (cp, w) => {
    expect(ucsWidth(cp)).toBe(w);
  });

  test("mk_wcwidth 本身保留 -1（控制字元）", () => {
    expect(mkWcwidth(0x7f)).toBe(-1);
    expect(mkWcwidth(0x9f)).toBe(-1);
    expect(mkWcwidth(0xa0)).toBe(1);
  });

  test("CJK Unified Ideographs 不查 Ambiguous 表", () => {
    expect(isCjkAmbiguous(0x4e00)).toBe(false);
    expect(isCjkAmbiguous(0x9fff)).toBe(false);
  });
});

const WCWIDTH_C = path.resolve(
  __dirname,
  "../../3rd_script/pttbbs/common/sys/wcwidth.c",
);

describe.skipIf(!fs.existsSync(WCWIDTH_C))("表格與 pttbbs 原始碼逐項相同", () => {
  const src = fs.existsSync(WCWIDTH_C) ? fs.readFileSync(WCWIDTH_C, "utf8") : "";
  // #else 那份才是編進去的（USE_MK_CJK_AMBIGUOUS 沒有定義）
  const elseSec = src.split("#else")[1] || "";
  const hexes = (block, re) => [...block.matchAll(re)].map((m) => parseInt(m[1], 16));

  test("combining[]", () => {
    const block = src.match(/combining\[\] = \{([\s\S]*?)\};/)[1];
    expect(COMBINING).toEqual(hexes(block, /0x([0-9A-F]+)/g));
  });

  test("amb_bmp_low[]", () => {
    const block = elseSec.match(/amb_bmp_low\[\d+\] = \{([\s\S]*?)\};/)[1];
    expect(AMB_BMP_LOW).toEqual(hexes(block, /0x([0-9a-f]+)u/g));
  });

  test("amb_bmp_sym[]", () => {
    const block = elseSec.match(/amb_bmp_sym\[\d+\] = \{([\s\S]*?)\};/)[1];
    expect(AMB_BMP_SYM).toEqual(hexes(block, /0x([0-9a-f]+)u/g));
  });

  test("USE_MK_CJK_AMBIGUOUS 沒有在任何地方被定義（編進去的是 bitmap 版）", () => {
    const root = path.resolve(__dirname, "../../3rd_script/pttbbs");
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === ".git") continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(c|h|mk)$|Makefile/.test(e.name)) {
          const t = fs.readFileSync(p, "latin1");
          if (/define\s+USE_MK_CJK_AMBIGUOUS|-DUSE_MK_CJK_AMBIGUOUS/.test(t)) hits.push(p);
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
