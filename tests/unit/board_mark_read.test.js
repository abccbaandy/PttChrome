// 看板列表右鍵／長按「<板名> 設為已讀」（src/js/board_mark_read.js；board.c#board_cmd_mark_read）。
//
// 承重點：看板列表的 `v` **只作用在真游標那一列**，沒有 prompt、沒有確認 ⇒ 原生路徑一定是
// 「跳號 → 確認游標停在**同一個板名** → 才送 v」。落地認不出就停手，絕不對錯的看板送 v。
// 平滑捲動接管時的路徑在 board_list_session.test.js。
import {
  BoardMarkRead,
  boardMarkReadTargetFromFacts,
  boardJumpLanded,
} from "../../src/js/board_mark_read";
import { boardMarkReadTargetOfText } from "../../src/js/board_list_parse";
import { serializedOpHint } from "../../src/js/serialized_op_gate";
import { HINT_ERROR } from "../../src/js/status_hint";

const pad7 = (n) => String(n).padStart(7, " ");
const brdRow = (num, name) =>
  pad7(num) + "  " + name.padEnd(13, " ") + "綜合  ｜閒聊｜ 測試看板";
const lineRow = (num) =>
  pad7(num) + "   " + "-".repeat(12) + "      " + "-".repeat(42);
const folderRow = (num) => pad7(num) + "   MyFavFolder  目錄 □我的分類";
const blockedRow = (num, name) =>
  pad7(num) + "X  " + name.padEnd(13, " ") + "[禁入] <目前無法進入此看板>";
const HEADER_NUM =
  "   編號   看  板       類別   中   文   敘   述               人氣 板   主";
const FOOT_FAV =
  "  選擇看板    (a)增加看板 (s)進入已知板名 (y)列出全部 (v/V)已讀/未讀";

// body：row 3.. 依序；cursorAt ＝游標停在第幾筆（`>` 蓋 cell 0）。
function screen(body, cursorAt = 0, { header = HEADER_NUM } = {}) {
  const rowTexts = ["【看板列表】 批踢踢實業坊", "[←][q]回上層 [↑↓]選擇", header];
  for (let i = 0; i < 20; ++i) {
    let t = body[i] || "";
    if (i === cursorAt && t) t = ">" + t.slice(1);
    rowTexts.push(t);
  }
  rowTexts.push(FOOT_FAV);
  return { rowTexts, rows: 24, curX: 0, curY: 3 + cursorAt };
}
const boards = (n) => Array.from({ length: n }, (_, i) => brdRow(i + 1, "B" + (i + 1)));

function makeCore(frame = screen(boards(10))) {
  const enqueued = [];
  const hints = [];
  const core = {
    conn: { isConnected: true },
    buf: {
      rows: 24,
      cols: 80,
      cur_x: frame.curX,
      cur_y: frame.curY,
      getRowText: (r) => frame.rowTexts[r],
    },
    view: { flashListHint: (m, ms, level) => hints.push({ m, level }) },
    commandQueue: { enqueue: (cmd) => enqueued.push(cmd) },
    activeListSession: () => null,
  };
  return { core, enqueued, hints };
}

describe("boardMarkReadTargetOfText／FromFacts：哪些列給設為已讀", () => {
  test("一般看板列 → { num, name }", () => {
    expect(boardMarkReadTargetOfText(brdRow(7, "Gossiping"))).toEqual({
      num: 7,
      name: "Gossiping",
    });
  });
  test("分隔線／目錄／禁入列 → null", () => {
    expect(boardMarkReadTargetOfText(lineRow(3))).toBe(null);
    expect(boardMarkReadTargetOfText(folderRow(4))).toBe(null);
    expect(boardMarkReadTargetOfText(blockedRow(5, "SYSOP"))).toBe(null);
  });
  test("header／footer／空白列 → null；不是看板列表 → null", () => {
    const f = screen(boards(3));
    expect(boardMarkReadTargetFromFacts(f, 2)).toBe(null);
    expect(boardMarkReadTargetFromFacts(f, 23)).toBe(null);
    expect(boardMarkReadTargetFromFacts(f, 10)).toBe(null);
    expect(boardMarkReadTargetFromFacts(f, 4)).toEqual({ num: 2, name: "B2" });
    const notList = { ...f, rowTexts: f.rowTexts.map((t, i) => (i === 0 ? "【主功能表】" : t)) };
    expect(boardMarkReadTargetFromFacts(notList, 4)).toBe(null);
  });
  test("newflag（編號欄印的是文章總數）→ null：跳號會失真", () => {
    const f = screen(boards(3), 0, { header: HEADER_NUM.replace("編號", "總數") });
    expect(boardMarkReadTargetFromFacts(f, 4)).toBe(null);
  });
});

