// @unit-env browser
// 桌機看板列表的新文章標記（P54 電腦版，pref boardListUnreadMark）：
//   標註層 screen_annotations#applyBoardUnreadMarks（只看該列自己的 ˇ／◎ cell）
//   渲染層 render/row.js#boardUnreadWraps（只包 class、字與欄位不動）
//   守門 board_list_parse.classifyBoardListScreen（term_view._isBoardListFrameNow 用）
// 欄位出處：pttbbs mbbsd/board.c#brdlist_renderer（%7d 序號、隱板字、ˇ [8,10)、板名 %-13s、◎ [28,30)）。
import { applyBoardUnreadMarks, computeAnnotations } from "../../src/js/screen_annotations";
import { buildRow } from "../../src/render/row";
import { classifyBoardListScreen } from "../../src/js/board_list_parse";
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { row, seg } from "./helpers/screen_fixtures";

afterEach(() => unmountAll());

const board = (unread, bullet = "◎", name = "Gossiping") =>
  row(
    seg("     12 "),
    seg(unread ? "ˇ" : "  "),
    seg((name + "             ").slice(0, 13)),
    seg("綜合 "),
    seg(bullet),
    seg("[八卦]沒有開放政問" + " ".repeat(16)),
    seg("爆!"),
    seg("mod1/mod2"),
  );
const text = (n) => (n ? n.textContent : "");

describe("applyBoardUnreadMarks", () => {
  test("有 ˇ ⇒ new、讀過 ⇒ none；目錄列（沒有 ◎）不標", () => {
    const lines = [board(true), board(false), board(true, "  ")];
    const result = new Array(lines.length);
    applyBoardUnreadMarks(result, lines, { boardUnreadMark: true });
    expect(result[0].boardUnread).toBe("new");
    expect(result[1].boardUnread).toBe("none");
    expect(result[2]).toBe(undefined);
  });

  test("旗標沒開（不是看板列表、或開關關掉）⇒ 一列都不標", () => {
    const lines = [board(true), board(false)];
    const result = new Array(lines.length);
    applyBoardUnreadMarks(result, lines, { boardUnreadMark: false });
    expect(result.filter(Boolean)).toEqual([]);
  });

  test("ˇ 不在 [8,10)（欄位位移）⇒ 當讀過，不畫圓點", () => {
    const shifted = row(seg("     12  "), seg("ˇ"), seg("Gossiping   "), seg("綜合 "), seg("◎"), seg("x"));
    const result = [];
    applyBoardUnreadMarks(result, [shifted], { boardUnreadMark: true });
    expect(result[0].boardUnread).toBe("none");
  });

  test("走 computeAnnotations（非文章畫面）也會標，保留同列其他標註", () => {
    const lines = [board(true)];
    const { annotations } = computeAnnotations(lines, {
      pageState: 1,
      boardUnreadMark: true,
      functionKeyRows: null,
    });
    expect(annotations[0].boardUnread).toBe("new");
  });
});

describe("buildRow：boardUnread 只包 class、字不動", () => {
  const plain = (chars, extra = {}) => buildRow({ chars, row: 3, forceWidth: 16, ...extra }).node;

  test("new：ˇ 那兩格包 boardUnreadDot、板名包 boardNameNew", () => {
    const n = plain(board(true), { boardUnread: "new" });
    expect(text(n.querySelector(".boardUnreadDot"))).toBe("ˇ");
    expect(text(n.querySelector(".boardNameNew")).trim()).toBe("Gossiping");
    expect(n.querySelector(".boardNameDim")).toBe(null);
    expect(text(n)).toBe(text(plain(board(true))));
  });

  test("none：板名包 boardNameDim；游標所在列不暗", () => {
    const n = plain(board(false), { boardUnread: "none" });
    expect(text(n.querySelector(".boardNameDim")).trim()).toBe("Gossiping");
    expect(n.querySelector(".boardUnreadDot")).toBe(null);
    const cur = plain(board(false), { boardUnread: "none", highlightClass: "b4" });
    expect(cur.querySelector(".boardNameDim")).toBe(null);
  });

  test("游標底色從第 8 欄起（點擊範圍）：圓點與板名都在底色裡、字的順序不變", () => {
    const opts = { boardUnread: "new", highlightClass: "b4", highlightColStart: 8 };
    const n = plain(board(true), opts);
    const hl = n.querySelector(".cursorHighlight");
    expect(hl.querySelector(".boardUnreadDot")).not.toBe(null);
    expect(hl.querySelector(".boardNameNew")).not.toBe(null);
    expect(text(n)).toBe(text(plain(board(true), { highlightClass: "b4", highlightColStart: 8 })));
  });

  test("游標底色從板名起（第 10 欄）：圓點留在底色外", () => {
    const n = plain(board(true), { boardUnread: "new", highlightClass: "b4", highlightColStart: 10 });
    const hl = n.querySelector(".cursorHighlight");
    expect(hl.querySelector(".boardUnreadDot")).toBe(null);
    expect(n.querySelector(".boardUnreadDot")).not.toBe(null);
    expect(hl.querySelector(".boardNameNew")).not.toBe(null);
  });

  test("沒有 boardUnread ⇒ DOM 與原本一字不差", () => {
    expect(plain(board(true), { boardUnread: undefined }).outerHTML).toBe(plain(board(true)).outerHTML);
  });
});

describe("ScreenController：enhance.boardUnreadMark 切換時整批重畫", () => {
  test("開 ⇒ 有圓點；關 ⇒ 照原樣", () => {
    const lines = [board(true), board(false)];
    const m = mountScreen({ lines, enhance: { pageState: 1, boardUnreadMark: true } });
    expect(m.container.querySelectorAll(".boardUnreadDot").length).toBe(1);
    expect(m.container.querySelectorAll(".boardNameDim").length).toBe(1);
    m.update({ lines, enhance: { pageState: 1, boardUnreadMark: false } });
    expect(m.container.querySelectorAll(".boardUnreadDot, .boardNameNew, .boardNameDim").length).toBe(0);
  });
});

describe("看板列表守門（classifyBoardListScreen，term_view 只餵這四列）", () => {
  const ROWS = 24;
  const frame = (row0, row2, foot) => {
    const t = [];
    t[0] = row0;
    t[1] = "";
    t[2] = row2;
    t[ROWS - 1] = foot;
    return { rowTexts: t, rows: ROWS };
  };
  const FOOT = " 選擇看板    (a)增加看板 (s)進入已知板名 (y)列出全部 (v/V)已讀/未讀";
  test("我的最愛 ⇒ 是看板列表", () => {
    expect(classifyBoardListScreen(frame("【看板列表】   批踢踢實業坊", "   編號   看  板", FOOT))).not.toBe(null);
  });
  test("文章列表 ⇒ 不是", () => {
    expect(
      classifyBoardListScreen(frame("【板主:x】  看板《Test》", "   編號    日 期 作  者", " 文章選讀  (y)回應"))
    ).toBe(null);
  });
});
