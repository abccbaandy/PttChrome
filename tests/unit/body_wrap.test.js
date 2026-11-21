// @unit-env browser
// 內文跨行連結接合（src/js/body_wrap.js）的純邏輯守護。
//
// 實例來自 2026-08-30 的 PttBug 錄製：`※ 文章網址:` 那行被切成兩列，
//   col 33..77  https://www.ptt.cc/bbs/PttBug/M.1788041180.A.
//   col  0..7   404.html
// ⇒ parseArticleUrl 對殘段回 null ⇒ 右鍵的「複製文章代碼／複製文章 deep link」
// 整組消失。接回去之後兩列共用同一個完整 href。
//
// 模組載入一律放檔案層級（tests/unit/module_load_cost.test.js 靜態守護）。
import {
  pmoreMaxCol,
  detectBodyWrappedUrls,
  detectOscWrappedLinks,
  bodyWrapFrontier,
} from "../../src/js/body_wrap";
import { seg, link, row, COLS } from "./helpers/screen_fixtures";

const PREFIX = "08/30/2026 06:06:19 ※ 文章網址: "; // 33 欄
const LEFT = "https://www.ptt.cc/bbs/PttBug/M.1788041180.A."; // 45 欄 → 收在 col 77
const RIGHT = "404.html";
const FULL = LEFT + RIGHT;

const MAXCOL = 77;
const noSkip = () => false;

// 「一列的 URL 片段正好收在 maxcol」——左邊用空白補齊，欄數算術一目了然。
// linked=true 時同時標上 TermBuf 的 URL 旗標（真實流程裡左列殘段確實會被
// uriRegEx 標成一條 URL）。
function rowEndingAt(url, { linked = true, tail = "" } = {}) {
  const pad = MAXCOL + 1 - url.length;
  const parts = [];
  if (pad > 0) parts.push(seg(" ".repeat(pad)));
  parts.push(linked ? link(url, url) : seg(url));
  if (tail) parts.push(seg(tail));
  return row(...parts);
}

describe("pmoreMaxCol", () => {
  test("80 欄 → 77（pmore.c:1447-1456 的算式，不寫死）", () => {
    expect(pmoreMaxCol(80)).toBe(MAXCOL);
  });

  test("寬度改變時跟著走", () => {
    expect(pmoreMaxCol(100)).toBe(97);
    // 81 欄：headerw=80、81-80<2 ⇒ dispw=79 ⇒ maxcol=78（借走 indicator 那一格）
    expect(pmoreMaxCol(81)).toBe(78);
  });
});

