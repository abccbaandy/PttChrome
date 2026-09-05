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
  tokenizeKeyGroup,
  parseFunctionKeys,
  functionKeyRows,
} from "../../src/js/footer_keys";
import { seg, row } from "./helpers/screen_fixtures";
import { u2b } from "../../src/js/string_util";
import { KeyMap } from "../../src/js/term_keyboard";

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

  test("多鍵組一律不認（keyBytesFor 的語意仍是「整組是不是一個鍵」）", () => {
    // 拆解是 tokenizeKeyGroup 的事；這支函式**永遠不可以**回「第一個鍵」，
    // 否則 v=標已讀 / V=標未讀、d=刪一封 / D=刪範圍會送反。
    expect(keyBytesFor("v/V")).toBeNull();
    expect(keyBytesFor("R/y")).toBeNull();
    expect(keyBytesFor("/?a")).toBeNull();
    expect(keyBytesFor("=[]<>")).toBeNull();
    expect(keyBytesFor("↑↓")).toBeNull();
    expect(keyBytesFor("^Z/F1")).toBeNull();
    expect(keyBytesFor("^P/^G")).toBeNull();
  });

  test("具名鍵大小寫不敏感（原始碼裡 enter / TAB / END / DEL 都出現過）", () => {
    // announce.c:271 `(enter/→)`、talk.c:1355 `TAB`、psb.c:205,648 `END` `DEL`
    expect(keyBytesFor("enter")).toBe("\r");
    expect(keyBytesFor("TAB")).toBe("\t");
    expect(keyBytesFor("END")).toBe("\x1b[4~");
    expect(keyBytesFor("pgdn")).toBe("\x1b[6~");
    expect(keyBytesFor("Del")).toBe("\x1b[3~");
  });

  test("空白、空字串、非按鍵文字都不認", () => {
    expect(keyBytesFor("")).toBeNull();
    expect(keyBytesFor(" ")).toBeNull();
    expect(keyBytesFor("本文已被刪除")).toBeNull();
  });
});

