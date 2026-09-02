// 看板列表平滑捲動的純解析層守護（src/js/board_list_parse.js）。
//
// 素材是**手寫的 24 列文字陣列**，格式逐格照 `3rd_script/pttbbs/mbbsd/board.c`
// #show_brdlist 的 prints 組出來（CLAUDE.md：PTT 邏輯不准猜）：
//   row0 showtitle「【看板列表】」／row1 熱鍵列／row2 vbarf 欄位列
//   row3..22 body（`while (++myrow < b_lines)`，b_lines=23 ⇒ 20 列）
//   row23 vs_footer，三個變體就是三種畫面的指紋（board.c:1279-1290）
// 這些字串同時是「哪些畫面不得 engage」的反例來源：分類看板根、全部看板、
// 按 `c` 的新文章模式（row2 是「總數」）、文章列表、主功能表。
import {
  parseBoardListNum,
  boardListRowNums,
  isBoardListSeparatorRow,
  isBoardListBlockedRow,
  isBoardListFolderRow,
  classifyBoardListScreen,
  boardListContextKind,
  boardListFetchTarget,
  boardListFetchVerdict,
  BRD_HEADER_ROWS,
} from "../../src/js/board_list_parse";

const pad7 = (n) => String(n).padStart(7, " ");

// 一般看板列：prints("%7d%c%s", head, hideChar, unread) ＋ 板名(13)…（board.c:1462）
const brdRow = (num, name, desc = "綜合  ｜閒聊｜ 測試看板") =>
  pad7(num) + "  " + name.padEnd(13, " ") + desc;
// 未讀的那一版：unread[1] 是全形「ˇ」（rowToText 收成一個字元）
const unreadRow = (num, name) =>
  pad7(num) + " ˇ" + name.padEnd(13, " ") + "綜合  ｜閒聊｜ 測試看板";
// 分隔線列（NBRD_LINE，board.c:1374）：prints("%7d %c ", …) 之後整段 `-`
const lineRow = (num) =>
  pad7(num) + "   " + "-".repeat(12) + "      " + "-".repeat(42);
// 目錄列（NBRD_FOLDER，board.c:1390）
const folderRow = (num) => pad7(num) + "   MyFavFolder  目錄 □我的分類";
// 禁入／隱板列（board.c:1427）：`%7d` 緊接 `X`，**數字後面沒有空白**
const blockedRow = (num, name) =>
  pad7(num) + "X  " + name.padEnd(13, " ") + "[禁入] <目前無法進入此看板>";

const HOTKEY_ROW =
  "[←][q]回上層 [→][r]閱\讀 [↑↓]選擇 [PgUp][PgDn]翻頁 [c]新文章 [/]搜尋 [h]求助";
const HEADER_NUM =
  "   編號   看  板       類別   中   文   敘   述               人氣 板   主";
const HEADER_TOTAL = HEADER_NUM.replace("編號", "總數");

const FOOT_FAV =
  "  選擇看板    (a)增加看板 (s)進入已知板名 (y)列出全部 (v/V)已讀/未讀";
const FOOT_CLASS =
  "  選擇看板    (m)加入/移出最愛 (s)進入已知板名 (v/V)已讀/未讀 ";
const FOOT_ALL =
  "  選擇看板    (m)加入/移出最愛 (y)只列最愛 (v/V)已讀/未讀 ";

// 一整幀看板列表。body 從 startNum 起連號（分頁對齊 ⇒ 編號＝絕對位置）。
function brdScreen({
  foot = FOOT_FAV,
  header = HEADER_NUM,
  startNum = 1,
  count = 20,
  curY = BRD_HEADER_ROWS,
  curX = 0,
  bodyRows = null,
} = {}) {
  const rowTexts = ["【看板列表】 批踢踢實業坊", HOTKEY_ROW, header];
  const body =
    bodyRows ||
    Array.from({ length: count }, (_, i) =>
      brdRow(startNum + i, "Board" + (startNum + i))
    );
  for (let i = 0; i < 20; ++i) rowTexts.push(body[i] || "");
  rowTexts.push(foot);
  return { rowTexts, curX, curY, rows: 24 };
}