describe("detectBodyWrappedUrls", () => {
  test("錄製實例：兩列接成同一條連結，只有最後一段掛預覽", () => {
    const lines = [row(seg(PREFIX), link(LEFT, LEFT)), row(seg(RIGHT))];
    const out = detectBodyWrappedUrls(lines, noSkip);
    expect(out).toHaveLength(1);
    expect(out[0].href).toBe(FULL);
    expect(out[0].host).toBe("www.ptt.cc");
    expect(out[0].parts).toEqual([
      { row: 0, startCol: 33, endCol: 78, preview: false },
      { row: 1, startCol: 0, endCol: 8, preview: true },
    ]);
  });

  // 2026-09-10：結尾的句尾標點／不成對括號不得進連結，而 parts
  // 是自己數格子數出來的 ⇒ 必須跟著 href 一起縮（否則底線比連結長）。
  test("最後一段的結尾 ) 不進 href，parts 也跟著縮", () => {
    const lines = [
      row(seg(PREFIX), link(LEFT, LEFT)),
      row(seg(RIGHT + ")")),
    ];
    const out = detectBodyWrappedUrls(lines, noSkip);
    expect(out).toHaveLength(1);
    expect(out[0].href).toBe(FULL);
    expect(out[0].parts[1]).toEqual({
      row: 1,
      startCol: 0,
      endCol: 8,
      preview: true,
    });
  });

  test("超長網址跨三列", () => {
    // 中間列整列都是 URL 字元（col 0..77）⇒ 續行鏈往下延伸。
    const mid = "b".repeat(78);
    const lines = [
      row(seg(PREFIX), link(LEFT, LEFT)),
      row(seg(mid)),
      row(seg("tail.html")),
    ];
    const out = detectBodyWrappedUrls(lines, noSkip);
    expect(out).toHaveLength(1);
    expect(out[0].href).toBe(LEFT + mid + "tail.html");
    expect(out[0].parts.map((p) => p.row)).toEqual([0, 1, 2]);
    expect(out[0].parts.map((p) => p.preview)).toEqual([false, false, true]);
  });

  test("左列沒寫滿 maxcol（收在 col 76）⇒ 不接", () => {
    const lines = [
      row(seg(PREFIX), link(LEFT.slice(0, 44), LEFT.slice(0, 44))),
      row(seg(RIGHT)),
    ];
    expect(detectBodyWrappedUrls(lines, noSkip)).toEqual([]);
  });

  test("左列越過 maxcol 一路塞到 col 79（TRADITIONAL_FULLCOL）⇒ 不接", () => {
    const long = LEFT + "xx";
    const lines = [row(seg(PREFIX), link(long, long)), row(seg(RIGHT))];
    expect(detectBodyWrappedUrls(lines, noSkip)).toEqual([]);
  });

  test("左列 col 78 是 pmore 折行符號 ⇒ 仍成立", () => {
    const lines = [
      row(seg(PREFIX), link(LEFT, LEFT), seg("\\")),
      row(seg(RIGHT)),
    ];
    const out = detectBodyWrappedUrls(lines, noSkip);
    expect(out).toHaveLength(1);
    expect(out[0].href).toBe(FULL);
  });

  test("右列從 col 1 起（col 0 是空白）⇒ 不接", () => {
    const lines = [
      row(seg(PREFIX), link(LEFT, LEFT)),
      row(seg(" " + RIGHT)),
    ];
    expect(detectBodyWrappedUrls(lines, noSkip)).toEqual([]);
  });

  test("右列 col 0 是中文（DBCS）⇒ 不接", () => {
    const lines = [
      row(seg(PREFIX), link(LEFT, LEFT)),
      row(seg("這是下一句話")),
    ];
    expect(detectBodyWrappedUrls(lines, noSkip)).toEqual([]);
  });

  // OSC 8（PTT 2026-09-30）：server 已經明確指定了連結範圍與 href，就不是「被切斷的
  // 純文字網址」。不擋的話 body_wrap 的 _wrapUrl 會蓋掉 TermChar 的 fullurl，把
  // 使用者點的連結換成我們猜出來的那條。
  test("左片段帶 OSC 8 連結（server 指定）⇒ 不接", () => {
    const left = rowEndingAt(LEFT, { linked: false });
    for (const c of left) if (c.ch !== " ") c.hyperlink = "https://server.example/";
    expect(detectBodyWrappedUrls([left, row(seg(RIGHT))], noSkip)).toEqual([]);
  });

  test("右片段帶 OSC 8 連結 ⇒ 不接", () => {
    const right = row(seg(RIGHT));
    for (let i = 0; i < RIGHT.length; ++i) right[i].hyperlink = "https://server.example/";
    expect(
      detectBodyWrappedUrls([row(seg(PREFIX), link(LEFT, LEFT)), right], noSkip),
    ).toEqual([]);
  });

  test("左片段以媒體副檔名收尾 ⇒ 反向守門，不接", () => {
    const media = "https://i.imgur.com/AbCdEfGh.jpeg";
    const lines = [rowEndingAt(media), row(seg("xyz.html"))];
    expect(detectBodyWrappedUrls(lines, noSkip)).toEqual([]);
  });

  test("併起來 TLD 不在允許清單 ⇒ 不接", () => {
    const lines = [
      rowEndingAt("https://www.example.zzzz/bbs/M.1788.A."),
      row(seg(RIGHT)),
    ];
    expect(detectBodyWrappedUrls(lines, noSkip)).toEqual([]);
  });

  test("host 之後直接接字母（不是路徑）⇒ 不接", () => {
    const lines = [rowEndingAt("https://www.ptt.c"), row(seg("cfoo"))];
    expect(detectBodyWrappedUrls(lines, noSkip)).toEqual([]);
  });

  test("無 scheme 又無路徑 ⇒ 不接（那是 bare domain 的地盤）", () => {
    const lines = [
      rowEndingAt("www.exampl", { linked: false }),
      row(seg("e.com")),
    ];
    expect(detectBodyWrappedUrls(lines, noSkip)).toEqual([]);
  });

  test("無 scheme 但有路徑 ⇒ 接，並補上 https", () => {
    const lines = [
      rowEndingAt("www.example.com/some/very/long/pa", { linked: false }),
      row(seg("th.html")),
    ];
    const out = detectBodyWrappedUrls(lines, noSkip);
    expect(out).toHaveLength(1);
    expect(out[0].href).toBe("https://www.example.com/some/very/long/path.html");
  });

  test("任一列是推文/隱藏列 ⇒ 不接", () => {
    const lines = [row(seg(PREFIX), link(LEFT, LEFT)), row(seg(RIGHT))];
    expect(detectBodyWrappedUrls(lines, (r) => r === 1)).toEqual([]);
    expect(detectBodyWrappedUrls(lines, (r) => r === 0)).toEqual([]);
  });

  test("空輸入不炸", () => {
    expect(detectBodyWrappedUrls([], noSkip)).toEqual([]);
    expect(detectBodyWrappedUrls([row(seg("only one row"))], noSkip)).toEqual(
      [],
    );
    expect(detectBodyWrappedUrls(null, noSkip)).toEqual([]);
  });

  test("列寬就是 COLS（fixture 與 maxcol 推導一致）", () => {
    expect(COLS).toBe(80);
    expect(row(seg(PREFIX), link(LEFT, LEFT))).toHaveLength(80);
  });
});