// 2026-09：複合鍵逐鍵可點。**全有全無**——只要有一個字認不出來，整組回 null
// ＝維持純文字。清單逐條對 pttbbs 原始碼校準（見各 case 的出處註解）。
describe("tokenizeKeyGroup：複合鍵拆成逐個 atom", () => {
  const atoms = (inner) =>
    (tokenizeKeyGroup(inner) || []).map((a) => (a.sep ? "/" : a.text));

  test("整組本身就是一個鍵時回單一 atom（不進拆解）", () => {
    expect(tokenizeKeyGroup("y")).toEqual([{ text: "y", keyBytes: "y" }]);
    expect(atoms("PgUp")).toEqual(["PgUp"]);
    expect(atoms("^X")).toEqual(["^X"]);
    // **Ctrl-P 必須贏過範圍規則**：`Ctrl` `-` `P` 也符合 `x-y` 的形狀。
    expect(atoms("Ctrl-P")).toEqual(["Ctrl-P"]);
    expect(atoms("Ctrl-C")).toEqual(["Ctrl-C"]);
  });

  test("串接寫法（board.c:1330 / read.c:1241 / announce.c:271 / more.c:410）", () => {
    expect(atoms("↑↓")).toEqual(["↑", "↓"]); // board.c:1330 [↑↓]選擇
    expect(atoms("=[]<>")).toEqual(["=", "[", "]", "<", ">"]); // read.c:1241
    expect(atoms("/?a")).toEqual(["/", "?", "a"]); // read.c:1241（第一段空 ⇒ 走串接）
    expect(atoms("k↑j↓")).toEqual(["k", "↑", "j", "↓"]); // announce.c:271
    expect(atoms("X%")).toEqual(["X", "%"]); // more.c:410 FOOTERMSG
    expect(atoms("←q")).toEqual(["←", "q"]); // more.c:414 (←q)離開
  });

  test("斜線寫法：每段各自是一個鍵，`/` 本身不可點", () => {
    expect(atoms("v/V")).toEqual(["v", "/", "V"]); // board.c:1283 已讀/未讀
    expect(atoms("R/y")).toEqual(["R", "/", "y"]); // read.c:1238 回信
    expect(atoms("d/D")).toEqual(["d", "/", "D"]); // read.c:1238 刪信
    expect(atoms("X/%")).toEqual(["X", "/", "%"]); // more.c:411
    expect(atoms("enter/→")).toEqual(["enter", "/", "→"]); // announce.c:271
    expect(atoms("^X/^Q")).toEqual(["^X", "/", "^Q"]);
    // `/` 的 atom 帶 sep 旗標、**沒有** keyBytes（呼叫端不得為它產生按鈕）。
    expect(tokenizeKeyGroup("v/V")[1]).toEqual({ sep: true, text: "/" });
  });

  test("atom 的 text 串起來必等於 inner（呼叫端靠這點算位移）", () => {
    for (const inner of ["↑↓", "=[]<>", "/?a", "k↑j↓", "v/V", "enter/→"]) {
      expect(tokenizeKeyGroup(inner).map((a) => a.text).join("")).toBe(inner);
    }
  });

  test("範圍寫法一律 null（不是幾個鍵）", () => {
    expect(tokenizeKeyGroup("0-9")).toBeNull();
    expect(tokenizeKeyGroup("1-9")).toBeNull();
    expect(tokenizeKeyGroup("2 - 9")).toBeNull();
    expect(tokenizeKeyGroup("0~255")).toBeNull();
  });

  test("認不出來就整組 null（全有全無，不准「取認得的那幾個」）", () => {
    // edit.c:463 `(^Z/F1)`：F1 在 KeyMap 查不到 byte ⇒ 拆成 F+1 是憑空捏造按鍵。
    expect(tokenizeKeyGroup("^Z/F1")).toBeNull();
    // `空白` 不是鍵名（NAMED_KEYS 只有 `空白鍵`）。
    expect(tokenizeKeyGroup("空白/PgDn")).toBeNull();
    expect(tokenizeKeyGroup("A, B, C...")).toBeNull(); // 空格不是鍵
    expect(tokenizeKeyGroup("正常白字黑底")).toBeNull(); // 說明文字
    expect(tokenizeKeyGroup("1~30天")).toBeNull(); // 範圍 regex 不match，串接擋下
    expect(tokenizeKeyGroup("")).toBeNull();
  });

  test("REGRESSION：pmore 狀態列的百分比不可以被拆成按鈕", () => {
    // pmore.c:2144 `(%3d%%)`：progress=100 時沒有前導空白 ⇒ `(100%)`。
    // pmore.c:2125 舊版狀態列 `(%d%%)` 連 53 都沒有空白 ⇒ `(53%)`。
    // 拆開就會多出 `1` `0` `0` `%` 四顆送得出去的按鈕（`%` 在 pmore 是推文、
    // 數字是跳頁），而且只有讀到最後一頁的人才會遇到。
    expect(tokenizeKeyGroup("100%")).toBeNull();
    expect(tokenizeKeyGroup("53%")).toBeNull();
    expect(tokenizeKeyGroup(" 53%")).toBeNull(); // 有前導空白的那一種本來就擋得掉
    // 單鍵組與範圍寫法不受影響（它們走規則 1 / 規則 2）。
    expect(atoms("1")).toEqual(["1"]);
    expect(tokenizeKeyGroup("0-9")).toBeNull();
    // `[0wb]`（edit.c 的 getdata 提示）也一併不可點——它另有「輸入欄開著不畫
    // 按鈕」那道 gate，這裡是第二層。
    expect(tokenizeKeyGroup("0wb")).toBeNull();
  });

  test("Enter 必須贏過 End（多字元具名鍵長的優先）", () => {
    expect(atoms("Enter")).toEqual(["Enter"]);
    expect(atoms("Enterq")).toEqual(["Enter", "q"]);
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

  test("複合組拆成逐個 atom（括號與 `/` 不在任何候選裡）", () => {
    const t = findFunctionKeyTokens("(=[]<>)相關文章 (y)回應 (/?a)搜尋 (^X)轉錄");
    expect(t.map((x) => x.label)).toEqual([
      "=", "[", "]", "<", ">",
      "(y)",
      "/", "?", "a",
      "(^X)",
    ]);
  });

  test("D3 的邊界鎖：複合組的 atom 範圍不含括號、也不含 `/`", () => {
    const text = "(v/V)已讀/未讀";
    const t = findFunctionKeyTokens(text);
    expect(t.map((x) => x.label)).toEqual(["v", "V"]);
    // 每一筆的文字範圍就是 atom 自己那一個字元。
    expect(text.slice(t[0].start, t[0].end)).toBe("v");
    expect(text.slice(t[1].start, t[1].end)).toBe("V");
    // 括號與斜線的位置不落在任何候選範圍內。
    for (const idx of [0, 2, 4]) {
      expect(t.some((x) => idx >= x.start && idx < x.end)).toBe(false);
    }
  });

  test("單鍵組維持現況：整組含括號可點（零回歸）", () => {
    const t = findFunctionKeyTokens("(y)回應");
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ start: 0, end: 3, inner: "y", label: "(y)" });
  });

  test("認不出來的整組維持純文字（(^Z/F1) 不產出任何候選）", () => {
    const t = findFunctionKeyTokens(" 編輯文章  (^Z/F1)說明 (^X/^Q)離開");
    expect(t.map((x) => x.label)).toEqual(["^X", "^Q"]);
  });

  test("巢狀保護：`[` 組仍不得含任何括號，`(` 組只放行方括號", () => {
    // 外層 `[` 組整組作廢（掃描續行時內層的 `(a)` 仍是一個合法單鍵組，這與改動前
    // 的行為一字未變）。
    expect(findFunctionKeyTokens("[(a)]").map((x) => x.label)).toEqual(["(a)"]);
    // 內層有落單的 `(` ⇒ 整組作廢，且沒有可續掃的完整組。
    expect(findFunctionKeyTokens("[a(b]")).toEqual([]);
    // 反過來：`(` 組含圓括號一樣作廢（同樣續掃到內層完整的那一組）。
    expect(findFunctionKeyTokens("(a(b)").map((x) => x.label)).toEqual(["(b)"]);
  });

  test("沒有閉合括號時不炸也不產出", () => {
    expect(findFunctionKeyTokens("[d 未閉合")).toEqual([]);
    expect(findFunctionKeyTokens("")).toEqual([]);
  });

  test("board.c:1330 那一列：[↑↓] 拆成兩顆，其餘照舊", () => {
    const t = findFunctionKeyTokens(
      "[←][q]回上層 [→][r]閱讀 [↑↓]選擇 [PgUp][PgDn]翻頁 [c]新文章 [/]搜尋 [h]求助",
    );
    expect(t.map((x) => x.label)).toEqual([
      "[←]",
      "[q]",
      "[→]",
      "[r]",
      "↑",
      "↓",
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

  test("vs_footer 型的文章底列：複合組逐鍵可點", () => {
    const FOOTER =
      " 文章選讀  (y)回應(X)推文(^X)轉錄 (=[]<>)相關主題 (/?a)找標題/作者 (b)進板畫面";
    const k = parseFunctionKeys(row(seg(FOOTER)));
    expect(k.map((x) => x.label)).toEqual([
      "(y)", "(X)", "(^X)",
      "=", "[", "]", "<", ">",
      "/", "?", "a",
      "(b)",
    ]);
    // 每一顆的格號都用真 Big5 位元組手算對得上（label 在該列唯一時才比得準，
    // 所以這裡逐筆用文字 index 反推 —— `[` `]` `/` 等會重複出現的另外驗）。
    const unique = k.filter(
      (x) => FOOTER.indexOf(x.label) === FOOTER.lastIndexOf(x.label),
    );
    expect(unique.length).toBeGreaterThan(0);
    for (const item of unique) {
      const idx = FOOTER.indexOf(item.label);
      expect(item.startCol).toBe(u2b(FOOTER.slice(0, idx)).length);
    }
  });

  test("複合組的 DBCS 欄位換算：(k↑j↓) 四個 atom 各佔對的格", () => {
    // announce.c:271 的精華區 footer。`↑` `↓` 是 Big5 全形＝**兩格**，
    // 走文字 index 的話 `j` `↓` 會整片往左漂。
    const FOOTER = "  離開 (k↑j↓)移動游標 (enter/→)讀取資料";
    const k = parseFunctionKeys(row(seg(FOOTER)));
    expect(k.map((x) => x.label)).toEqual(["k", "↑", "j", "↓", "enter", "→"]);
    // 起始格＝該 atom 之前那一段字串的 Big5 位元組長度。
    const startOf = (upto) => u2b(FOOTER.slice(0, upto)).length;
    const base = FOOTER.indexOf("(k↑j↓)") + 1;
    expect(k[0].startCol).toBe(startOf(base)); // k
    expect(k[1].startCol).toBe(startOf(base + 1)); // ↑
    expect(k[2].startCol).toBe(startOf(base + 2)); // j
    expect(k[3].startCol).toBe(startOf(base + 3)); // ↓
    // 全形 atom 佔兩格、半形佔一格。
    expect(k[0].endCol - k[0].startCol).toBe(1);
    expect(k[1].endCol - k[1].startCol).toBe(2);
    expect(k[1].keyBytes).toBe(KeyMap["ArrowUp"]);
    expect(k[3].keyBytes).toBe(KeyMap["ArrowDown"]);
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
