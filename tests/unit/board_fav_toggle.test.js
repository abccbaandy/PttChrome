// @unit-env browser
// 看板列表右鍵／長按「<板名> 加入／移出我的最愛」（src/js/board_fav_toggle.js；board.c#fav_cmd_toggle_or_del）。P112。
//
// 承重點：看板列表的 `m` **只作用在真游標那一列** ⇒ 原生路徑一定是「跳號 → 確認游標停在
// **同一個板名** → 才送 m」。在我的最愛清單裡 PTT 會問「你確定刪除嗎」，那一題留給使用者，
// 我們不代打。清單是哪一種認不出來 ⇒ 不給選單項。平滑捲動接管時的路徑在 board_list_session.test.js。
import { beginInFlight } from "../../src/js/article_search";
import {
  BoardFavToggle,
  boardFavTargetFromFacts,
  boardFavResponse,
  BOARD_FAV_FLAG,
} from "../../src/js/board_fav_toggle";
import { serializedOpHint } from "../../src/js/serialized_op_gate";
import { HINT_ERROR } from "../../src/js/status_hint";

const pad7 = (n) => String(n).padStart(7, " ");
const brdRow = (num, name) =>
  pad7(num) + "  " + name.padEnd(13, " ") + "綜合  ｜閒聊｜ 測試看板";
const lineRow = (num) =>
  pad7(num) + "   " + "-".repeat(12) + "      " + "-".repeat(42);
const folderRow = (num) => pad7(num) + "   MyFavFolder  目錄 □我的分類";
const HEADER_NUM =
  "   編號   看  板       類別   中   文   敘   述               人氣 板   主";
// 新版底列（board.c#brdlist_caption＋vs_cmd_bar）：我的最愛＝myfav_cmds，分類＝board_fav_cmds。
const FOOT_FAV =
  "  選擇看板    (a)增加看板 (s)進入已知板名 (y)列出全部 (v/V)已讀/未讀";
const FOOT_CLASS = "  選擇看板    (m)加入/移出最愛 (s)進入已知板名 (v/V)已讀/未讀 ";
const FOOT_UNKNOWN = "【看板列表】 (s)進入已知板名 (v/V)已讀/未讀";

function screen(body, cursorAt = 0, { foot = FOOT_FAV, header = HEADER_NUM } = {}) {
  const rowTexts = ["【看板列表】 批踢踢實業坊", "[←][q]回上層 [↑↓]選擇", header];
  for (let i = 0; i < 20; ++i) {
    let t = body[i] || "";
    if (i === cursorAt && t) t = ">" + t.slice(1);
    rowTexts.push(t);
  }
  rowTexts.push(foot);
  return { rowTexts, rows: 24, curX: 0, curY: 3 + cursorAt };
}
const boards = (n) => Array.from({ length: n }, (_, i) => brdRow(i + 1, "B" + (i + 1)));
const withFoot = (f, foot) => ({
  ...f,
  rowTexts: f.rowTexts.map((t, i) => (i === f.rows - 1 ? foot : t)),
  curX: 20,
  curY: 23,
});

function makeCore(frame = screen(boards(10))) {
  const enqueued = [];
  const hints = [];
  const state = { frame };
  const core = {
    conn: { isConnected: true },
    buf: {
      rows: 24,
      cols: 80,
      get cur_x() {
        return state.frame.curX;
      },
      get cur_y() {
        return state.frame.curY;
      },
      getRowText: (r) => state.frame.rowTexts[r],
    },
    view: { flashListHint: (m, ms, level) => hints.push({ m, level }) },
    commandQueue: { enqueue: (cmd) => enqueued.push(cmd) },
    activeListSession: () => null,
    homeDashboard: { markFavoritesStale: vi.fn() },
  };
  return { core, enqueued, hints, state };
}

beforeEach(() => {
  localStorage.removeItem("pttchrome.pref.v1");
});

describe("boardFavTargetFromFacts：哪些列給加入／移出", () => {
  test("我的最愛的看板列 → fav: true；分類看板 → fav: false", () => {
    expect(boardFavTargetFromFacts(screen(boards(10)), 7)).toEqual({ num: 5, name: "B5", fav: true });
    expect(boardFavTargetFromFacts(screen(boards(10), 0, { foot: FOOT_CLASS }), 7)).toEqual({
      num: 5,
      name: "B5",
      fav: false,
    });
  });
  test("清單種類認不出（variant unknown）→ null：m 會不會問刪除說不準", () => {
    expect(boardFavTargetFromFacts(screen(boards(10), 0, { foot: FOOT_UNKNOWN }), 7)).toBe(null);
  });
  test("分隔線／目錄列 → null（目錄按 m 是刪整個目錄）", () => {
    const f = screen([brdRow(1, "B1"), lineRow(2), folderRow(3)]);
    expect(boardFavTargetFromFacts(f, 4)).toBe(null);
    expect(boardFavTargetFromFacts(f, 5)).toBe(null);
  });
  test("newflag → null", () => {
    const f = screen(boards(3), 0, { header: HEADER_NUM.replace("編號", "總數") });
    expect(boardFavTargetFromFacts(f, 4)).toBe(null);
  });
});

describe("boardFavResponse：m 之後的回應幀", () => {
  test("重畫回清單／刪除確認／最愛滿了／認不出", () => {
    expect(boardFavResponse(screen(boards(10), 4))).toBe("list");
    expect(boardFavResponse(withFoot(screen(boards(10), 4), "你確定刪除嗎? [N/y] "))).toBe("confirm");
    expect(
      boardFavResponse(withFoot(screen(boards(10), 4), "        你的最愛太多了啦 真花心        請按任意鍵繼續"))
    ).toBe("full");
    expect(boardFavResponse({ rowTexts: ["【主功能表】"], rows: 1, curX: 0, curY: 0 })).toBe(null);
  });
});