describe("parseBoardListNum", () => {
  test("一般看板列：讀出 %7d 的編號", () => {
    expect(parseBoardListNum(brdRow(7, "Gossiping"))).toBe(7);
    expect(parseBoardListNum(unreadRow(123, "C_Chat"))).toBe(123);
  });

  test("游標 `>` 只蓋前置空白，數字照樣讀得到（看板數遠小於 10^6）", () => {
    expect(parseBoardListNum(">" + brdRow(42, "Test").slice(1))).toBe(42);
  });

  test("REGRESSION：禁入列的數字後面緊接 `X`，不得要求後面有空白", () => {
    // board.c:1427 是 prints("%7d", head) 直接接 prints("X%c ...")；
    // 用 /^\\s*(\\d+)\\s/ 這種「數字後必須有空白」的樣式會整列讀成 null ⇒
    // 該列不會進緩衝，畫面就少一個看板。
    expect(parseBoardListNum(blockedRow(4, "SYSOP"))).toBe(4);
  });

  test("分隔線／目錄列也有編號（非 newflag 時 board.c 一律印 %7d）", () => {
    expect(parseBoardListNum(lineRow(3))).toBe(3);
    expect(parseBoardListNum(folderRow(2))).toBe(2);
  });

  test("沒有編號的列一律 null", () => {
    expect(parseBoardListNum("")).toBeNull();
    expect(parseBoardListNum(HOTKEY_ROW)).toBeNull();
    expect(parseBoardListNum(HEADER_NUM)).toBeNull();
    expect(parseBoardListNum(FOOT_FAV)).toBeNull();
    // newflag 的群組板／無權限板印 `%7s` 空白
    expect(parseBoardListNum("          Test  ")).toBeNull();
  });

  test("數字必須落在 %7d 欄位內：第 8 欄之後才出現的數字不算編號", () => {
    expect(parseBoardListNum("        12345 這不是編號欄")).toBeNull();
  });
});

describe("boardListRowNums", () => {
  test("只掃 body（row 3..22），header 與 footer 恆為 null", () => {
    const s = brdScreen({ startNum: 21, count: 20 });
    const nums = boardListRowNums(s.rowTexts, s.rows);
    expect(nums.slice(0, 3)).toEqual([null, null, null]);
    expect(nums[3]).toBe(21);
    expect(nums[22]).toBe(40);
    expect(nums[23]).toBeNull();
  });

  test("body 短於一頁時，尾端空白列是 null（不得憑空推出編號）", () => {
    const s = brdScreen({ count: 5 });
    const nums = boardListRowNums(s.rowTexts, s.rows);
    expect(nums.slice(3, 8)).toEqual([1, 2, 3, 4, 5]);
    expect(nums.slice(8, 23).every((n) => n === null)).toBe(true);
  });
});

describe("列型態判定（Enter 前的本地守門）", () => {
  test("分隔線列：認得出來（對它按 Enter 時 board.c 直接 break，零回應）", () => {
    expect(isBoardListSeparatorRow(lineRow(3))).toBe(true);
    expect(isBoardListSeparatorRow(brdRow(3, "Gossiping"))).toBe(false);
    expect(isBoardListSeparatorRow(HEADER_NUM)).toBe(false);
  });

  test("禁入／隱板列：認得出來（HasBoardPerm 為假 ⇒ Enter 同樣零回應）", () => {
    expect(isBoardListBlockedRow(blockedRow(4, "SYSOP"))).toBe(true);
    expect(
      isBoardListBlockedRow(
        blockedRow(4, "SYSOP").replace("[禁入]", "[隱板]")
      )
    ).toBe(true);
    expect(isBoardListBlockedRow(brdRow(4, "Gossiping"))).toBe(false);
  });

  test("目錄列：Enter 會遞迴進另一份看板列表（不是文章列表）", () => {
    expect(isBoardListFolderRow(folderRow(2))).toBe(true);
    expect(isBoardListFolderRow(brdRow(2, "Gossiping"))).toBe(false);
  });
});

describe("classifyBoardListScreen — 指紋", () => {
  test("我的最愛（footer 有 (a)增加看板）⇒ variant fav、可 engage", () => {
    const c = classifyBoardListScreen(brdScreen({ foot: FOOT_FAV }));
    expect(c.variant).toBe("fav");
    expect(c.engageable).toBe(true);
    expect(c.cursorNum).toBe(1);
    expect(c.topNum).toBe(1);
  });

  test("分類看板子分類（(m)加入/移出最愛 + (s)進入已知板名）⇒ class、可 engage", () => {
    const c = classifyBoardListScreen(
      brdScreen({ foot: FOOT_CLASS, startNum: 41, curY: 5 })
    );
    expect(c.variant).toBe("class");
    expect(c.engageable).toBe(true);
    expect(c.topNum).toBe(41);
    expect(c.cursorNum).toBe(43);
  });

  test("全部看板／熱門看板（(y)只列最愛）⇒ all，本期**不 engage**", () => {
    // 判序關鍵：這個 footer 也含「(m)加入/移出最愛」，(y)只列最愛 必須先判。
    const c = classifyBoardListScreen(brdScreen({ foot: FOOT_ALL }));
    expect(c.variant).toBe("all");
    expect(c.engageable).toBe(false);
  });

  test("按 c 的新文章模式：row2 是「總數」⇒ 不 engage（%7d 印的是文章總數）", () => {
    const c = classifyBoardListScreen(
      brdScreen({ foot: FOOT_FAV, header: HEADER_TOTAL })
    );
    expect(c.newflag).toBe(true);
    expect(c.engageable).toBe(false);
  });

  test("游標沒停在 body（跑到底列的 prompt 上）⇒ 不 engage", () => {
    expect(
      classifyBoardListScreen(brdScreen({ curY: 23 })).engageable
    ).toBe(false);
    // 游標欄位太右（getdata 之類的輸入畫面）也不算落點
    expect(
      classifyBoardListScreen(brdScreen({ curX: 14 })).engageable
    ).toBe(false);
  });

  test("游標停在空白列（body 尾端）⇒ 沒有 cursorNum，不 engage", () => {
    const c = classifyBoardListScreen(brdScreen({ count: 3, curY: 10 }));
    expect(c.cursorNum).toBeNull();
    expect(c.engageable).toBe(false);
  });

  test("分類看板**根**（row0 是【分類看板】、無 footer）⇒ 完全不命中", () => {
    const rowTexts = new Array(24).fill("");
    rowTexts[0] = "【分類看板】 批踢踢實業坊";
    rowTexts[7] = "          1 ◎ 系統資訊";
    expect(
      classifyBoardListScreen({ rowTexts, curX: 10, curY: 7, rows: 24 })
    ).toBeNull();
  });

  test("文章列表（《看板》＋文章選讀）⇒ 完全不命中", () => {
    const rowTexts = new Array(24).fill("");
    rowTexts[0] = " 【板主:none】看板《Test》";
    rowTexts[2] = "   編號     日 期  作 者        文  章  標  題";
    rowTexts[3] = "   1234  + 5 9/01 someone      □ [心得] 測試";
    rowTexts[23] = " 文章選讀  (y)回應(X)推文(^X)轉錄 ";
    expect(
      classifyBoardListScreen({ rowTexts, curX: 0, curY: 3, rows: 24 })
    ).toBeNull();
  });
});

