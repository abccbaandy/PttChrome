// 長推文送出序列的狀態機（src/js/long_push_session.js）。
//
// 用**真的** CommandQueue ＋ 假的 buf/view（harness 形狀同 aid_navigation.test.js），
// 斷言「這一幀畫面進來之後，線上到底送出了哪些 byte」。這批 case 全是會把錯誤內容
// 推到公開看板、或讓整條序列卡死的坑：
//   - 在「時間太近」那一幀送型別鍵 → 那個 "1" 變成推文內容
//   - 型別鍵帶 Enter → Enter 被下一個 getdata 吃掉 → 空內容 → 整則靜默取消
//   - 冷卻橫幅沒消掉就重送 X → 鍵全被 vmsg 的 vkey() 吃光
//   - 失敗／取消沒有釋放 active → 整頁再也收不到鍵盤

import { loadBig5Tables } from "./helpers/load_big5_tables";
import { CommandQueue } from "../../src/js/command_queue";
import { LongPushSession } from "../../src/js/long_push_session";
import { u2b } from "../../src/js/string_util";

beforeAll(() => loadBig5Tables());

const ROWS = 24;
const PROMPT = "推 testuser: ";
const ARROW_PROMPT = "→ testuser: ";
const TYPE_MENU = "您覺得這篇文章 1.值得推薦 2.給它噓聲 3.只加→註解 [1]? ";
const CONFIRM = "推 testuser: 內容                        確定[y/N]:";
const ARTICLE_FOOTER =
  "  瀏覽 第 1/2 頁 ( 50%)  目前顯示: 第 01~23 行  (y)回應(X%)推文(h)說明(←)離開 ";
const vmsg = (msg) => " ◆ " + msg + "          [按任意鍵繼續]";

function harness(opts) {
  const o = opts || {};
  const sent = [];
  const copied = [];
  const hints = [];
  const queue = new CommandQueue({ send: (d) => sent.push(d) });
  let rowTexts = new Array(ROWS).fill("");
  const termBuf = {
    rows: ROWS,
    cols: 80,
    pageState: o.pageState === undefined ? 3 : o.pageState,
    getRowText: (r) => rowTexts[r] || "",
  };
  const view = { flashListHint: (m) => hints.push(m) };
  const core = {
    doCopy: (s) => copied.push(s),
    easyReading: { _enterFunctionMode() {} },
    listSession: { beginExternalNavigation() {} },
  };
  const session = new LongPushSession(core, view, termBuf, queue);
  // 一幀 server 回應：只填底列（其餘留白），再餵給 queue.onSettle —— 與
  // list_session._onScreenSettled 的驅動方式相同。
  const settle = (lastRow, over) => {
    rowTexts = new Array(ROWS).fill("");
    rowTexts[ROWS - 1] = lastRow;
    if (over && over.rows)
      for (const k of Object.keys(over.rows)) rowTexts[k] = over.rows[k];
    queue.onSettle(
      {},
      { rowTexts, rows: ROWS, kind: (over && over.kind) || "article" },
    );
  };
  return { session, sent, copied, hints, settle, queue };
}

// 一則推文的完整往返（走型別選單的版本）。
const runOne = (h) => {
  h.settle(TYPE_MENU);
  h.settle(PROMPT);
  h.settle(CONFIRM);
  h.settle(ARTICLE_FOOTER);
};

describe("一則推文的完整往返", () => {
  test("X → 型別鍵 → 內容+Enter → y+Enter", () => {
    const h = harness();
    h.session.start({ text: "安安你好", type: "push" });
    expect(h.sent).toEqual(["X"]);

    h.settle(TYPE_MENU);
    // bbs.c:2996 是 vkey()：**單一 byte，絕不可帶 Enter**。
    expect(h.sent).toEqual(["X", "1"]);

    h.settle(PROMPT);
    expect(h.sent[2]).toBe(u2b("安安你好") + "\r");

    h.settle(CONFIRM);
    expect(h.sent[3]).toBe("y\r");

    h.settle(ARTICLE_FOOTER);
    expect(h.session.active).toBe(false);
    expect(h.sent).toHaveLength(4);
  });

  test("選噓 / 只加→ 時送對應的型別鍵", () => {
    const boo = harness();
    boo.session.start({ text: "噓爆", type: "boo" });
    boo.settle(TYPE_MENU);
    expect(boo.sent[1]).toBe("2");

    const arrow = harness();
    arrow.session.start({ text: "補充", type: "arrow" });
    arrow.settle(TYPE_MENU);
    expect(arrow.sent[1]).toBe("3");
  });

  test("空內容不啟動", () => {
    const h = harness();
    expect(h.session.start({ text: "   \n  ", type: "push" })).toBe(false);
    expect(h.session.active).toBe(false);
    expect(h.sent).toEqual([]);
  });
});