describe("原生：跳號 → 落地確認 → m", () => {
  test("pref 關 → 選單項不出現", () => {
    localStorage.setItem("pttchrome.pref.v1", JSON.stringify({ values: { boardListFavToggle: false } }));
    const { core } = makeCore();
    expect(new BoardFavToggle(core).targetAtRow(7)).toBe(null);
  });

  test("沒連線／文章列表好讀接管中 → null", () => {
    const a = makeCore();
    a.core.conn.isConnected = false;
    expect(new BoardFavToggle(a.core).targetAtRow(7)).toBe(null);
    const b = makeCore();
    b.core.activeListSession = () => ({});
    expect(new BoardFavToggle(b.core).targetAtRow(7)).toBe(null);
  });

  test("分類看板：5⏎ → 落地才 m → 重畫回清單 ⇒ 完成提示、儀表板快取過期", () => {
    const { core, enqueued, hints, state } = makeCore(screen(boards(10), 0, { foot: FOOT_CLASS }));
    const t = new BoardFavToggle(core);
    const target = t.targetAtRow(7);
    expect(t.start(target)).toBe(true);
    expect(enqueued.map((c) => c.keys)).toEqual(["5\r"]);
    expect(serializedOpHint(core)).toBe("切換我的最愛中，請稍候…");
    expect(enqueued[0].expect(null, screen(boards(10), 0, { foot: FOOT_CLASS }))).toBe(false);
    const landed = screen(boards(10), 4, { foot: FOOT_CLASS });
    expect(enqueued[0].expect(null, landed)).toBe(true);
    state.frame = landed;
    enqueued[0].onDone(true);
    expect(enqueued.map((c) => c.keys)).toEqual(["5\r", "m"]);
    expect(enqueued[1].expect(null, landed)).toBe(true);
    enqueued[1].onDone(true);
    expect(core[BOARD_FAV_FLAG]).toBe(false);
    expect(core.homeDashboard.markFavoritesStale).toHaveBeenCalledTimes(1);
    expect(hints.at(-1).m).toBe("已把 B5 加入或移出我的最愛");
  });

  test("我的最愛：m 之後停在「你確定刪除嗎」＝落地，不代答，提示請使用者回答", () => {
    const { core, enqueued, hints, state } = makeCore();
    new BoardFavToggle(core).start({ num: 5, name: "B5", fav: true });
    state.frame = screen(boards(10), 4);
    enqueued[0].onDone(true);
    const confirm = withFoot(screen(boards(10), 4), "你確定刪除嗎? [N/y] ");
    expect(enqueued[1].expect(null, confirm)).toBe(true);
    state.frame = confirm;
    enqueued[1].onDone(true);
    expect(enqueued).toHaveLength(2); // 沒有替使用者送 y / n
    expect(hints.at(-1).m).toContain("請在下方回答");
  });

  test("最愛滿了（真花心）→ 錯誤提示", () => {
    const { core, enqueued, hints, state } = makeCore(screen(boards(10), 0, { foot: FOOT_CLASS }));
    new BoardFavToggle(core).start({ num: 5, name: "B5", fav: false });
    enqueued[0].onDone(true);
    state.frame = withFoot(screen(boards(10), 4), "你的最愛太多了啦 真花心");
    enqueued[1].onDone(true);
    expect(hints.at(-1).level).toBe(HINT_ERROR);
    expect(hints.at(-1).m).toContain("滿了");
  });

  test("跳號落地認不出（onFail）→ 絕不送 m", () => {
    const { core, enqueued, hints } = makeCore();
    new BoardFavToggle(core).start({ num: 5, name: "B5", fav: true });
    enqueued[0].onFail("miss");
    expect(enqueued).toHaveLength(1);
    expect(hints.at(-1).level).toBe(HINT_ERROR);
    expect(core[BOARD_FAV_FLAG]).toBe(false);
  });

  test("別的序列化操作在途 → 提示、不送", () => {
    const { core, enqueued, hints } = makeCore();
    beginInFlight(core);
    expect(new BoardFavToggle(core).start({ num: 5, name: "B5" })).toBe(false);
    expect(enqueued).toEqual([]);
    expect(hints.at(-1).m).toBe("搜尋中，請稍候…");
  });
});

describe("平滑捲動接管中：交給 BoardListSession", () => {
  test("targetAtRow 帶上清單種類；start 委給 session.markBoardFav", () => {
    const { core, enqueued, hints } = makeCore();
    const session = {
      _variant: "class",
      markBoardFavTargetAtRow: vi.fn(() => ({ num: 9, name: "B9" })),
      markBoardFav: vi.fn((num, opts) => {
        opts.onDone();
        return true;
      }),
    };
    core.boardListSession = session;
    core.activeListSession = () => session;
    const t = new BoardFavToggle(core);
    expect(t.targetAtRow(11)).toEqual({ num: 9, name: "B9", fav: false });
    expect(t.start({ num: 9, name: "B9", fav: false })).toBe(true);
    expect(session.markBoardFav).toHaveBeenCalledWith(9, expect.objectContaining({ name: "B9" }));
    expect(enqueued).toEqual([]);
    expect(core.homeDashboard.markFavoritesStale).toHaveBeenCalledTimes(1);
    expect(hints.at(-1).m).toBe("已把 B9 加入或移出我的最愛");
  });
});
