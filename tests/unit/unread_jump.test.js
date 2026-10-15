// 跳到第一篇未讀（src/js/unread_jump.js、docs/unread-jump.md）：已讀標記怎麼讀、
// 「第一篇」怎麼從新往舊判斷、End → PgUp… → 跳號的送鍵序列、收手條件。
import {
  listRowMark,
  pageUnreadEntries,
  initialScanState,
  scanUnreadPage,
  nextUnreadAction,
  UnreadJump,
  READ_RUN,
  MAX_PGUP,
} from "../../src/js/unread_jump";
import { pageArticleNums } from "../../src/js/comment_parse";
import { serializedOpHint } from "../../src/js/serialized_op_gate";
import { HINT_ERROR } from "../../src/js/status_hint";

const ROWS = 24;
const END = "\x1b[4~";
const PGUP = "\x1b[5~";
const pad7 = (n) => String(n).padStart(7, " ");
// pttbbs bbs.c#readdoent：%7d 序號、空白、type（cell 8）、推文數、日期、作者、標題。
const lrow = (num, mark, cursor) =>
  (cursor ? ">" + String(num).padStart(6, " ") : pad7(num)) +
  " " + mark + "96 6/21 " + "gary861226".padEnd(13, " ") + "R: [新聞] 台灣牛奶";

const HEADER = "【板主:someone】                  看板《Test》";
const FOOTER = " 文章選讀  (y)回應(X)推文(^X)轉錄 (=[]<>)相關主題(/?a)找標題/作者 (b)進板畫面 ";

// 一頁：entries 由舊到新排在 rows 3..，cursorAt ＝游標在第幾筆（預設最後一筆＝End）。
function page(entries, cursorAt) {
  const rowTexts = Array.from({ length: ROWS }, () => "");
  rowTexts[0] = HEADER;
  rowTexts[ROWS - 1] = FOOTER;
  const cur = cursorAt == null ? entries.length - 1 : cursorAt;
  entries.forEach(([num, mark], i) => (rowTexts[3 + i] = lrow(num, mark, i === cur)));
  const curY = 3 + cur;
  // 同 list_session._settleFacts 的形狀。
  const nums = pageArticleNums(rowTexts, curY);
  return {
    rowTexts,
    rows: ROWS,
    curX: 0,
    curY,
    boardName: "Test",
    kind: "clean-list",
    nums,
    cursorRowNum: nums[curY],
  };
}
const range = (from, to, markOf) => {
  const out = [];
  for (let n = from; n <= to; ++n) out.push([n, markOf(n)]);
  return out;
};

describe("listRowMark：cell 8 的已讀標記", () => {
  test("使用者給的例子", () => {
    expect(listRowMark(" 202612   8 6/20 abc0203      R: [請益] 期貨風險真的大嗎？")).toBe(" ");
    expect(listRowMark(" 202613 ~36 6/21 pujos        R: [新聞] 台灣牛奶")).toBe("~");
    expect(listRowMark(" 202614 +96 6/21 gary861226   R: [新聞] 台灣牛奶")).toBe("+");
  });
  test("新游標 > 與舊全形 ●（佔兩格）都不影響", () => {
    expect(listRowMark(">202614 +96 6/21 gary861226   R: [新聞]")).toBe("+");
    expect(listRowMark("●02614 ~96 6/21 gary861226   R: [新聞]")).toBe("~");
  });
});

