// 列表好讀的機器鍵預算與 \f 契約（2026-08-25 回報：開文偶發整畫面凍結四秒）。
//
// 症狀根因：`open-jump` 送 `2381\r` 給 server，而真游標**早就停在 2381**（前一輪
// prefetch 的錨定腿剛跳過去）⇒ 畫面零差異 ⇒ server 回 0 bytes ⇒ term_buf 的
// settle timer 只在 server 有活動時才計時 ⇒ 沒有 settle ⇒ expect 永不被評估 ⇒
// 只能苦等 4000ms 軟逾時的 \f 探針。整段期間畫面凍結、吞鍵。
// 證據：ptt-debug-20260825-105701#t=12562（對照 t=10151 的同號跳躍）。
//
// 兩條契約在這裡守：
//   1. keys 形如 `<數字>\r` 的每一腿都必須 `fullRepaint: true`——跳號的裸回應可以
//      是空的，附 \f 才保證「必有一幀可判」（protocol §6）。
//   2. 會凍住畫面的前景交易一律用快速失敗預算（250/600/1200）：PTT 正常 RTT 約
//      90ms，超過這個量級的沉默寧可降級回原生，不要凍畫面空等。
//
// 這是**表格式**守護：新增一條腿卻忘了掛 \f／忘了套預算，這裡就會紅。
import { CommandQueue } from "../../src/js/command_queue";
import { ListSession } from "../../src/js/list_session";

// listLines 只需要能被 rowToText 讀：一列 = TermChar-like 陣列。
const rowOf = (text) => text.split("").map((c) => ({ ch: c, isLeadByte: false }));

// 欄位對齊 bbs.c#readdoent（作者欄 col 17..29，★ 全形前導由 realignListColumns 補回）：
// 隨手拼的字串會讓 parseListAuthor 回 null → isPinnedListRow 判 false → 這條腿測不到。
const PINNED_ROW = "  ★".padEnd(16) + "pinner0".padEnd(13) + "[公告] 置底文";

function makeSession({ count = 40, pinned = 0, queue } = {}) {
  const enqueued = [];
  const lines = [];
  const nums = [];
  for (let i = 0; i < count; ++i) {
    nums.push(100 + i);
    lines.push(
      rowOf(` ${100 + i} + 2 6/14 someoneA     □ [閒聊] 文章 ${100 + i}`.padEnd(80))
    );
  }
  for (let i = 0; i < pinned; ++i) {
    nums.push(null);
    lines.push(rowOf(PINNED_ROW));
  }
  const termBuf = {
    rows: 24,
    cols: 80,
    listLines: lines,
    listLineNums: nums,
    lineChangeds: new Array(24).fill(false),
    changed: false,
    addEventListener() {},
    notify() {},
    getRowText: () => "",
    isUnicolor: () => false,
    settleSnapshot: null,
  };
  const view = {
    hideCursor() {},
    showCursor() {},
    resetListAccumulation() {},
    setListLoading() {},
    flashListHint() {},
    promptListInput: (label, first, cb) => cb("142"),
    blacklist: new Set(),
    titleBlacklist: [],
  };
  const q =
    queue ||
    {
      idle: true,
      inFlightKind: null,
      flush() {},
      flushPending() {},
      flushPendingKind() {},
      expedite() {},
      enqueue(cmd) {
        enqueued.push(cmd);
      },
      onSettle() {},
    };
  const s = new ListSession({ conn: { send() {} } }, view, termBuf, q);
  s.state = "active";
  s._boardName = "C_Chat";
  s._topNum = 100;
  s._selectedNum = 115;
  s._edgeUp = true;
  s._edgeDown = true;
  return { s, enqueued, termBuf };
}

// 落在 entry 區、游標停在目標序號上的 park 指紋（protocol §4 ✚）。
const parkFacts = (num) => ({
  kind: "transient",
  cursorRowNum: num,
  curX: 0,
  curY: 5,
  rows: 24,
  rowTexts: new Array(24).fill(""),
});

