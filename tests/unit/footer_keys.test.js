// 功能鍵提示列解析的守護。
//
// 素材依據（pttbbs 原始碼，非畫面反推）：
//   mbbsd/bbs.c:663      "[←]離開 [→]閱讀 [Ctrl-P]發表文章 [d]刪除 [z]precious [i]看板資訊/設定 [h]說明"
//   mbbsd/board.c:1330   "[←][q]回上層 [→][r]閱讀 [↑↓]選擇 [PgUp][PgDn]翻頁 [c]新文章 [/]搜尋 [h]求助"
//   mbbsd/vtuikit.c:722  vs_footer() 固定畫在最後一列，`(` / `)` 有獨立配色
//   mbbsd/pmore.c:2195   文章 footer part3 = "(h)按鍵說明 ←[q]離開 "
//
// 最重要的一條是 **DBCS 欄位換算**：footer 一列有十幾個全形字，若解析走
// rowToText 的文字 index，每個全形字就少算一格、偏移累加，按鈕會整片往左漂。
import {
  decodeRowWithCols,
  findFunctionKeyTokens,
  keyBytesFor,
  parseFunctionKeys,
  functionKeyRows,
} from "../../src/js/footer_keys";
import { seg, row } from "./helpers/screen_fixtures";
import { u2b } from "../../src/js/string_util";

describe("keyBytesFor：只認單一按鍵", () => {
  test("ASCII 可見字元", () => {
    expect(keyBytesFor("y")).toBe("y");
    expect(keyBytesFor("X")).toBe("X");
    expect(keyBytesFor("d")).toBe("d");
    expect(keyBytesFor("z")).toBe("z");
    expect(keyBytesFor("/")).toBe("/");
    expect(keyBytesFor("h")).toBe("h");
    expect(keyBytesFor("?")).toBe("?");
  });

  test("caret notation", () => {
    expect(keyBytesFor("^X")).toBe("\x18");
    expect(keyBytesFor("^P")).toBe("\x10");
    expect(keyBytesFor("^Z")).toBe("\x1a");
  });

  test("Ctrl-X 形式（bbs.c 用這種寫法）", () => {
    expect(keyBytesFor("Ctrl-P")).toBe("\x10");
    expect(keyBytesFor("Ctrl-p")).toBe("\x10");
  });

  test("具名鍵轉接 term_keyboard 的 KeyMap", () => {
    expect(keyBytesFor("←")).toBe("\x1b[D");
    expect(keyBytesFor("→")).toBe("\x1b[C");
    expect(keyBytesFor("↑")).toBe("\x1b[A");
    expect(keyBytesFor("↓")).toBe("\x1b[B");
    expect(keyBytesFor("PgUp")).toBe("\x1b[5~");
    expect(keyBytesFor("PgDn")).toBe("\x1b[6~");
    expect(keyBytesFor("Home")).toBe("\x1b[1~");
    expect(keyBytesFor("End")).toBe("\x1b[4~");
    expect(keyBytesFor("Enter")).toBe("\r");
    expect(keyBytesFor("Esc")).toBe("\x1b");
    expect(keyBytesFor("Tab")).toBe("\t");
    expect(keyBytesFor("空白鍵")).toBe(" ");
  });

  test("多鍵組一律不認（取第一個會送錯鍵）", () => {
    // v=標已讀 / V=標未讀，語意相反；d=刪一封 / D=刪範圍。
    expect(keyBytesFor("v/V")).toBeNull();
    expect(keyBytesFor("R/y")).toBeNull();
    expect(keyBytesFor("/?a")).toBeNull();
    expect(keyBytesFor("=[]<>")).toBeNull();
    expect(keyBytesFor("↑↓")).toBeNull();
    expect(keyBytesFor("^Z/F1")).toBeNull();
    expect(keyBytesFor("^P/^G")).toBeNull();
  });

  test("空白、空字串、非按鍵文字都不認", () => {
    expect(keyBytesFor("")).toBeNull();
    expect(keyBytesFor(" ")).toBeNull();
    expect(keyBytesFor("本文已被刪除")).toBeNull();
  });
});

describe("findFunctionKeyTokens：範圍含括號本身", () => {
  test("方括號與圓括號都掃", () => {
    const t = findFunctionKeyTokens("[d]刪除 (y)回應");
    expect(t.map((x) => x.label)).toEqual(["[d]", "(y)"]);
    expect(t[0]).toMatchObject({ start: 0, end: 3, inner: "d" });
  });

  test("end 是 exclusive 且蓋住右括號", () => {
    const text = "ab[z]cd";
    const [tok] = findFunctionKeyTokens(text);
    expect(text.slice(tok.start, tok.end)).toBe("[z]");
  });

  test("多鍵組不產出候選，但同列其他單鍵照常", () => {
    const t = findFunctionKeyTokens("(=[]<>)相關文章 (y)回應 (/?a)搜尋 (^X)轉錄");
    expect(t.map((x) => x.label)).toEqual(["(y)", "(^X)"]);
  });

  test("沒有閉合括號時不炸也不產出", () => {
    expect(findFunctionKeyTokens("[d 未閉合")).toEqual([]);
    expect(findFunctionKeyTokens("")).toEqual([]);
  });

  test("board.c:1330 那一列：[↑↓] 不可點，其餘可點", () => {
    const t = findFunctionKeyTokens(
      "[←][q]回上層 [→][r]閱讀 [↑↓]選擇 [PgUp][PgDn]翻頁 [c]新文章 [/]搜尋 [h]求助",
    );
    expect(t.map((x) => x.label)).toEqual([
      "[←]",
      "[q]",
      "[→]",
      "[r]",
      "[PgUp]",
      "[PgDn]",
      "[c]",
      "[/]",
      "[h]",
    ]);
  });

  test("pmore.c:2195 的裸 ← 不可點，相鄰的 [q] 可點", () => {
    const t = findFunctionKeyTokens("(h)按鍵說明 ←[q]離開 ");
    expect(t.map((x) => x.label)).toEqual(["(h)", "[q]"]);
  });
});

