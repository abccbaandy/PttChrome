// 長推文的**探路**（src/js/long_push_session.js#startPreflight）。
//
// 使用者按下 X 之後、輸入框出現之前，先送一個 X 問 PTT「這篇我推得了嗎」，
// 讀完答案再從推文流程退出來、按 ⏎ 回原文章。為什麼問得到、為什麼可以白按一次
// （lastrecommend 只在成功寫檔後更新），見 startPreflight 的註解與 docs/long-push.md。
//
// 這批 case 全是「答錯就會讓使用者白打一大段字」或「把人丟在半途的推文流程裡」
// 的坑：
//   - 被擋下來卻還是開輸入框（今天的行為）
//   - 冷卻被當成「不能推」（打完字通常早就過了那幾秒）
//   - 型別選單上只送一次 Ctrl-C → 那個 Ctrl-C 被 vkey() 當成預設值 → 停在輸入列
//   - 探完路重採錨點 → 採到已經進過 functionMode 的污染畫面

import { loadBig5Tables } from "./helpers/load_big5_tables";
import {
  harness,
  vmsg,
  PROMPT,
  ARROW_PROMPT,
  TYPE_MENU,
  ARTICLE_FOOTER,
  AID,
  ANCHOR_ROW,
  OTHER_ROW,
} from "./helpers/long_push_harness";

beforeAll(() => loadBig5Tables());

const NO_BOO_TYPE_MENU = "您覺得這篇文章 1.值得推薦 3.只加→註解 [1]? ";

// 探路的 harness：多掛一個 onPreflight 收集器。
function pre(opts) {
  const h = harness(opts);
  h.preflight = [];
  h.session.onPreflight = (r) => h.preflight.push(r);
  return h;
}

// 送 X 之後 PTT 回了 lastRow 這一幀。
const probe = (h, lastRow) => {
  h.session.startPreflight({});
  h.settle(lastRow);
};

// 退出推文流程之後落回文章列表（游標還在原篇），再按 ⏎ 回到文章。
const leaveToArticle = (h) => {
  h.settleList([ANCHOR_ROW(1234, true), OTHER_ROW(1235)], 0);
  h.settle(ARTICLE_FOOTER);
};

describe("探路的鍵序", () => {
  test("startPreflight 只送一個 X，而且線路上就只有那一個", () => {
    const h = pre();
    expect(h.session.startPreflight({})).toBe(true);
    expect(h.sent).toEqual(["X"]);
    expect(h.session.active).toBe(true);
    expect(h.preflight).toHaveLength(0);
  });

  test("型別選單 → Ctrl-C 兩次退出 → ⏎ 回文章 → 回報可以推", () => {
    const h = pre();
    probe(h, TYPE_MENU);
    // 型別選單那一格是 vkey()：第一個 Ctrl-C 會被當成「非數字＝預設值」落到輸入
    // 列，第二個才真的 abort 掉（bbs.c:2996 / vgetstring）。
    expect(h.sent).toEqual(["X", "\x03"]);
    h.settle(PROMPT);
    expect(h.sent).toEqual(["X", "\x03", "\x03"]);

    leaveToArticle(h);
    expect(h.sent).toEqual(["X", "\x03", "\x03", "\r"]);
    expect(h.session.active).toBe(false);
    expect(h.preflight[0]).toMatchObject({ blocked: false, booAllowed: true });
  });

  test("禁噓板的型別選單沒有 2. ⇒ booAllowed 為 false", () => {
    const h = pre();
    probe(h, NO_BOO_TYPE_MENU);
    h.settle(PROMPT);
    leaveToArticle(h);
    expect(h.preflight[0]).toMatchObject({ blocked: false, booAllowed: false });
  });

  test("沒有型別選單（作者本人／90 秒內）⇒ 只要一次 Ctrl-C，並回報已被降級成 →", () => {
    const h = pre();
    probe(h, ARROW_PROMPT);
    expect(h.sent).toEqual(["X", "\x03"]);
    leaveToArticle(h);
    expect(h.sent).toEqual(["X", "\x03", "\r"]);
    expect(h.preflight[0]).toMatchObject({
      blocked: false,
      degraded: true,
      // prompt 上有自己的帳號 ⇒ 單則上限算得準（不必再猜 12 字）。
      userId: "testuser",
    });
  });

  test("小天使匿名詢問也算推得了（型別選單被跳過）", () => {
    const h = pre();
    probe(h, "要使用小天使匿名推文嗎？ [Y/n]: ");
    h.settle(PROMPT); // Ctrl-C 非 n ⇒ vans 當成 YES，落到輸入列
    leaveToArticle(h);
    expect(h.preflight[0]).toMatchObject({
      blocked: false,
      angel: true,
      degraded: true,
    });
  });
});

