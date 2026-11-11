// @unit-env browser
// 存到本機（P64）的快照格式與儲存層：src/js/saved_article_codec.js、saved_articles_store.js。
//
// 守護：
//   1. 存回來的格子跟存之前畫出來一模一樣（真 TermBuf＋AnsiParser 寫入顏色、全形字、網址，
//      buildRow 輸出逐列相同）、prototype 相同、needUpdate 清掉。
//   2. 讀回來的資料不可信：任何一處對不上 decode 回 null，不畫半份。
//   3. 儲存層：清單只讀摘要、新存的在前、同一篇覆蓋不佔名額、滿了拒絕（不自動刪舊的）、
//      太長拒絕、刪除兩邊都刪、IndexedDB 不可用時不 throw。
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { buildRow } from "../../src/render/row";
import { INTERN_FIELDS, resetInternPoolForTest } from "../../src/js/term_char_intern";
import {
  ATTR_FIELDS,
  SAVED_ARTICLE_VERSION,
  buildSavedArticle,
  decodeRows,
  encodeRows,
  savedArticleKey,
  savedArticleMeta,
} from "../../src/js/saved_article_codec";
import { SavedArticlesStore } from "../../src/js/saved_articles_store";
import {
  SavedArticles,
  savableArticle,
  savedReaderKeyFrom,
  savedReaderUrl,
  staticReaderKey,
} from "../../src/js/saved_articles";
import { loadBig5Tables } from "./helpers/load_big5_tables";

const ESC = "\x1b";
// Big5「作者」「標題」「時間」與內文的中文字（0xA7 0x40 ＝「作」…），直接寫位元組。
const BIG5 = {
  author: "\xa7\x40\xaa\xcc",
  title: "\xbc\xd0\xc3\x44",
  time: "\xae\xc9\xb6\xa1",
  body: "\xa4\xa4\xa4\xe5",
};

function makeBuf(cols, rows) {
  const buf = new TermBuf(cols, rows);
  buf.setView({
    update() {
      for (let r = 0; r < buf.rows; ++r) buf.lineChangeds[r] = false;
    },
    updateCursorPos() {},
    refreshCursorVisibility() {},
    blinkOn: false,
  });
  buf.useMouseBrowsing = false;
  return buf;
}

// 一頁有檔頭、彩色字、全形字、網址的文章；回傳「累積頁」形狀的列快照＋每列文字。
function articlePage() {
  const buf = makeBuf(80, 24);
  const parser = new AnsiParser(buf);
  parser.feed(
    ESC + "[H" + ESC + "[2J" +
      ESC + "[34;47m " + BIG5.author + " " + ESC + "[44;37m someone (nick)" + ESC + "[m\r\n" +
      ESC + "[34;47m " + BIG5.title + " " + ESC + "[44;37m [test] hello" + ESC + "[m\r\n" +
      ESC + "[34;47m " + BIG5.time + " " + ESC + "[44;37m Mon Nov 10 12:00:00 2026" + ESC + "[m\r\n" +
      "\r\n" +
      ESC + "[1;33m" + BIG5.body + ESC + "[m plain https://example.com/a.png tail\r\n" +
      ESC + "[5;31;42mblink" + ESC + "[m " + ESC + "[4munder" + ESC + "[m\r\n"
  );
  buf.updateCharAttr();
  const rows = buf.lines.map((row) =>
    row.map((c) => Object.assign(Object.create(Object.getPrototypeOf(c)), c))
  );
  const texts = rows.map((_, r) => buf.getRowText(r, 0, buf.cols));
  return { buf, rows, texts };
}

const html = (row) => buildRow({ chars: row, row: 0, forceWidth: 20 }).node.outerHTML;

beforeAll(() => loadBig5Tables());
beforeEach(() => resetInternPoolForTest());

