// @unit-env browser
// buf.pageLines 的 TermChar 共用化（src/js/term_char_intern.js）。
//
// 守護四件事：
//   1. 鍵是完整的 —— 真 TermBuf 跑過真 cassette（顏色、全形字、網址旗標）之後，每一格
//      的 own key 都在 INTERN_FIELDS 裡；TermChar 新增欄位卻忘了加進清單，這條紅。
//      漏了的後果是「只差在新欄位上的兩格被併成同一個物件」＝畫錯色／連結錯位。
//   2. 共用後內容不變 —— 每一格共用物件的欄位值與 prototype 都與原格相同，渲染等價。
//   3. 真的有共用 —— 同形的格子是同一個物件（否則整條優化是 no-op）。
//   4. dev／測試下凍結 —— 共用之後任何一次就地改寫都會改到全篇同形的格子，所以寫入
//      必須當場炸出來（ES module 是 strict mode）。
import ezsoft from "../e2e/cassettes/ezsoft-longpost.json";
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { buildRow } from "../../src/render/row";
import {
  INTERN_FIELDS,
  internChar,
  internRow,
  resetInternPoolForTest,
} from "../../src/js/term_char_intern";
import { loadBig5Tables, decodeRecv } from "./helpers/load_big5_tables";

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

// 跑過整卷 cassette，每一步把當下的 24 列快照下來（＝ accumulatePageLines 拿到的 newRows）。
// 整卷 150 頁重放一次就要數秒（機器忙時更久）⇒ 整個檔案只跑一次（beforeAll），
// 各 case 共用；快照是獨立物件，case 之間不會互相汙染（凍結的只有共用池裡的物件）。
let replayed = null;
const replayScreens = () => replayed;
function replayOnce() {
  const cassette = structuredClone(ezsoft);
  const buf = makeBuf(cassette.cols, cassette.rows);
  const parser = new AnsiParser(buf);
  const screens = [];
  vi.useFakeTimers();
  try {
    for (const step of cassette.steps) {
      if (!step.recv) continue;
      parser.feed(decodeRecv(step.recv));
      vi.advanceTimersByTime(300);
      // 格子是活 buffer 的物件（之後會被就地改寫）⇒ 照 term_view.cloneRow 的方式快照。
      screens.push(
        buf.lines.map((row) =>
          row.map((c) => Object.assign(Object.create(Object.getPrototypeOf(c)), c)),
        ),
      );
    }
  } finally {
    vi.useRealTimers();
  }
  return { buf, screens };
}

const ownKeys = (o) => Object.keys(o).sort();

describe("TermChar 共用化", () => {
  beforeAll(() => {
    loadBig5Tables();
    replayed = replayOnce();
  }, 60000);
  beforeEach(() => resetInternPoolForTest());

  test("INTERN_FIELDS ＝ TermChar 的全部 own 欄位（新增欄位必須同步進清單）", () => {
    const { buf, screens } = replayScreens();
    expect(screens.length).toBeGreaterThan(10);
    const seen = new Set();
    for (const screen of screens)
      for (const row of screen)
        for (const ch of row) for (const k in ch) if (Object.hasOwn(ch, k)) seen.add(k);
    // 一個 expect 比整組（逐格逐欄 expect 會是幾百萬次呼叫）。
    expect([...seen].sort()).toEqual([...INTERN_FIELDS].sort());
    // 反向：清單裡沒有已經不存在的欄位名（剛建好的 TermChar 就有全部欄位）。
    expect(Object.keys(buf.lines[0][0]).sort()).toEqual([...INTERN_FIELDS].sort());
  });

  test("共用物件的欄位值與 prototype 逐格等於原格，渲染輸出逐字相同", () => {
    const { screens } = replayScreens();
    let checkedUrl = false;
    for (const screen of screens.slice(-20)) {
      for (const row of screen) {
        const shared = internRow(row);
        expect(shared).not.toBe(row);
        // 逐格的 prototype＋全部 own 欄位值序列化後一次比（一列一個 expect）。
        const sig = (cells) =>
          cells
            .map(
              (c) =>
                (Object.getPrototypeOf(c) === Object.getPrototypeOf(row[0]) ? "P" : "x") +
                JSON.stringify(ownKeys(c).map((k) => [k, c[k]])),
            )
            .join("|");
        expect(sig(shared)).toBe(sig(row));
        if (row.some((a) => a.startOfURL)) checkedUrl = true;
        const props = { row: 3, forceWidth: 20, enableLinkInlinePreview: false };
        const want = buildRow({ ...props, chars: row });
        const got = buildRow({ ...props, chars: shared });
        expect(got.node.outerHTML).toBe(want.node.outerHTML);
      }
    }
    // 前提：素材裡真的有網址格（URL 旗標的欄位有被比到）。
    expect(checkedUrl).toBe(true);
  });

  test("同字同屬性的格子是同一個物件；任一欄位不同就不是", () => {
    const { screens } = replayScreens();
    const last = screens[screens.length - 1];
    const blanks = [];
    for (const row of last)
      for (const ch of row) if (ch.ch === " " && ch.fg === 7 && ch.bg === 0 && !ch.bright && !ch.partOfURL) blanks.push(ch);
    expect(blanks.length).toBeGreaterThan(100);
    const first = internChar(blanks[0]);
    for (const ch of blanks) {
      if (ownKeys(ch).every((k) => ch[k] === blanks[0][k]))
        expect(internChar(ch)).toBe(first);
    }
    const other = Object.assign(Object.create(Object.getPrototypeOf(blanks[0])), blanks[0], { bright: true });
    expect(internChar(other)).not.toBe(first);
    const linked = Object.assign(Object.create(Object.getPrototypeOf(blanks[0])), blanks[0], { hyperlink: "https://x.test/" });
    expect(internChar(linked)).not.toBe(first);
  });

  test("一篇長文的格子數遠大於共用物件數（真的省到）", () => {
    const { screens } = replayScreens();
    const objs = new Set();
    let cells = 0;
    for (const screen of screens)
      for (const row of screen)
        for (const ch of internRow(row)) {
          objs.add(ch);
          ++cells;
        }
    expect(cells).toBeGreaterThan(objs.size * 10);
  });

  test("dev／測試下共用物件是凍結的：就地改寫當場 throw", () => {
    const { screens } = replayScreens();
    const shared = internChar(screens[0][0][0]);
    expect(Object.isFrozen(shared)).toBe(true);
    expect(() => {
      shared.ch = "X";
    }).toThrow(TypeError);
    // 原格不受影響，照樣可寫（拿一份拷貝試，不動共用的快照）。
    const src = screens[0][0][0];
    const copy = Object.assign(Object.create(Object.getPrototypeOf(src)), src);
    copy.needUpdate = !copy.needUpdate;
    expect(copy.needUpdate).toBe(!src.needUpdate);
  });
});