describe("被擋下來", () => {
  test("擋人橫幅 → 只送空白消橫幅（不送 Ctrl-C），回報 PTT 原文", () => {
    const h = pre();
    probe(h, vmsg("抱歉, 禁止推薦"));
    expect(h.sent).toEqual(["X", " "]);
    leaveToArticle(h);
    expect(h.sent).toEqual(["X", " ", "\r"]);
    expect(h.sent).not.toContain("\x03");
    expect(h.session.active).toBe(false);
    expect(h.preflight[0]).toMatchObject({
      blocked: true,
      source: "ptt",
      message: "抱歉, 禁止推薦",
      sent: 0,
      rest: "",
    });
    // 還沒打字，當然不該動剪貼簿——而且從此以後任何情況都不會自動動它。
    expect(h.copied).toEqual([]);
  });

  test.each([
    "抱歉, 禁止推薦",
    "無法推文: 權限不足",
    "未達看板發文限制: 您的文章數不足",
    "本板推文限定管理人員使用。",
    // PTT 哪天新增了我們沒看過的擋人訊息，照樣原文轉達（這正是不 hardcode 的重點）。
    "未來才會有的新規則: 這台 client 沒看過",
  ])("PTT 原文照錄：%s", (msg) => {
    const h = pre();
    probe(h, vmsg(msg));
    leaveToArticle(h);
    expect(h.preflight[0].message).toBe(msg);
    expect(h.preflight[0].source).toBe("ptt");
  });

  test("被擋之後仍然回到原文章並還原閱讀位置", () => {
    const h = pre();
    h.session._readLineIndex = null;
    h.session._view.mainDisplay = { scrollTop: 420 };
    h.session._view.chh = 10;
    probe(h, vmsg("抱歉, 禁止推薦"));
    leaveToArticle(h);
    expect(h.restored).toEqual([42]);
  });
});

describe("冷卻不算不能推", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("消掉橫幅、照常開輸入框，並把秒數帶回去", () => {
    const h = pre();
    probe(h, vmsg("本板禁止快速連續推文，請再等 30 秒"));
    expect(h.sent).toEqual(["X", " "]);
    leaveToArticle(h);
    expect(h.preflight[0]).toMatchObject({
      blocked: false,
      cooldownSec: 30,
      cooldownMessage: "本板禁止快速連續推文，請再等 30 秒",
    });
  });

  test("探路階段不倒數（打字的時間通常早就超過那幾秒）", () => {
    const h = pre();
    probe(h, vmsg("本板禁止快速連續推文，請再等 30 秒"));
    leaveToArticle(h);
    const before = h.sent.length;
    vi.advanceTimersByTime(60000);
    expect(h.sent).toHaveLength(before);
    expect(h.session.active).toBe(false);
  });
});

describe("探路失敗", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("X 沒有回應 → 一個收尾鍵都不送（未知畫面一律停手）", () => {
    const h = pre();
    h.session.startPreflight({});
    vi.advanceTimersByTime(20000);
    expect(h.sent).toEqual(["X"]);
    expect(h.session.active).toBe(false);
    expect(h.preflight[0]).toMatchObject({ blocked: true, source: "client" });
  });

  test("queue 被別人 flush → 釋放 active，不留下 armed", () => {
    const h = pre();
    h.session.startPreflight({});
    h.queue.flush();
    expect(h.session.active).toBe(false);
    expect(h.session.busy).toBe(false);
    expect(h.preflight[0]).toMatchObject({ blocked: true, source: "client" });
  });

  test("探路途中取消 → 走同一個收尾迴圈", () => {
    const h = pre();
    probe(h, TYPE_MENU);
    h.session.cancel();
    expect(h.sent[h.sent.length - 1]).toBe("\x03");
    h.settle(ARTICLE_FOOTER);
    expect(h.session.active).toBe(false);
    expect(h.preflight[0]).toMatchObject({ blocked: true, source: "client" });
  });
});