// 每個入口點跑一次，收集它排上線的所有指令。置底開文那條要沿著 onDone 鏈往下走
// 才看得到後面幾腿（jump → end → step → enter）。
function collectLegs() {
  const legs = [];
  const push = (label, cmds) => cmds.forEach((c) => legs.push({ label, cmd: c }));

  {
    const { s, enqueued } = makeSession();
    s._beginOpen();
    enqueued[0].onDone({}); // open-jump 收腿 → open-enter 上線
    push("open", enqueued);
  }
  {
    const { s, enqueued } = makeSession();
    s._beginJumpNumber(142);
    push("jump-number", enqueued);
  }
  {
    const { s, enqueued } = makeSession();
    s._beginLeave(); // 選取 ≠ 真游標 → sync-jump 腿先上
    enqueued[0].onDone({});
    push("leave", enqueued);
  }
  {
    const { s, enqueued } = makeSession();
    s._beginPassthroughBytes("c"); // 非白名單鍵：sync-jump → native-key
    enqueued[0].onDone({});
    push("passthrough", enqueued);
  }
  {
    const { s, enqueued } = makeSession();
    // IME 送字（ASCII 即可，u2b 對 <0x80 直接透傳、不需 Big5 表）
    s.noteTextInput("ab");
    enqueued[0].onDone({});
    push("text-input", enqueued);
  }
  {
    const { s, enqueued } = makeSession();
    s._enqueuePrefetch(false, "fill");
    push("prefetch", enqueued);
  }
  {
    const { s, enqueued } = makeSession();
    s._requestEnd();
    push("jump-end", enqueued);
  }
  {
    const { s, enqueued } = makeSession();
    s._requestHome();
    push("jump-home", enqueued);
  }
  {
    const { s, enqueued } = makeSession({ count: 40, pinned: 1 });
    s._selectedNum = null;
    s._selectedPinnedKey = s._pinnedKeyAt(40);
    s._beginOpenPinned();
    enqueued[0].onDone({}); // open-pinned-jump → open-pinned-end
    const end = enqueued[1];
    const rowTexts = new Array(24).fill("");
    rowTexts[7] = PINNED_ROW;
    // expect 通過的副作用就是記下 parkY/targetY，enqueueSteps 需要它。
    expect(end.expect({}, { curY: 5, curX: 0, rows: 24, rowTexts })).toBe(true);
    end.onDone({}); // → open-pinned-step ×2
    enqueued[enqueued.length - 1].onDone({}); // 最後一步 → open-enter
    push("open-pinned", enqueued);
  }
  return legs;
}