describe("scanUnreadPage／nextUnreadAction：從新往舊找", () => {
  test("使用者的例子：202614 是第一篇（往上 ~、空白…連續非未讀）", () => {
    const f = page(range(202600, 202620, (n) => (n >= 202614 ? "+" : n === 202613 ? "~" : " ")));
    const s = scanUnreadPage(initialScanState(), pageUnreadEntries(f.rowTexts, f.nums, f.rows));
    expect(s.done).toBe(true);
    expect(nextUnreadAction(s, 0)).toEqual({ action: "jump", num: 202614 });
  });

  test("中間挑著讀過幾篇（< READ_RUN）不算走進已讀區", () => {
    const mark = (n) => (n >= 202610 && n <= 202611 ? " " : n >= 202600 ? "+" : " ");
    const f = page(range(202585, 202620, mark).slice(-20));
    const s = scanUnreadPage(initialScanState(), pageUnreadEntries(f.rowTexts, f.nums, f.rows));
    expect(s.done).toBe(false);
    expect(s.lastUnread).toBe(202601);
    expect(nextUnreadAction(s, 0)).toEqual({ action: "pgup" });
  });

  test("最新幾篇都讀過了 ⇒ none", () => {
    const f = page(range(202601, 202620, () => " "));
    const s = scanUnreadPage(initialScanState(), pageUnreadEntries(f.rowTexts, f.nums, f.rows));
    expect(nextUnreadAction(s, 0)).toEqual({ action: "none" });
  });

  test("M（M 標記的未讀）算未讀；D／! 蓋掉了未讀資訊 ⇒ 中性，不算進已讀連續數", () => {
    const marks = { 10: "+", 9: "D", 8: "!", 7: "M", 6: " ", 5: " ", 4: " ", 3: " ", 2: " " };
    const f = page(range(2, 10, (n) => marks[n]));
    const s = scanUnreadPage(initialScanState(), pageUnreadEntries(f.rowTexts, f.nums, f.rows));
    expect(s.lastUnread).toBe(7);
    expect(s.done).toBe(true);
    expect(READ_RUN).toBe(5);
  });

  test("翻到第 1 篇（PgUp 不再往上）⇒ 最上面那篇未讀就是答案", () => {
    const f = page(range(1, 20, () => "+"), 0);
    const s = scanUnreadPage(initialScanState(), pageUnreadEntries(f.rowTexts, f.nums, f.rows));
    expect(nextUnreadAction(s, 3)).toEqual({ action: "jump", num: 1 });
  });

  test("同一頁再讀一次（PgUp 沒動）⇒ 沒有進展，用目前找到的", () => {
    const f = page(range(30, 49, () => "+"), 0);
    const entries = pageUnreadEntries(f.rowTexts, f.nums, f.rows);
    const s1 = scanUnreadPage(initialScanState(), entries);
    const s2 = scanUnreadPage(s1, entries);
    expect(s2.progressed).toBe(false);
    expect(nextUnreadAction(s2, 1)).toEqual({ action: "jump", num: 30 });
  });

  test("翻滿 MAX_PGUP 頁還沒走進已讀區 ⇒ 放棄", () => {
    const f = page(range(1000, 1019, () => "+"));
    const s = scanUnreadPage(initialScanState(), pageUnreadEntries(f.rowTexts, f.nums, f.rows));
    expect(nextUnreadAction(s, MAX_PGUP)).toEqual({ action: "give-up" });
    expect(MAX_PGUP).toBe(20);
  });
});

// 假 App：buf 從 frame 讀（判斷是不是文章列表），CommandQueue 只收集命令。
function makeCore(start = page(range(1, 20, () => " "))) {
  const enqueued = [];
  const hints = [];
  const core = {
    conn: { isConnected: true },
    buf: {
      rows: ROWS,
      cols: 80,
      cur_x: start.curX,
      cur_y: start.curY,
      pageState: 2,
      getRowText: (r) => start.rowTexts[r],
      isCursorOnInputField: () => false,
    },
    view: { flashListHint: (m, ms, level) => hints.push({ m, level }) },
    commandQueue: { enqueue: (cmd) => enqueued.push(cmd) },
  };
  return { core, enqueued, hints };
}
// 第 i 個命令落地在 frame 上：expect 必須認得它，然後 onDone。
function land(cmd, frame) {
  expect(cmd.expect(null, frame)).toBe(true);
  cmd.onDone(true);
}