describe("採樣的所有權（ORDER INVARIANT）", () => {
  test("閱讀位置是在 _enterFunctionMode() 把 scrollTop 歸零**之前**採的", () => {
    const h = pre();
    h.session._view.mainDisplay = { scrollTop: 420 };
    h.session._view.chh = 10;
    // 真的 _enterFunctionMode 結尾會同步 redraw ⇒ mainDisplay.scrollTop = 0。
    h.session._core.easyReading._enterFunctionMode = () => {
      h.session._view.mainDisplay.scrollTop = 0;
    };
    probe(h, TYPE_MENU);
    h.settle(PROMPT);
    leaveToArticle(h);
    expect(h.session._armed.readLineIndex).toBe(42);
  });

  test("探路採到的錨點就是原篇，start() 不重採", () => {
    const h = pre();
    probe(h, TYPE_MENU);
    h.settle(PROMPT);
    leaveToArticle(h);
    const anchor = h.session._armed.anchor;
    // author 在 long_push_anchor 裡是正規化過的（大小寫不敏感）。
    expect(anchor).toMatchObject({ aid: AID, author: "abcuser" });

    // 送出時畫面早就不是當初那一幀了（已經進過 functionMode）；沿用 armed 的錨點
    // 才不會把污染當成基準。
    h.session.start({ text: "內容", type: "push" });
    expect(h.session._anchor).toBe(anchor);
  });

  test("start() 不再解一次 AID（免費路徑要 pageState 3，那時人可能已在列表）", () => {
    const h = pre();
    probe(h, TYPE_MENU);
    h.settle(PROMPT);
    leaveToArticle(h);
    const before = h.sent.length;
    const spy = vi.spyOn(h.session._core.aidNavigation, "resolvePostAid");
    h.session.start({ text: "內容", type: "push" });
    expect(spy).not.toHaveBeenCalled();
    // 人已經回到文章 ⇒ 直接按 X，不多送任何定位鍵。
    expect(h.sent.slice(before)).toEqual(["X"]);
  });

  test("探路回不到文章時，start() 先送 \\f 看清楚畫面再決定", () => {
    const h = pre();
    probe(h, TYPE_MENU);
    h.settle(PROMPT);
    // 收尾之後停在列表，而且那個 ⏎ 沒把人帶回文章（逾時 ⇒ 放手，不算失敗）。
    vi.useFakeTimers();
    h.settleList([ANCHOR_ROW(1234, true), OTHER_ROW(1235)], 0);
    vi.advanceTimersByTime(20000);
    vi.useRealTimers();
    expect(h.session._armed.landedInArticle).toBe(false);

    const before = h.sent.length;
    h.session.start({ text: "內容", type: "push" });
    // fullRepaint ⇒ 線路上只有 Ctrl-L，一個 X 都沒有。
    expect(h.sent.slice(before)).toEqual(["\f"]);
    h.settleList([ANCHOR_ROW(1234, true), OTHER_ROW(1235)], 0);
    expect(h.sent[h.sent.length - 1]).toBe("X");
  });

  test("disarm 之後 start() 退回自己跑序幕的舊路", () => {
    const h = pre();
    probe(h, TYPE_MENU);
    h.settle(PROMPT);
    leaveToArticle(h);
    h.session.disarm();
    expect(h.session.busy).toBe(false);

    const spy = vi.spyOn(h.session._core.aidNavigation, "resolvePostAid");
    h.session.start({ text: "內容", type: "push" });
    expect(spy).toHaveBeenCalled();
  });
});

describe("守門與旗標", () => {
  test("不在文章裡就不探路（列表按 X 推的是游標所指的文章，錨點取不到）", () => {
    const h = pre({ pageState: 2 });
    expect(h.session.startPreflight({})).toBe(false);
    expect(h.sent).toEqual([]);
  });

  test("已經在跑的時候不重複啟動", () => {
    const h = pre();
    h.session.startPreflight({});
    expect(h.session.startPreflight({})).toBe(false);
    expect(h.sent).toEqual(["X"]);
  });

  test("armed 期間 active 是 false（使用者正在打字，不可以吞他的鍵）但 busy 是 true", () => {
    const h = pre();
    probe(h, TYPE_MENU);
    expect(h.session.opHint).toContain("確認");
    h.settle(PROMPT);
    leaveToArticle(h);
    expect(h.session.active).toBe(false);
    expect(h.session.busy).toBe(true);
  });
});