describe("boardListContextKind — reducer 吃的情境枚舉", () => {
  const ctx = (o) => boardListContextKind(o);

  test("可 engage 的看板列表 → brdlist；不可 engage 的 → brdlist-other", () => {
    expect(ctx(brdScreen({ foot: FOOT_FAV }))).toBe("brdlist");
    expect(ctx(brdScreen({ foot: FOOT_CLASS }))).toBe("brdlist");
    expect(ctx(brdScreen({ foot: FOOT_ALL }))).toBe("brdlist-other");
    expect(ctx(brdScreen({ header: HEADER_TOTAL }))).toBe("brdlist-other");
  });

  test("文章列表 → article-list（ListSession 的地盤，我們要收攤）", () => {
    const rowTexts = new Array(24).fill("");
    rowTexts[0] = " 【板主:none】看板《Test》";
    rowTexts[23] = " 文章選讀  (y)回應(X)推文 ";
    expect(ctx({ rowTexts, curX: 0, curY: 3, rows: 24 })).toBe("article-list");
  });

  test("主功能表／分類看板根／精華文章 → menu（已離開看板列表）", () => {
    for (const title of ["【主功能表】", "【分類看板】", "【精華文章】"]) {
      const rowTexts = new Array(24).fill("");
      rowTexts[0] = title + " 批踢踢實業坊";
      expect(ctx({ rowTexts, curX: 0, curY: 5, rows: 24 })).toBe("menu");
    }
  });

  test("其他（prompt／半繪／說明畫面）→ other（原生鏡像照畫）", () => {
    const rowTexts = new Array(24).fill("");
    rowTexts[0] = "看板列表說明";
    expect(ctx({ rowTexts, curX: 0, curY: 5, rows: 24 })).toBe("other");
  });
});

describe("抓頁：跳號目標與落地判定", () => {
  test("目標＝緩衝邊界的下一／上一號（分頁對齊 ⇒ server 自己會對齊 head）", () => {
    expect(boardListFetchTarget({ base: 20, dir: 1 })).toBe(21);
    expect(boardListFetchTarget({ base: 21, dir: -1 })).toBe(20);
  });

  test("已經在第 1 項時往上沒有目標（不必送任何 byte）", () => {
    expect(boardListFetchTarget({ base: 1, dir: -1 })).toBeNull();
  });

  test("往下跳一號卻停在原地／往回 ⇒ search_num 夾住了 ＝ 板尾", () => {
    // stuff.c:189-208：clen > max 時回 max ⇒ 落點就是最後一項。
    expect(boardListFetchVerdict({ base: 40, landed: 40, dir: 1 }).edge).toBe(true);
    expect(boardListFetchVerdict({ base: 40, landed: 60, dir: 1 }).edge).toBe(false);
  });

  test("往上同理：沒有真的往上就是頂端", () => {
    expect(boardListFetchVerdict({ base: 21, landed: 20, dir: -1 }).edge).toBe(false);
    expect(boardListFetchVerdict({ base: 1, landed: 1, dir: -1 }).edge).toBe(true);
  });

  test("落點讀不出編號 ⇒ 不下判定（不得當成到邊）", () => {
    expect(boardListFetchVerdict({ base: 40, landed: null, dir: 1 })).toEqual({
      ok: false,
      edge: false,
    });
  });
});