describe("boardJumpLanded：游標停在同編號、同板名", () => {
  test("對", () => {
    expect(boardJumpLanded(screen(boards(10), 4), { num: 5, name: "B5" })).toBe(true);
  });
  test("編號對但板名換了（清單變動）→ 否", () => {
    expect(boardJumpLanded(screen(boards(10), 4), { num: 5, name: "Other" })).toBe(false);
  });
  test("游標在別列 → 否", () => {
    expect(boardJumpLanded(screen(boards(10), 3), { num: 5, name: "B5" })).toBe(false);
  });
});

describe("原生：跳號 → 落地確認 → v", () => {
  test("targetAtRow 讀 buf 那一列", () => {
    const { core } = makeCore();
    expect(new BoardMarkRead(core).targetAtRow(7)).toEqual({ num: 5, name: "B5" });
  });

  test("文章列表好讀接管中（別的 session）→ null；沒連線 → null", () => {
    const { core } = makeCore();
    core.activeListSession = () => ({});
    expect(new BoardMarkRead(core).targetAtRow(7)).toBe(null);
    const c2 = makeCore().core;
    c2.conn.isConnected = false;
    expect(new BoardMarkRead(c2).targetAtRow(7)).toBe(null);
  });

  test("序列：5⏎（\\f）→ 落地才 v；完成提示板名、解除在途", () => {
    const { core, enqueued, hints } = makeCore();
    const m = new BoardMarkRead(core);
    expect(m.start({ num: 5, name: "B5" })).toBe(true);
    expect(enqueued.map((c) => c.keys)).toEqual(["5\r"]);
    expect(enqueued[0].fullRepaint).toBe(true);
    expect(serializedOpHint(core)).toBe("設定已讀中，請稍候…");
    expect(enqueued[0].expect(null, screen(boards(10), 0))).toBe(false);
    expect(enqueued[0].expect(null, screen(boards(10), 4))).toBe(true);
    enqueued[0].onDone(true);
    expect(enqueued.map((c) => c.keys)).toEqual(["5\r", "v"]);
    expect(enqueued[1].expect(null, screen(boards(10), 4))).toBe(true);
    enqueued[1].onDone(true);
    expect(core.markAllReadInFlight).toBe(false);
    expect(hints.at(-1).m).toBe("已將 B5 板設為已讀");
  });

  test("跳號落地認不出（onFail）→ 絕不送 v、錯誤提示", () => {
    const { core, enqueued, hints } = makeCore();
    new BoardMarkRead(core).start({ num: 5, name: "B5" });
    enqueued[0].onFail("miss");
    expect(enqueued).toHaveLength(1);
    expect(hints.at(-1).level).toBe(HINT_ERROR);
    expect(core.markAllReadInFlight).toBe(false);
  });

  test("別的序列化操作在途 → 提示、不送", () => {
    const { core, enqueued, hints } = makeCore();
    core.searchInFlight = true;
    expect(new BoardMarkRead(core).start({ num: 5, name: "B5" })).toBe(false);
    expect(enqueued).toEqual([]);
    expect(hints.at(-1).m).toBe("搜尋中，請稍候…");
  });
});

describe("平滑捲動接管中：交給 BoardListSession", () => {
  test("targetAtRow／start 都委給 session（onDone 說結果）", () => {
    const { core, enqueued, hints } = makeCore();
    const session = {
      markBoardReadTargetAtRow: vi.fn(() => ({ num: 9, name: "B9" })),
      markBoardRead: vi.fn((num, opts) => {
        opts.onDone();
        return true;
      }),
    };
    core.boardListSession = session;
    core.activeListSession = () => session;
    const m = new BoardMarkRead(core);
    expect(m.targetAtRow(11)).toEqual({ num: 9, name: "B9" });
    expect(session.markBoardReadTargetAtRow).toHaveBeenCalledWith(11);
    expect(m.start({ num: 9, name: "B9" })).toBe(true);
    expect(session.markBoardRead).toHaveBeenCalledWith(9, expect.anything());
    expect(enqueued).toEqual([]);
    expect(hints.at(-1).m).toBe("已將 B9 板設為已讀");
  });
});