// OSC 8 跨列連結（server 指定）：pmore 折行（MFDISP_URL_LIMIT）與作者硬斷行
// （common/sys/string.c#url_tracker_init，結尾落在 74～80 欄、續行可帶 `: `／`> `
// 引言前綴）都讓**每一列各自**帶同一個完整 href。實際畫面（#1gxj3YUh）：
//   row 7  https://lazy-cv.com/docs/stop-bilibili-dropping-quality/assets/01-quality-menu
//   row 8  -zh-TW.png
// 兩列都是 OSC 8 → 同一張圖。逐列渲染時每列各開一張預覽 ⇒ 同一張圖出現兩次。
describe("detectOscWrappedLinks", () => {
  const IMG =
    "https://lazy-cv.com/docs/stop-bilibili-dropping-quality/assets/01-quality-menu-zh-TW.png";
  // 一段 OSC 8 連結：顯示文字 text、server 指定的 href（每一格都帶 hyperlink）。
  const osc = (text, href = IMG) =>
    link(text, href).map((c) => Object.assign(c, { hyperlink: href }));
  const L = IMG.slice(0, 78); // cols 0..77
  const R = IMG.slice(78); // "-zh-TW.png"

  test("畫面實例：兩列同一個 href ⇒ 一條鏈，只有最後一段掛預覽", () => {
    const out = detectOscWrappedLinks([row(osc(L)), row(osc(R))], noSkip);
    expect(out).toHaveLength(1);
    expect(out[0].href).toBe(IMG);
    expect(out[0].host).toBe("lazy-cv.com");
    expect(out[0].parts).toEqual([
      { row: 0, startCol: 0, endCol: 78, preview: false },
      { row: 1, startCol: 0, endCol: R.length, preview: true },
    ]);
  });

  test("跨三列：中間整列都是連結", () => {
    const lines = [row(osc("a".repeat(78))), row(osc("b".repeat(80))), row(osc("c.png"))];
    const out = detectOscWrappedLinks(lines, noSkip);
    expect(out).toHaveLength(1);
    expect(out[0].parts.map((p) => [p.row, p.startCol, p.endCol, p.preview])).toEqual([
      [0, 0, 78, false],
      [1, 0, 80, false],
      [2, 0, 5, true],
    ]);
  });

  test("左列連結前有文字、後面接 pmore 折行符號 `\\` ⇒ 仍是同一條", () => {
    const lines = [row(seg("圖："), osc("x".repeat(74)), seg("\\")), row(osc(R))];
    const out = detectOscWrappedLinks(lines, noSkip);
    expect(out).toHaveLength(1);
    expect(out[0].parts[0]).toEqual({ row: 0, startCol: 4, endCol: 78, preview: false });
  });

  test("引言裡的硬斷行：續行在 `: ` 之後（col 2）起", () => {
    const lines = [row(seg(": "), osc("q".repeat(74))), row(seg(": "), osc(R))];
    const out = detectOscWrappedLinks(lines, noSkip);
    expect(out).toHaveLength(1);
    expect(out[0].parts[1]).toEqual({ row: 1, startCol: 2, endCol: 2 + R.length, preview: true });
  });

  test("下一列是別的 href ⇒ 不是同一條", () => {
    const lines = [row(osc(L)), row(osc(R, "https://other.example/x.png"))];
    expect(detectOscWrappedLinks(lines, noSkip)).toEqual([]);
  });

  test("下一列的連結不是從列首起 ⇒ 不接", () => {
    const lines = [row(osc(L)), row(seg("看 "), osc(R))];
    expect(detectOscWrappedLinks(lines, noSkip)).toEqual([]);
  });

  test("左列連結後面還有文字 ⇒ 不接", () => {
    const lines = [row(osc("x".repeat(40)), seg(" 這張")), row(osc(R))];
    expect(detectOscWrappedLinks(lines, noSkip)).toEqual([]);
  });

  test("單列連結（沒有續行）⇒ 不出現", () => {
    expect(detectOscWrappedLinks([row(osc(IMG)), row(seg("next"))], noSkip)).toEqual([]);
  });

  test("任一列是推文/隱藏列 ⇒ 不接", () => {
    const lines = [row(osc(L)), row(osc(R))];
    expect(detectOscWrappedLinks(lines, (r) => r === 0)).toEqual([]);
    expect(detectOscWrappedLinks(lines, (r) => r === 1)).toEqual([]);
  });

  test("純文字斷行（沒有 OSC 8）不歸它管", () => {
    const lines = [row(seg(PREFIX), link(LEFT, LEFT)), row(seg(RIGHT))];
    expect(detectOscWrappedLinks(lines, noSkip)).toEqual([]);
  });

  test("空輸入不炸", () => {
    expect(detectOscWrappedLinks([], noSkip)).toEqual([]);
    expect(detectOscWrappedLinks(null, noSkip)).toEqual([]);
  });
});

describe("bodyWrapFrontier", () => {
  const osc = (text, href) =>
    link(text, href).map((c) => Object.assign(c, { hyperlink: href }));

  test("最後一列以 OSC 8 連結收尾 ⇒ 鏈還開著（不受 guess 開關影響）", () => {
    const H = "https://img.example.com/a.png";
    const lines = [row(seg("intro")), row(osc("x".repeat(78), H)), row(osc("y".repeat(80), H))];
    expect(bodyWrapFrontier(lines, noSkip, { guess: false })).toBe(1);
    expect(bodyWrapFrontier(lines, noSkip)).toBe(1);
  });

  test("最後一列沒有開著的鏈 ⇒ lines.length", () => {
    const lines = [row(seg("intro")), row(seg("end"))];
    expect(bodyWrapFrontier(lines, noSkip, { guess: false })).toBe(2);
  });

  test("guess 關掉時純文字寫滿 maxcol 不算開著", () => {
    const lines = [row(seg("intro")), rowEndingAt(LEFT)];
    expect(bodyWrapFrontier(lines, noSkip)).toBe(1);
    expect(bodyWrapFrontier(lines, noSkip, { guess: false })).toBe(2);
  });
});