describe("decodeRowWithCols：文字 index → 格子 col", () => {
  test("全形字佔兩格，colOf 逐格累加", () => {
    const chars = row(seg("離開ab"));
    const { text, colOf } = decodeRowWithCols(chars);
    expect(text.startsWith("離開ab")).toBe(true);
    expect(colOf[0]).toBe(0); // 離
    expect(colOf[1]).toBe(2); // 開
    expect(colOf[2]).toBe(4); // a
    expect(colOf[3]).toBe(5); // b
  });

  test("最後一項是列尾，供 exclusive 邊界直接取用", () => {
    const chars = row(seg("ab"));
    const { text, colOf } = decodeRowWithCols(chars);
    expect(colOf.length).toBe(text.length + 1);
    expect(colOf[colOf.length - 1]).toBe(chars.length);
  });
});

describe("parseFunctionKeys：格子空間（DBCS 換算的硬證明）", () => {
  // bbs.c:663 的整列，用真 Big5 位元組造。
  const BBS_C_663 =
    "[←]離開 [→]閱讀 [Ctrl-P]發表文章 [d]刪除 [z]搬移至 [i]看板資訊/設定 [h]說明";
  const chars = row(seg(BBS_C_663));
  const keys = parseFunctionKeys(chars);

  test("每一組都解析出來（含 Ctrl-P）", () => {
    expect(keys.map((k) => k.label)).toEqual([
      "[←]",
      "[→]",
      "[Ctrl-P]",
      "[d]",
      "[z]",
      "[i]",
      "[h]",
    ]);
    expect(keys[0].keyBytes).toBe("\x1b[D");
    expect(keys[2].keyBytes).toBe("\x10");
  });

  test("startCol 等於真 Big5 位元組的手算格號（沒有走文字 index）", () => {
    // 直接用 u2b 量：token 之前那一段字串的位元組長度就是它的起始格。
    for (const k of keys) {
      const idx = BBS_C_663.indexOf(k.label);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(k.startCol).toBe(u2b(BBS_C_663.slice(0, idx)).length);
      expect(k.endCol).toBe(k.startCol + u2b(k.label).length);
    }
  });

  test("[d] 的位置確實被全形字往右推（若走文字 index 會偏掉）", () => {
    const d = keys.find((k) => k.label === "[d]");
    const textIdx = BBS_C_663.indexOf("[d]");
    expect(d.startCol).toBeGreaterThan(textIdx);
  });

  test("vs_footer 型的文章底列：多鍵組維持純文字", () => {
    const FOOTER =
      " 文章選讀  (y)回應(X)推文(^X)轉錄 (=[]<>)相關主題 (/?a)找標題/作者 (b)進板畫面";
    const k = parseFunctionKeys(row(seg(FOOTER)));
    expect(k.map((x) => x.label)).toEqual(["(y)", "(X)", "(^X)", "(b)"]);
    for (const item of k) {
      const idx = FOOTER.indexOf(item.label);
      expect(item.startCol).toBe(u2b(FOOTER.slice(0, idx)).length);
    }
  });

  test("整列沒有候選時回 null（呼叫端不必配置空陣列）", () => {
    expect(parseFunctionKeys(row(seg("這是一般內文沒有任何按鍵")))).toBeNull();
    expect(parseFunctionKeys(null)).toBeNull();
    expect(parseFunctionKeys([])).toBeNull();
  });
});

describe("functionKeyRows", () => {
  test("MENU / LIST / LIST 變體：提示列 row 1 ＋ 最後一列", () => {
    expect(functionKeyRows(1, 24)).toEqual([1, 23]);
    expect(functionKeyRows(2, 24)).toEqual([1, 23]);
    expect(functionKeyRows(4, 24)).toEqual([1, 23]);
  });

  test("READING：只有最後一列", () => {
    expect(functionKeyRows(3, 24)).toEqual([23]);
  });

  test("其餘畫面（NORMAL / PASS / 編輯器）沒有功能鍵列", () => {
    expect(functionKeyRows(0, 24)).toBeNull();
    expect(functionKeyRows(5, 24)).toBeNull();
    expect(functionKeyRows(6, 24)).toBeNull();
    expect(functionKeyRows(undefined, 24)).toBeNull();
  });

  test("列數不合理時回 null（不產生負 index）", () => {
    expect(functionKeyRows(2, 0)).toBeNull();
    expect(functionKeyRows(2, 1)).toBeNull();
  });
});