// bbs.c#recommend 的 if/else if/else：作者本人與「時間太近」(90 秒內連推) 兩個分支
// **沒有型別選單**，底列直接就是輸入列。這時多送一個 "1" 會變成推文內容。
describe("沒有型別選單的變體", () => {
  test("時間太近 → 不送型別鍵，直接送內容", () => {
    const h = harness();
    h.session.start({ text: "第二則", type: "push" });
    h.settle(ARROW_PROMPT, {
      rows: { [ROWS - 2]: "時間太近, 使用 → 加註方式" },
    });
    expect(h.sent).toEqual(["X", u2b("第二則") + "\r"]);
  });

  test("作者本人 → 同樣直接送內容", () => {
    const h = harness();
    h.session.start({ text: "自己補充", type: "push" });
    h.settle("→ myself: ", {
      rows: { [ROWS - 2]: "作者本人, 使用 → 加註方式" },
    });
    expect(h.sent[1]).toBe(u2b("自己補充") + "\r");
  });
});

describe("多則連送", () => {
  test("第一則走型別選單、第二則走降級的 → 分支", () => {
    const h = harness();
    h.session.start({ text: "第一段\n第二段", type: "push" });
    runOne(h);
    // 第一則送完馬上開始第二則。
    expect(h.sent[4]).toBe("X");
    h.settle(ARROW_PROMPT, {
      rows: { [ROWS - 2]: "時間太近, 使用 → 加註方式" },
    });
    expect(h.sent[5]).toBe(u2b("第二段") + "\r");
    h.settle(CONFIRM);
    h.settle(ARTICLE_FOOTER);
    expect(h.session.active).toBe(false);
  });
});

describe("小天使匿名詢問", () => {
  // vans() 的空 Enter 等於答 YES，所以一定要明確送 n。
  test("送 n + Enter 而不是空 Enter", () => {
    const h = harness();
    h.session.start({ text: "內容", type: "push" });
    h.settle(TYPE_MENU);
    h.settle("要使用小天使匿名推文嗎？ [Y/n]: ");
    expect(h.sent[2]).toBe("n\r");
    h.settle(PROMPT);
    expect(h.sent[3]).toBe(u2b("內容") + "\r");
  });
});

describe("冷卻", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("先按鍵消掉橫幅，倒數完才重送 X", () => {
    const h = harness();
    h.session.start({ text: "內容", type: "push" });
    h.settle(vmsg("本板禁止快速連續推文，請再等 3 秒"));
    // vmsg 的 vkey() 迴圈要一個真按鍵才消得掉（Ctrl-L 會被 system_key_hook 吃掉）。
    expect(h.sent).toEqual(["X", " "]);

    h.settle(ARTICLE_FOOTER);
    expect(h.sent).toHaveLength(2); // 倒數期間不送任何東西
    vi.advanceTimersByTime(2999);
    expect(h.sent).toHaveLength(2);
    vi.advanceTimersByTime(2000); // 3 秒 + 一秒寬限
    expect(h.sent[2]).toBe("X");
    expect(h.session.active).toBe(true);
  });

  test("倒數期間會把剩餘秒數報給遮罩", () => {
    const h = harness();
    const seen = [];
    h.session.onChange = (p) => seen.push(p);
    h.session.start({ text: "內容", type: "push" });
    h.settle(vmsg("冷靜一下吧！ (限制 0 分 5 秒)"));
    h.settle(ARTICLE_FOOTER);
    const cooldowns = seen.filter((p) => p && p.phase === "cooldown");
    expect(cooldowns.length).toBeGreaterThan(0);
    expect(cooldowns[cooldowns.length - 1].waitSec).toBe(5);
    expect(cooldowns[0].message).toBe("冷靜一下吧！ (限制 0 分 5 秒)");
  });
});

describe("致命錯誤", () => {
  test("中止、釋放 active，剩餘內容進剪貼簿", () => {
    const h = harness();
    h.session.start({ text: "第一段\n第二段", type: "push" });
    h.settle(vmsg("本文已刪除"));
    expect(h.session.active).toBe(false);
    expect(h.copied).toEqual(["第一段\n第二段"]);
    expect(h.hints[0]).toContain("本文已刪除");
  });

  test("已送出的那幾則不會被算進剩餘內容", () => {
    const h = harness();
    h.session.start({ text: "第一段\n第二段", type: "push" });
    runOne(h);
    h.settle(vmsg("抱歉, 禁止推薦"));
    expect(h.copied).toEqual(["第二段"]);
  });

  test("認不得的畫面也停手（不繼續盲送鍵）", () => {
    const h = harness();
    h.session.start({ text: "內容", type: "push" });
    h.settle(TYPE_MENU);
    h.settle(PROMPT);
    h.settle(CONFIRM);
    const before = h.sent.length;
    // 存檔階段 server 回了資料庫錯誤。
    h.settle(vmsg("錯誤: 資料庫連線異常，無法寫入。請稍候再試。"));
    expect(h.session.active).toBe(false);
    expect(h.sent).toHaveLength(before);
  });
});

