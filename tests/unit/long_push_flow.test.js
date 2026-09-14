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
import { u2b } from "../../src/js/string_util";
// harness 與畫面常數與 long_push_preflight.test.js 共用，見該檔頭。
import {
  harness,
  vmsg,
  ROWS,
  PROMPT,
  ARROW_PROMPT,
  TYPE_MENU,
  CONFIRM,
  ARTICLE_FOOTER,
  AID,
  ANCHOR_ROW,
  PINNED_ANCHOR_ROW,
  OTHER_ROW,
} from "./helpers/long_push_harness";

beforeAll(() => loadBig5Tables());

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
    // PTT 的原文照錄，而且標明是 PTT 說的（不是我們判斷的）。
    expect(h.results[0]).toMatchObject({
      source: "ptt",
      message: "本文已刪除",
      sent: 0,
      rest: "第一段\n第二段",
    });
    // 剩餘內容**不會**自動蓋掉使用者的剪貼簿。
    expect(h.copied).toEqual([]);
  });

  test("已送出的那幾則不會被算進剩餘內容", () => {
    const h = harness();
    h.session.start({ text: "第一段\n第二段", type: "push" });
    runOne(h);
    h.settle(vmsg("抱歉, 禁止推薦"));
    expect(h.results[0]).toMatchObject({ source: "ptt", sent: 1, rest: "第二段" });
    expect(h.copied).toEqual([]);
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
    expect(h.results[0]).toMatchObject({
      phase: "cancelled",
      source: "client",
      rest: "第一段\n第二段",
    });
    expect(h.copied).toEqual([]);
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
    expect(h.results[0]).toMatchObject({ source: "client", rest: "第一段" });
    expect(h.copied).toEqual([]);
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
    // 游標還停在原篇 ⇒ 直接 Enter 開回去，不多送任何定位鍵。
    h.settleList([OTHER_ROW(1233), ANCHOR_ROW(1234, true)], 1);
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

// ---------------------------------------------------------------------------
// 使用者實測的 bug：在熱門版推完第 1 則，列表一有增刪游標就飄掉，第 2 則**推到
// 別篇文章**。根因在 pttbbs：read_post 對 RET_DORECOMMEND 一律
// `recommend(...); return FULLUPDATE;`（bbs.c:2471-2473）⇒ 推完必定回列表，而
// 列表游標 crs_ln 只是 .DIR 行號、不綁文章身分（read.c:1198-1221 重讀 headers
// 時 crs_ln 原地不動）⇒ 同編號 ≠ 同一篇。
//
// 這一批 case 全部只問一件事：**那個會把內容推到別篇的 "X" 有沒有被送出去。**
describe("游標錨定", () => {
  // 一則推文的完整往返，最後停在指定的列表畫面上。
  const pushOneThenList = (h, rows, cursorRow) => {
    h.settle(TYPE_MENU);
    h.settle(PROMPT);
    h.settle(CONFIRM);
    h.settleList(rows, cursorRow);
  };

  test("游標飄到別篇時，不會把第 2 則推出去", () => {
    const h = harness({ localAid: null, qAid: null }); // 拿不到 AID ＝ 只能靠比對
    h.session.start({ text: "第一段\n第二段", type: "push" });
    h.settle("文章代碼(AID): 按任意鍵繼續"); // Q 回「本篇沒有 AID」
    h.settle(ARTICLE_FOOTER); // 空白關掉框 → 回到文章
    const beforeX = h.sent.length;
    expect(h.sent[h.sent.length - 1]).toBe("X");

    // 第 1 則送出 → 落回列表，游標底下已經換成別人剛貼的新文，而原篇也不在
    // 這一頁上（被擠掉了）⇒ 無從定位。
    pushOneThenList(h, [OTHER_ROW(1234), OTHER_ROW(1235, true)], 1);

    expect(h.sent.slice(beforeX)).not.toContain("X");
    expect(h.session.active).toBe(false);
    expect(h.results[0]).toMatchObject({ source: "client", rest: "第二段" });
    expect(h.results[0].message).toContain("文章位置已變動");
    expect(h.copied).toEqual([]);
  });

  test("有 AID → 先送 #<aid> 把游標釘回原篇，才送 X", () => {
    const h = harness();
    h.session.start({ text: "第一段\n第二段", type: "push" });
    pushOneThenList(h, [ANCHOR_ROW(1233), OTHER_ROW(1234, true)], 1);

    // fullRepaint: true ⇒ queue 會在 keys 後面附一個 \f。
    expect(h.sent[h.sent.length - 1]).toBe("#" + AID + "\r\f");

    // 落地：游標回到原篇 ⇒ 這時才輪到 X。
    h.settleList([ANCHOR_ROW(1233, true), OTHER_ROW(1234)], 0);
    expect(h.sent[h.sent.length - 1]).toBe("X");
  });

  // 置底文：#AID 的落地列印的是 ★ 而不是序號（bbs.c:843）⇒ cursorRowNum 為 null。
  // 舊判準把它讀成「找不到原本那篇文章」而中止送出，剩下的內容被丟回剪貼簿。
  // 判準已與 aid_navigation 共用（aidSearchLanded），這裡守住不再回歸。
  test("REGRESSION：#aid 落在置底 ★ 列 → 照樣送 X，不當成找不到", () => {
    const h = harness();
    h.session.start({ text: "第一段\n第二段", type: "push" });
    pushOneThenList(h, [PINNED_ANCHOR_ROW(false), OTHER_ROW(1234, true)], 1);
    expect(h.sent[h.sent.length - 1]).toBe("#" + AID + "\r\f");

    h.settleList([PINNED_ANCHOR_ROW(true), OTHER_ROW(1234)], 0);
    expect(h.sent[h.sent.length - 1]).toBe("X");
    expect(h.session.active).toBe(true);
  });

  test("沒有 AID 但原篇還在同一頁 → 用編號跳回去，才送 X", () => {
    const h = harness({ localAid: null, qAid: null });
    h.session.start({ text: "第一段\n第二段", type: "push" });
    h.settle("文章代碼(AID): 按任意鍵繼續");
    h.settle(ARTICLE_FOOTER);

    pushOneThenList(h, [ANCHOR_ROW(1233), OTHER_ROW(1234, true)], 1);
    expect(h.sent[h.sent.length - 1]).toBe("1233\r\f");

    h.settleList([ANCHOR_ROW(1233, true), OTHER_ROW(1234)], 0);
    expect(h.sent[h.sent.length - 1]).toBe("X");
  });

  test("編號跳落地後身分對不上 → 停手（編號沒有身分保證）", () => {
    const h = harness({ localAid: null, qAid: null });
    h.session.start({ text: "第一段\n第二段", type: "push" });
    h.settle("文章代碼(AID): 按任意鍵繼續");
    h.settle(ARTICLE_FOOTER);
    pushOneThenList(h, [ANCHOR_ROW(1233), OTHER_ROW(1234, true)], 1);
    const afterRelocate = h.sent.length;

    // 跳到 1233 了，但那一列在這一幀已經又換成別人的文章。
    h.settleList([OTHER_ROW(1233, true), OTHER_ROW(1234)], 0);
    expect(h.sent.slice(afterRelocate)).not.toContain("X");
    expect(h.session.active).toBe(false);
    expect(h.results[0]).toMatchObject({ source: "client", rest: "第二段" });
    expect(h.copied).toEqual([]);
  });

  // 轉錄文的內文標頭是**原文**作者，列表上印的是轉錄者 ⇒ 文章標頭錨點必定對不上。
  // #AID 落地是權威的，重採錨點之後就該安定下來，不可以每一則都再定位一次。
  test("#aid 落地會重採錨點，不會每則都重複定位", () => {
    const h = harness();
    h.session.start({ text: "一\n二\n三", type: "push" });
    pushOneThenList(h, [OTHER_ROW(1234, true)], 0);
    expect(h.sent[h.sent.length - 1]).toContain("#" + AID);

    h.settleList([OTHER_ROW(1234, true)], 0); // 定位落地（實務上就是原篇）
    expect(h.sent[h.sent.length - 1]).toBe("X");

    // 第 3 則：同一列，這次守門應該直接放行。
    pushOneThenList(h, [OTHER_ROW(1234, true)], 0);
    expect(h.sent[h.sent.length - 1]).toBe("X");
  });

  // 有 AID 卻沒有文章標頭（例如標頭被捲出畫面）時，絕不可以把落地幀認成基準：
  // 那一幀可能就是已經飄掉的畫面。AID 是權威的，寧可多送一次 #<aid>。
  test("讀不到文章標頭但有 AID → 用 #<aid> 定位，不拿落地幀當基準", () => {
    const h = harness({ articleRows: [] });
    h.session.start({ text: "第一段\n第二段", type: "push" });
    pushOneThenList(h, [OTHER_ROW(1234, true)], 0);
    expect(h.sent[h.sent.length - 1]).toContain("#" + AID);
  });

  test("游標沒飄 → 一個定位鍵都不多送", () => {
    const h = harness();
    h.session.start({ text: "第一段\n第二段", type: "push" });
    pushOneThenList(h, [OTHER_ROW(1233), ANCHOR_ROW(1234, true)], 1);
    // X → 1 → 內容 → y → X，中間沒有 # 也沒有編號跳。
    expect(h.sent).toHaveLength(5);
    expect(h.sent[4]).toBe("X");
  });

  test("落在文章（不是列表）就不守門 —— X 推的本來就是當前這篇", () => {
    const h = harness();
    h.session.start({ text: "第一段\n第二段", type: "push" });
    h.settle(TYPE_MENU);
    h.settle(PROMPT);
    h.settle(CONFIRM);
    h.settle(ARTICLE_FOOTER);
    expect(h.sent[h.sent.length - 1]).toBe("X");
  });

  test("最後回文章之前也守門：游標飄了就不盲送 Enter", () => {
    const h = harness({ localAid: null, qAid: null });
    h.session.start({ text: "只有一段", type: "push" });
    h.settle("文章代碼(AID): 按任意鍵繼續");
    h.settle(ARTICLE_FOOTER);
    pushOneThenList(h, [OTHER_ROW(1234), OTHER_ROW(1235, true)], 1);
    // 開錯文章比推錯更糟：定位不了就停在列表，不送 Enter。
    expect(h.sent[h.sent.length - 1]).not.toBe("\r");
    expect(h.session.active).toBe(false);
  });
});

// resolvePostAid 的合約（aid_navigation.js:485）：免費路徑命中就不按 Q，
// 落空才按；按了 Q 就一定要負責關掉那個資訊框（meta.boxOpen）。
describe("取得文章代碼", () => {
  test("畫面上掃得到文章網址 → 不按 Q，第一則直接在文章內按 X", () => {
    const h = harness();
    h.session.start({ text: "內容", type: "push" });
    expect(h.sent).toEqual(["X"]);
  });

  test("掃不到 → 按 Q，關掉資訊框之後才繼續", () => {
    const h = harness({ localAid: null });
    h.session.start({ text: "內容", type: "push" });
    expect(h.sent).toEqual(["Q"]);

    h.settle("文章代碼(AID): #1_abcDEF 按任意鍵繼續");
    expect(h.sent[1]).toBe(" "); // KEY_DISMISS，不可用 \f（會被 pressanykey 吃掉）
    h.settle(ARTICLE_FOOTER);
    expect(h.sent[2]).toBe("X");
  });

  test("Q 沒有回應 → 停手（畫面在哪都不知道，送 X 等於亂推）", () => {
    const h = harness({ localAid: null });
    h.session.start({ text: "內容", type: "push" });
    h.queue.flush();
    expect(h.session.active).toBe(false);
    expect(h.sent).not.toContain("X");
  });

  test("推完回文章時把閱讀位置還回去", () => {
    const h = harness();
    h.session._readLineIndex = 42;
    h.session.start({ text: "內容", type: "push" });
    h.session._readLineIndex = 42; // start() 會重讀（假 view 沒有 mainDisplay）
    h.settle(TYPE_MENU);
    h.settle(PROMPT);
    h.settle(CONFIRM);
    h.settleList([ANCHOR_ROW(1234, true)], 0);
    h.settle(ARTICLE_FOOTER);
    expect(h.restored).toEqual([42]);
  });
});