describe("UnreadJump.start：End → PgUp… → 跳號", () => {
  test("使用者的例子：End 這頁還沒走進已讀區 ⇒ PgUp，下一頁湊滿 ⇒ 跳 202614", () => {
    const { core, enqueued, hints } = makeCore();
    const mark = (n) => (n >= 202614 ? "+" : n === 202613 ? "~" : " ");
    expect(new UnreadJump(core).start()).toBe(true);
    expect(enqueued.map((c) => c.keys)).toEqual([END]);
    expect(core.unreadJumpInFlight).toBe(true);
    expect(serializedOpHint(core)).toBe("正在找第一篇未讀，請稍候…");
    // 每一步都補 \f（PgUp 到頂、跳號目標就是游標列時 PTT 送零 byte）。
    expect(enqueued[0].fullRepaint).toBe(true);

    land(enqueued[0], page(range(202611, 202630, mark)));
    expect(enqueued.map((c) => c.keys)).toEqual([END, PGUP]);
    expect(core.unreadJumpInFlight).toBe(true);

    land(enqueued[1], page(range(202591, 202610, mark), 0));
    expect(enqueued.map((c) => c.keys)).toEqual([END, PGUP, "202614\r"]);

    const jumped = page(range(202611, 202630, mark), 3);
    expect(jumped.nums[jumped.curY]).toBe(202614);
    land(enqueued[2], jumped);
    expect(core.unreadJumpInFlight).toBe(false);
    expect(hints.at(-1).m).toBe("已跳到第一篇未讀");
  });

  test("End 的 expect 不吃還沒捲到底的畫面（游標下面還有文章）", () => {
    const { core, enqueued } = makeCore();
    new UnreadJump(core).start();
    expect(enqueued[0].expect(null, page(range(1, 20, () => " "), 5))).toBe(false);
  });

  test("跳號的 expect 只認游標停在目標編號", () => {
    const { core, enqueued } = makeCore();
    new UnreadJump(core).start();
    land(enqueued[0], page(range(81, 100, (n) => (n >= 90 ? "+" : " "))));
    expect(enqueued.at(-1).keys).toBe("90\r");
    expect(enqueued.at(-1).expect(null, page(range(81, 100, () => " ")))).toBe(false);
  });

  test("沒有未讀 ⇒ 停在 End、提示、解除在途", () => {
    const { core, enqueued, hints } = makeCore();
    new UnreadJump(core).start();
    land(enqueued[0], page(range(1, 20, () => " ")));
    expect(enqueued.length).toBe(1);
    expect(core.unreadJumpInFlight).toBe(false);
    expect(hints.at(-1).m).toBe("最新的文章都讀過了，沒有未讀");
  });

  test("PgUp 20 次仍找不到 ⇒ 放棄、停在原地（不跳號）", () => {
    const { core, enqueued, hints } = makeCore();
    new UnreadJump(core).start();
    let top = 100000;
    land(enqueued[0], page(range(top - 19, top, () => "+")));
    for (let i = 1; i <= MAX_PGUP; ++i) {
      expect(enqueued[i].keys).toBe(PGUP);
      top -= 20;
      land(enqueued[i], page(range(top - 19, top, () => "+"), 0));
    }
    expect(enqueued.length).toBe(MAX_PGUP + 1);
    expect(core.unreadJumpInFlight).toBe(false);
    expect(hints.at(-1).m).toBe("往上翻了 20 頁仍找不到第一篇未讀，停在這裡");
  });

  test("某一步失敗 ⇒ 錯誤提示、解除在途", () => {
    const { core, enqueued, hints } = makeCore();
    new UnreadJump(core).start();
    enqueued[0].onFail();
    expect(core.unreadJumpInFlight).toBe(false);
    expect(hints.at(-1)).toEqual({ m: "跳到第一篇未讀失敗（已停在原生畫面）", level: HINT_ERROR });
  });

  test("不是文章列表 ⇒ 不送鍵、給提示（快捷鍵仍吞掉，不交給瀏覽器）", () => {
    const { core, enqueued, hints } = makeCore();
    core.buf.getRowText = (r) => (r === 0 ? "【主功能表】    批踢踢實業坊" : "");
    expect(new UnreadJump(core).start()).toBe(true);
    expect(enqueued).toEqual([]);
    expect(hints.at(-1).m).toBe("只有在文章列表才能跳到第一篇未讀");
  });

  test("線路忙碌（別的序列化操作在途）⇒ 不送鍵、給該操作的提示", () => {
    const { core, enqueued, hints } = makeCore();
    core.refreshInFlight = true;
    new UnreadJump(core).start();
    expect(enqueued).toEqual([]);
    expect(hints.at(-1).m).toBe("重新整理中，請稍候…");
  });
});