describe("encodeRows／decodeRows", () => {
  test("屬性欄位＝INTERN_FIELDS 去掉 ch、needUpdate（TermChar 新欄位會自動跟著存）", () => {
    expect(ATTR_FIELDS).toEqual(INTERN_FIELDS.filter((f) => f !== "ch" && f !== "needUpdate"));
  });

  test("存回來畫出來一模一樣（顏色、全形字、網址、閃爍、底線）", () => {
    const { buf, rows } = articlePage();
    // 前提：素材真的有網址與全形字，不然這條等於沒測。
    expect(rows[4].some((c) => c.partOfURL)).toBe(true);
    expect(rows[0].some((c) => c.isLeadByte)).toBe(true);
    const enc = JSON.parse(JSON.stringify(encodeRows(rows)));
    const back = decodeRows(enc, Object.getPrototypeOf(buf.attr));
    expect(back).toHaveLength(rows.length);
    for (let r = 0; r < rows.length; ++r) {
      expect(html(back[r])).toBe(html(rows[r]));
      for (let c = 0; c < rows[r].length; ++c) {
        expect(Object.getPrototypeOf(back[r][c])).toBe(Object.getPrototypeOf(rows[r][c]));
        expect(back[r][c].needUpdate).toBe(false);
        for (const f of ATTR_FIELDS) expect(back[r][c][f]).toBe(rows[r][c][f]);
        expect(back[r][c].ch).toBe(rows[r][c].ch);
      }
    }
  });

  test("屬性表去重、每列是一個字串＋run（不是一格一個物件）", () => {
    const { rows } = articlePage();
    const enc = encodeRows(rows);
    expect(enc.attrs.length).toBeLessThan(20);
    expect(typeof enc.rows[0].t).toBe("string");
    expect(enc.rows[0].t).toHaveLength(80);
    // 空白列整列一個 run。
    expect(enc.rows[10].a).toHaveLength(2);
  });

  test("某格不是單一 code unit ⇒ 那一列存字元陣列，欄位不位移", () => {
    const { buf, rows } = articlePage();
    const odd = rows[4].slice();
    odd[0] = Object.assign(Object.create(Object.getPrototypeOf(odd[0])), odd[0], { ch: "ab" });
    const enc = encodeRows([odd]);
    expect(enc.rows[0].c).toHaveLength(80);
    const back = decodeRows(enc, Object.getPrototypeOf(buf.attr));
    expect(back[0][0].ch).toBe("ab");
    expect(back[0][1].ch).toBe(odd[1].ch);
  });

  test.each([
    ["null", null],
    ["沒有 attrs", { rows: [] }],
    ["屬性筆數不對", { attrs: [[1, 2]], rows: [{ t: "a", a: [0, 1] }] }],
    ["索引超出", { attrs: [], rows: [{ t: "a", a: [0, 1] }] }],
    ["run 長度不是正整數", { attrs: [ATTR_FIELDS.map(() => 0)], rows: [{ t: "a", a: [0, 0] }] }],
    ["run 總長 ≠ 字數", { attrs: [ATTR_FIELDS.map(() => 0)], rows: [{ t: "ab", a: [0, 1] }] }],
    ["run 超過字數", { attrs: [ATTR_FIELDS.map(() => 0)], rows: [{ t: "a", a: [0, 2] }] }],
    ["奇數長度的 run 陣列", { attrs: [ATTR_FIELDS.map(() => 0)], rows: [{ t: "a", a: [0, 1, 0] }] }],
    ["列沒有字", { attrs: [ATTR_FIELDS.map(() => 0)], rows: [{ a: [0, 1] }] }],
  ])("壞資料（%s）⇒ null", (_, enc) => {
    expect(decodeRows(enc, {})).toBeNull();
  });
});

describe("buildSavedArticle／savedArticleMeta", () => {
  test("摘要取自檔頭；身分一定要有看板＋AID", () => {
    const { rows, texts } = articlePage();
    const rec = buildSavedArticle({
      rows,
      rowTexts: texts,
      board: "Test",
      aid: "1abcDEFG",
      url: "https://www.ptt.cc/bbs/Test/M.1.A.123.html",
      cols: 80,
      savedAt: 1000,
    });
    expect(rec.key).toBe(savedArticleKey("Test", "1abcDEFG"));
    expect(rec.key).toBe("test/1abcDEFG");
    expect(rec.v).toBe(SAVED_ARTICLE_VERSION);
    expect(rec.author).toBe("someone");
    expect(rec.title).toBe("[test] hello");
    expect(rec.lineCount).toBe(24);
    const meta = savedArticleMeta(rec);
    expect(meta).not.toHaveProperty("body");
    expect(meta.savedAt).toBe(1000);
    expect(buildSavedArticle({ rows, rowTexts: texts, board: "Test", aid: "" })).toBeNull();
    expect(buildSavedArticle({ rows: [], rowTexts: [], board: "Test", aid: "1abcDEFG" })).toBeNull();
  });

  test("版本不對的紀錄 ⇒ 摘要 null", () => {
    expect(savedArticleMeta({ v: SAVED_ARTICLE_VERSION + 1, key: "a/b" })).toBeNull();
    expect(savedArticleMeta(null)).toBeNull();
  });
});