describe("列表好讀：機器鍵的 \\f 契約與快速失敗預算", () => {
  const legs = collectLegs();

  test("每個入口點都真的排了指令（收集器本身別靜默失效）", () => {
    const kinds = [...new Set(legs.map((l) => l.cmd.kind))].sort();
    expect(kinds).toEqual([
      "jump-end",
      "jump-home",
      "jump-number",
      "leave-board",
      "leave-sync-jump",
      "native-input",
      "native-key",
      "native-sync-jump",
      "open-enter",
      "open-jump",
      "open-pinned-end",
      "open-pinned-jump",
      "open-pinned-step",
      "prefetch-anchor-down",
      "prefetch-down",
    ]);
  });

  test("keys 形如 <數字>\\r 的每一腿都掛 fullRepaint（零回應跳號的唯一解）", () => {
    const jumps = legs.filter((l) => /^[0-9]+\r$/.test(l.cmd.keys));
    expect(jumps.length).toBe(9); // 入口數 × 各自的 sync/jump 腿
    for (const { label, cmd } of jumps)
      expect([label, cmd.kind, cmd.fullRepaint]).toEqual([label, cmd.kind, true]);
  });

  test("翻頁腿刻意不掛（有動的翻頁本來就確定性回應，附 \\f 只是流量×2）", () => {
    const page = legs.find((l) => l.cmd.kind === "prefetch-down");
    expect(page.cmd.fullRepaint).toBeUndefined();
  });

  test("會凍畫面的前景交易一律 250/600/1200", () => {
    const background = new Set(["prefetch-anchor-down", "prefetch-down"]);
    const longLived = new Set(["native-key", "native-paste", "native-input"]);
    for (const { label, cmd } of legs) {
      if (background.has(cmd.kind) || longLived.has(cmd.kind)) continue;
      expect([label, cmd.kind, cmd.timeoutMs]).toEqual([label, cmd.kind, 250]);
      expect([label, cmd.kind, cmd.probeTimeoutMs]).toEqual([label, cmd.kind, 600]);
      expect([label, cmd.kind, cmd.hardTimeoutMs]).toEqual([label, cmd.kind, 1200]);
    }
  });

  test("背景 prefetch：同樣快速探針，hard 稍寬（它不綁架任何人）", () => {
    for (const kind of ["prefetch-anchor-down", "prefetch-down"]) {
      const cmd = legs.find((l) => l.cmd.kind === kind).cmd;
      expect([kind, cmd.timeoutMs, cmd.probeTimeoutMs, cmd.hardTimeoutMs]).toEqual([
        kind,
        250,
        600,
        1500,
      ]);
    }
  });

  test("native-key／native-input 例外：維持長窗（不凍畫面，只撐住 functionMode 的吸收）", () => {
    for (const kind of ["native-key", "native-input"]) {
      const cmd = legs.find((l) => l.cmd.kind === kind).cmd;
      expect([kind, cmd.timeoutMs]).toEqual([kind, 3000]);
      // bytes 是使用者任意輸入，不附 \f
      expect([kind, cmd.fullRepaint]).toEqual([kind, undefined]);
    }
  });
});

// ---------------------------------------------------------------------------
// 症狀級重現：真 CommandQueue 全鏈，server 對跳號**完全不回應**。
// 修前：4000ms 才送探針、4094ms 才收腿（錄製檔實測）。修後：跳號自帶 \f，一個
// 往返就有答案；就算連 \f 的回應都掉了，250ms 就會再問一次。
// ---------------------------------------------------------------------------
describe("零回應跳號不得凍住畫面（ptt-debug-20260825-105701）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const openWithRealQueue = () => {
    const sent = [];
    const queue = new CommandQueue({ send: (k) => sent.push(k) });
    const { s } = makeSession({ queue });
    s._selectedNum = 115;
    // 走真正的鍵盤入口：state 轉 opening 由 reducer 負責，_beginOpen 只是執行者，
    // 而 _openFailed 的 open-timeout 只有在 opening 才有轉移（見 _armFrozenWatchdog）。
    s.onKeyDown({ key: "Enter", preventDefault() {} });
    return { s, queue, sent };
  };

  test("open-jump 帶 \\f 送出；server 全程不回時 250ms 內就再探一次，不是 4000ms", () => {
    const { s, sent } = openWithRealQueue();
    expect(s._renderMode).toBe("frozen"); // 畫面凍住了，所以每一毫秒都算數
    expect(sent).toEqual(["115\r\f"]); // 跳號腿自帶全幅重繪

    // server 一個 byte 都沒回（term_buf 因此不會 settle）。
    vi.advanceTimersByTime(249);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(sent).toEqual(["115\r\f", "\f"]); // 修前要等到 4000ms
  });

  test("探針的全幅幀落在目標序號 → 立刻收腿並送 Enter", () => {
    const { queue, sent } = openWithRealQueue();
    vi.advanceTimersByTime(250); // 探針
    queue.onSettle({}, parkFacts(115));
    expect(sent).toEqual(["115\r\f", "\f", "\r"]); // open-enter 已上線
    expect(queue.inFlightKind).toBe("open-enter");
  });

  test("連探針都沒回應：850ms 內就降級回原生，不再空等", () => {
    const { s } = openWithRealQueue();
    expect(s.state).toBe("opening");

    vi.advanceTimersByTime(250 + 600 + 1);
    expect(s.state).not.toBe("opening"); // _openFailed → functionMode 原生鏡像
    expect(s._renderMode).toBe("native");
  });
});
