// 設為全部已讀（src/js/mark_all_read.js；pttbbs bbs.c#b_mark_read_unread 的 `v` 分支）。
//
// 承重點：`v` 沒進 getdata prompt 時第二步絕不可送（同「前已讀後未讀」，
// tests/unit/list_mark_read.test.js）；prompt 畫在 row 22 不是底列 ⇒ 判定要掃整個畫面。
import { MarkAllRead, markReadPromptShown } from "../../src/js/mark_all_read";
import { serializedOpHint } from "../../src/js/serialized_op_gate";
import { HINT_ERROR } from "../../src/js/status_hint";

const ROWS = 24;
const HEADER = "【板主:someone】                  看板《Test》";
const FOOTER =
  " 文章選讀  (y)回應(X)推文(^X)轉錄 (=[]<>)相關主題(/?a)找標題/作者 (b)進板畫面 ";
// pttbbs b_mark_read_unread：move(b_lines-4,0) clrtobot → 說明 → getdata(b_lines-1)。
const PROMPT = "設定所有文章 (U)未讀 (V)已讀 (W)前已讀後未讀 (Q)取消？[Q] ";

function listFrame(extra) {
  const rowTexts = Array.from({ length: ROWS }, () => "");
  rowTexts[0] = HEADER;
  for (let r = 3; r < ROWS - 1; ++r)
    rowTexts[r] =
      String(100 + r).padStart(7, " ") + " +96 6/21 someone      [問卦] 測試";
  rowTexts[ROWS - 1] = FOOTER;
  Object.keys(extra || {}).forEach((k) => (rowTexts[Number(k)] = extra[k]));
  return { rowTexts, rows: ROWS, curX: 0, curY: 3 };
}
const promptFrame = (typed = "") =>
  listFrame({
    20: "設定已讀未讀記錄 (注意: 文章設為已讀後不會再出現修改記號 '~')",
    22: PROMPT + typed,
    23: "",
  });

function makeCore(frame = listFrame()) {
  const enqueued = [];
  const hints = [];
  const core = {
    conn: { isConnected: true },
    buf: {
      rows: ROWS,
      cols: 80,
      cur_x: frame.curX,
      cur_y: frame.curY,
      pageState: 2,
      getRowText: (r) => frame.rowTexts[r],
      isCursorOnInputField: () => false,
    },
    view: { flashListHint: (m, ms, level) => hints.push({ m, level }) },
    commandQueue: { enqueue: (cmd) => enqueued.push(cmd) },
  };
  return { core, enqueued, hints };
}

describe("markReadPromptShown", () => {
  test("認 row 22 的 prompt（不是底列）", () => {
    expect(markReadPromptShown(promptFrame().rowTexts)).toBe(true);
  });
  test("一般列表畫面、只有說明文字都不算", () => {
    expect(markReadPromptShown(listFrame().rowTexts)).toBe(false);
    expect(
      markReadPromptShown(listFrame({ 20: "設定已讀未讀記錄" }).rowTexts),
    ).toBe(false);
    expect(markReadPromptShown(null)).toBe(false);
  });
});

describe("MarkAllRead.start：v → 等 prompt → v⏎", () => {
  test("第一步只送 v（補 \\f），而且在途旗標掛上", () => {
    const { core, enqueued } = makeCore();
    expect(new MarkAllRead(core).start()).toBe(true);
    expect(enqueued.map((c) => c.keys)).toEqual(["v"]);
    expect(enqueued[0].fullRepaint).toBe(true);
    expect(core.markAllReadInFlight).toBe(true);
    expect(serializedOpHint(core)).toBe("設為全部已讀中，請稍候…");
  });

  test("v 的 expect 只認 prompt；列表畫面判否", () => {
    const { core, enqueued } = makeCore();
    new MarkAllRead(core).start();
    expect(enqueued[0].expect(null, listFrame())).toBe(false);
    expect(enqueued[0].expect(null, promptFrame())).toBe(true);
  });

  test("v 沒進 prompt（onFail）→ 絕不送第二步、錯誤提示、解除在途", () => {
    const { core, enqueued, hints } = makeCore();
    new MarkAllRead(core).start();
    enqueued[0].onFail("timeout");
    expect(enqueued).toHaveLength(1);
    expect(core.markAllReadInFlight).toBe(false);
    expect(hints.at(-1).level).toBe(HINT_ERROR);
  });

  test("prompt 落地才送 v⏎（getdata 整行輸入）；回顯幀不算完成，列表重畫才算", () => {
    const { core, enqueued, hints } = makeCore();
    new MarkAllRead(core).start();
    expect(enqueued[0].expect(null, promptFrame())).toBe(true);
    enqueued[0].onDone(true);
    expect(enqueued.map((c) => c.keys)).toEqual(["v", "v\r"]);
    const apply = enqueued[1];
    expect(apply.expect(null, promptFrame("v"))).toBe(false);
    expect(apply.expect(null, listFrame())).toBe(true);
    apply.onDone(true);
    expect(core.markAllReadInFlight).toBe(false);
    expect(hints.at(-1).m).toBe("已將本板所有文章設為已讀");
  });
});

describe("不適用／忙碌時不送鍵但不靜默", () => {
  test("不在文章列表（主功能表）→ 提示、不送", () => {
    const { core, enqueued, hints } = makeCore(
      listFrame({ 0: "【主功能表】    批踢踢實業坊", 23: "" }),
    );
    const m = new MarkAllRead(core);
    expect(m.available()).toBe(false);
    expect(m.start()).toBe(false);
    expect(enqueued).toEqual([]);
    expect(hints.at(-1).m).toContain("只有在文章列表");
  });

  test("沒連線 → 不可用", () => {
    const { core } = makeCore();
    core.conn.isConnected = false;
    expect(new MarkAllRead(core).available()).toBe(false);
  });

  test("文章列表 → 可用", () => {
    const { core } = makeCore();
    expect(new MarkAllRead(core).available()).toBe(true);
  });

  test("別的序列化操作在途 → 提示、不送", () => {
    const { core, enqueued, hints } = makeCore();
    core.unreadJumpInFlight = true;
    expect(new MarkAllRead(core).start()).toBe(false);
    expect(enqueued).toEqual([]);
    expect(hints.at(-1).m).toBe("正在找第一篇未讀，請稍候…");
  });
});