describe("SavedArticlesStore（真 IndexedDB）", () => {
  let n = 0;
  const stores = [];
  function makeStore(opts) {
    const s = new SavedArticlesStore(
      Object.assign({ name: "saved-articles-test-" + Date.now() + "-" + n++ }, opts)
    );
    stores.push(s);
    return s;
  }
  afterEach(() => {
    while (stores.length) {
      const s = stores.pop();
      s.close();
      indexedDB.deleteDatabase(s._name);
    }
  });

  function rec(aid, savedAt, lines) {
    const { rows, texts } = articlePage();
    const r = buildSavedArticle({ rows, rowTexts: texts, board: "Test", aid, cols: 80, savedAt });
    if (lines) r.lineCount = lines;
    return r;
  }

  test("存、列清單（新的在前、只有摘要）、讀整篇、刪除", async () => {
    const s = makeStore();
    expect(await s.list()).toEqual([]);
    expect(await s.put(rec("1aaaaaaa", 1))).toEqual({ ok: true, replaced: false });
    expect(await s.put(rec("1bbbbbbb", 2))).toEqual({ ok: true, replaced: false });
    const list = await s.list();
    expect(list.map((m) => m.aid)).toEqual(["1bbbbbbb", "1aaaaaaa"]);
    expect(list[0]).not.toHaveProperty("body");
    expect(await s.has("test/1aaaaaaa")).toBe(true);
    const full = await s.get("test/1aaaaaaa");
    expect(full.body.rows).toHaveLength(24);
    expect(await s.remove("test/1aaaaaaa")).toEqual({ ok: true });
    expect(await s.has("test/1aaaaaaa")).toBe(false);
    expect(await s.get("test/1aaaaaaa")).toBeNull();
    expect((await s.list()).map((m) => m.aid)).toEqual(["1bbbbbbb"]);
  });

  test("同一篇再存＝覆蓋，不佔新名額；滿了拒絕、不刪舊的", async () => {
    const s = makeStore({ limit: 2 });
    await s.put(rec("1aaaaaaa", 1));
    await s.put(rec("1bbbbbbb", 2));
    expect(await s.put(rec("1aaaaaaa", 3))).toEqual({ ok: true, replaced: true });
    expect(await s.put(rec("1ccccccc", 4))).toEqual({ ok: false, reason: "full" });
    const list = await s.list();
    expect(list.map((m) => m.aid)).toEqual(["1aaaaaaa", "1bbbbbbb"]);
    expect(list[0].savedAt).toBe(3);
  });

  test("太長、壞紀錄拒絕", async () => {
    const s = makeStore({ maxLines: 10 });
    expect(await s.put(rec("1aaaaaaa", 1))).toEqual({ ok: false, reason: "tooLarge" });
    expect(await s.put({ v: 1 })).toEqual({ ok: false, reason: "invalid" });
    expect(await s.list()).toEqual([]);
  });

  test("IndexedDB 不可用 ⇒ 不 throw，回失敗／空清單", async () => {
    const s = new SavedArticlesStore({ indexedDB: null });
    expect(await s.list()).toEqual([]);
    expect(await s.has("a/b")).toBe(false);
    expect(await s.get("a/b")).toBeNull();
    expect(await s.put(rec("1aaaaaaa", 1))).toEqual({ ok: false, reason: "error" });
    expect(await s.remove("a/b")).toEqual({ ok: false, reason: "error" });
  });
});