describe("取消", () => {
  test("輸入列上取消 → 送 Ctrl-C（清空 + abort，什麼都不寫）", () => {
    const h = harness();
    h.session.start({ text: "第一段\n第二段", type: "push" });
    h.settle(TYPE_MENU);
    h.settle(PROMPT);
    h.session.cancel();
    expect(h.sent[h.sent.length - 1]).toBe("\x03");

    h.settle(ARTICLE_FOOTER);
    expect(h.session.active).toBe(false);
    expect(h.copied).toEqual(["第一段\n第二段"]);
  });

  test("冷卻橫幅上取消 → 送任意鍵消橫幅", () => {
    const h = harness();
    h.session.start({ text: "內容", type: "push" });
    h.settle(vmsg("本板禁止快速連續推文，請再等 3 秒"));
    h.settle(vmsg("本板禁止快速連續推文，請再等 3 秒")); // 橫幅還在
    h.session.cancel();
    expect(h.sent[h.sent.length - 1]).toBe(" ");
  });

  test("已經回到文章時取消不多送鍵", () => {
    const h = harness();
    h.session.start({ text: "內容", type: "push" });
    h.settle(vmsg("本板禁止快速連續推文，請再等 3 秒"));
    h.settle(ARTICLE_FOOTER);
    const before = h.sent.length;
    h.session.cancel();
    expect(h.sent).toHaveLength(before);
    expect(h.session.active).toBe(false);
  });
});

describe("queue 被別人 flush 掉", () => {
  // command_queue.js:114-119：持有輸入阻擋旗標的人一定要實作 onFlushed，否則
  // active 卡在 true = 整頁再也收不到鍵盤。
  test("釋放 active 並把剩餘內容交出去", () => {
    const h = harness();
    h.session.start({ text: "第一段", type: "push" });
    h.queue.flush();
    expect(h.session.active).toBe(false);
    expect(h.copied).toEqual(["第一段"]);
  });
});

describe("送完之後的落地", () => {
  // recommend() 一律 return FULLUPDATE ⇒ 上游會把人丟回文章列表。使用者是從文章
  // 裡按的，就用一個 Enter 把他送回去（游標仍停原篇）。
  test("落在列表且起點是文章 → 補一個 Enter 回文章", () => {
    const h = harness();
    h.session.start({ text: "內容", type: "push" });
    h.settle(TYPE_MENU);
    h.settle(PROMPT);
    h.settle(CONFIRM);
    h.settle("　　　　　　　　　　", { kind: "clean-list" });
    expect(h.sent[h.sent.length - 1]).toBe("\r");
    h.settle(ARTICLE_FOOTER);
    expect(h.session.active).toBe(false);
  });

  test("落在文章 → 不多送任何鍵", () => {
    const h = harness();
    h.session.start({ text: "內容", type: "push" });
    runOne(h);
    expect(h.sent).toHaveLength(4);
  });
});

describe("長度上限的畫面校正", () => {
  // 輸入框階段是用預估值切的；真正送出前用 prompt 裡的帳號＋畫面上的推文列
  // （有沒有 IP 欄）重算，剩下的內容依新上限重切——絕不可以超過 vgetstring 的上限。
  test("IP 記錄板上過長的段落會被再切一次", () => {
    const h = harness();
    const long = "測".repeat(30); // 60 bytes
    h.session.start({ text: long, type: "push", maxBytes: 60 });
    h.settle(TYPE_MENU);
    h.settle(PROMPT, {
      rows: { 5: "推 someone: 前人的推文 1.2.3.4 08/26 12:00" },
    });
    // maxBytes = 46 - len("testuser") - 1 = 37 ⇒ 段末全形再讓 1 byte ⇒ 36 bytes。
    expect(h.sent[2]).toBe(u2b("測".repeat(18)) + "\r");
  });

  test("非 IP 板則用得到完整長度", () => {
    const h = harness();
    const long = "測".repeat(40); // 80 bytes
    h.session.start({ text: long, type: "push", maxBytes: 33 });
    h.settle(TYPE_MENU);
    h.settle(PROMPT, {
      rows: { 5: "推 someone: 前人的推文 08/26 12:00" },
    });
    // maxBytes = 61 - 8 - 1 = 52；26 個字剛好 52 bytes 會貼到上限，段末又是全形
    // ⇒ 讓出 1 byte 只送 25 個字（50 bytes）。
    expect(h.sent[2]).toBe(u2b("測".repeat(25)) + "\r");
  });

  test("遮罩看到的總則數會跟著校正後的長度更新", () => {
    const h = harness();
    const seen = [];
    h.session.onChange = (p) => seen.push(p);
    h.session.start({ text: "測".repeat(40), type: "push", maxBytes: 33 });
    expect(seen[0].total).toBe(3); // 33 bytes/則的預估
    h.settle(TYPE_MENU);
    h.settle(PROMPT, { rows: { 5: "推 someone: 前人的推文 08/26 12:00" } });
    expect(seen[seen.length - 1].total).toBe(2); // 校正成 52 bytes/則
  });
});
