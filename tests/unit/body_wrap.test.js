// 內文跨行連結接合（src/js/body_wrap.js）的純邏輯守護。
//
// 實例來自 2026-08-30 的 PttBug 錄製：`※ 文章網址:` 那行被切成兩列，
//   col 33..77  https://www.ptt.cc/bbs/PttBug/M.1788041180.A.
//   col  0..7   404.html
// ⇒ parseArticleUrl 對殘段回 null ⇒ 右鍵的「複製文章代碼／複製文章 deep link」
// 整組消失。接回去之後兩列共用同一個完整 href。
//
// 模組載入一律放檔案層級（tests/unit/module_load_cost.test.js 靜態守護）。
import { pmoreMaxCol, detectBodyWrappedUrls } from "../../src/js/body_wrap";
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