describe("唯讀頁網址／能不能存", () => {
  test("網址只多一個 saved，原本的 query／hash 不帶過去；讀回來同一個 key", () => {
    const url = savedReaderUrl("https://example.com/app/?site=x#Stock/1g8znzQ3", "stock/1g8znzQ3");
    expect(url).toBe("https://example.com/app/?saved=stock%2F1g8znzQ3");
    expect(savedReaderKeyFrom(new URL(url).search)).toBe("stock/1g8znzQ3");
  });

  test.each([
    ["", null],
    ["?site=x", null],
    ["?saved=", null],
    ["?saved=Stock/1g8znzQ3", null], // key 的看板一律小寫（savedArticleKey）
    ["?saved=stock/1g8zn", null],
    ["?saved=stock/1g8znzQ3x", null],
    ["?saved=..%2F1g8znzQ3x", null],
    ["?saved=stock%2F1g8znzQ3", "stock/1g8znzQ3"],
  ])("savedReaderKeyFrom(%j) ⇒ %j", (search, want) => {
    expect(savedReaderKeyFrom(search)).toBe(want);
  });

  function core(over) {
    const o = Object.assign(
      { ease: true, pageState: 3, enabled: true, fn: false, lines: 3, hit: { board: "Stock", aid: "1g8znzQ3" } },
      over
    );
    return {
      view: { useEasyReadingMode: o.ease },
      buf: { pageState: o.pageState, easyReadingFunctionMode: o.fn, pageLines: new Array(o.lines).fill([]) },
      easyReading: { _enabled: o.enabled },
      aidNavigation: { findLocalPostAid: () => o.hit },
    };
  }

  test("好讀文章＋累積頁非空＋讀得到網址列 ⇒ 可以存；任一不成立 ⇒ 不行", () => {
    expect(savableArticle(core())).toEqual({ board: "Stock", aid: "1g8znzQ3" });
    expect(savableArticle(core({ ease: false }))).toBeNull();
    expect(savableArticle(core({ pageState: 2 }))).toBeNull();
    expect(savableArticle(core({ enabled: false }))).toBeNull();
    expect(savableArticle(core({ fn: true }))).toBeNull();
    expect(savableArticle(core({ lines: 0 }))).toBeNull();
    expect(savableArticle(core({ hit: null }))).toBeNull();
    expect(savableArticle(null)).toBeNull();
  });

  test("不能存時 saveCurrent 不碰儲存、提示錯誤", async () => {
    const put = vi.fn();
    const hints = [];
    const c = core({ hit: null });
    c.view.flashListHint = (msg, ms, level) => hints.push(level);
    const res = await new SavedArticles(c, { put }).saveCurrent();
    expect(res).toEqual({ ok: false, reason: "notArticle" });
    expect(put).not.toHaveBeenCalled();
    expect(hints).toEqual(["error"]);
  });

  test("open 在新分頁開唯讀頁", () => {
    const open = vi.fn();
    const win = { open, location: { href: "https://example.com/?x=1" } };
    expect(new SavedArticles(core(), {}).open("stock/1g8znzQ3", win)).toBe(true);
    expect(open).toHaveBeenCalledWith("https://example.com/?saved=stock%2F1g8znzQ3", "_blank", "noopener");
  });
});

// 唯讀頁沒有連線：鍵盤只拿來捲動（term_view.onKeyDown 的唯讀分支），鍵位照 pmore。
describe("staticReaderKey", () => {
  const M = { scrollTop: 500, scrollHeight: 3000, clientHeight: 1000, lineHeight: 20 };
  const k = (key, mods) => staticReaderKey({ key, ...(mods || {}) }, M);
  test.each([
    ["Home", 0], ["g", 0], ["0", 0],
    ["End", 2000], ["G", 2000], ["$", 2000],
    [" ", 1400], ["PageDown", 1400], ["f", 1400],
    ["PageUp", 0], ["b", 0],
    ["ArrowDown", 520], ["j", 520], ["Enter", 520],
    ["ArrowUp", 480], ["k", 480],
  ])("%s ⇒ 捲到 %d（夾在 0～底之間）", (key, top) => {
    expect(k(key)).toEqual({ top });
  });

  test("其他鍵吞掉（不捲、也不能當打字）", () => {
    expect(k("x")).toEqual({ top: null });
    expect(k("ArrowLeft")).toEqual({ top: null });
  });

  test("Ctrl／Alt／Meta 組合鍵不管（Ctrl+F、複製留給瀏覽器）", () => {
    expect(k("f", { ctrlKey: true })).toBeNull();
    expect(k("c", { metaKey: true })).toBeNull();
    expect(k("End", { altKey: true })).toBeNull();
  });
});
