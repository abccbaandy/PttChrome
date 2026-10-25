// @unit-env browser
// 推完文短暫標出自己剛推的那幾則（P42，src/js/just_pushed.js、docs/long-push.md「剛推的那幾則」）。
//
// 鎖的症狀：
//   1. 只標「帳號＝自己、時間落在送出前後的時間窗」的推文，從最下面往上最多 count 則；
//      別人的、舊的、時間對不上的都不標（認不出就什麼都不標）。
//   2. 被合併進同作者推文塊的 ⇒ 標在塊的第一列；黑名單藏起來的不算。
//   3. 畫出來的列帶 class justPushed（CSS 淡出動畫）。
//   4. view：設定後重畫、JUST_PUSHED_MS 後自己清掉再重畫；pref 關、沒有帳號就不設；換文章不標。
//   5. 長推文整段送完才呼叫 view.markJustPushed（帶則數、帳號、開始送出的時間）；取消／失敗不呼叫。
import {
  taipeiMinute,
  justPushedMinutes,
  commentMinute,
  applyJustPushedMark,
  JUST_PUSHED_MS,
} from "../../src/js/just_pushed";
import { annotationsKey } from "../../src/js/screen_annotate_cache";
import { TermView } from "../../src/js/term_view";
import { setupI18n } from "../../src/js/i18n";
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { row, seg } from "./helpers/screen_fixtures";
import {
  harness,
  PROMPT,
  CONFIRM,
  TYPE_MENU,
  ARTICLE_FOOTER,
} from "./helpers/long_push_harness";

// 一則推文的完整往返（同 long_push_flow.test.js）。
const runOne = (h) => {
  h.settle(TYPE_MENU);
  h.settle(PROMPT);
  h.settle(CONFIRM);
  h.settle(ARTICLE_FOOTER);
};

beforeAll(() => setupI18n());
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});

// 2026-10-26 02:47 台北時間 ＝ 10/25 18:47 UTC。
const NOW = Date.UTC(2026, 9, 25, 18, 47, 30);

describe("時間", () => {
  test("taipeiMinute：轉台北時間、月日時分補兩位", () => {
    expect(taipeiMinute(NOW)).toBe("10/26 02:47");
    expect(taipeiMinute(Date.UTC(2026, 0, 4, 16, 5))).toBe("01/05 00:05");
  });

  test("justPushedMinutes：送出前 1 分到現在後 1 分的每一分鐘", () => {
    expect(justPushedMinutes(NOW - 60 * 1000, NOW)).toEqual([
      "10/26 02:45",
      "10/26 02:46",
      "10/26 02:47",
      "10/26 02:48",
    ]);
  });

  test("commentMinute：推文列尾（含 IP）；月份一位數補零；不是推文列尾 ⇒ null", () => {
    expect(commentMinute("推 me: 好                       1.2.3.4 10/26 02:47")).toBe("10/26 02:47");
    expect(commentMinute("推 me: 好                               9/05 12:00 ")).toBe("09/05 12:00");
    expect(commentMinute("內文 10/26 02:47 還有字")).toBeNull();
    expect(commentMinute(undefined)).toBeNull();
  });
});

describe("applyJustPushedMark", () => {
  const MIN = ["10/26 02:46", "10/26 02:47"];
  const jp = (count, userid = "me") => ({ justPushed: { key: "k", userid, count, minutes: MIN } });
  const texts = [
    "推 me: 舊的                                    10/25 20:00",
    "推 other: 別人                                 10/26 02:46",
    "推 me: 一                                      10/26 02:46",
    "推 me: 二                                      10/26 02:47",
    "推 me: 三                                      10/26 02:47",
  ];
  const fresh = () => texts.map((t) => ({ userid: t.slice(2, t.indexOf(":")), type: "推", hidden: false }));
  const marked = (r) => r.map((a, i) => (a && a.justPushed ? i : -1)).filter((i) => i >= 0);

  test("只標自己、時間窗內的；從最下面往上最多 count 則", () => {
    const r = fresh();
    applyJustPushedMark(r, texts, jp(2));
    expect(marked(r)).toEqual([3, 4]);
    const all = fresh();
    applyJustPushedMark(all, texts, jp(9));
    // 舊的那則（時間不對）不標
    expect(marked(all)).toEqual([2, 3, 4]);
  });

  test("帳號不對、時間窗對不上、沒有狀態 ⇒ 都不標", () => {
    for (const e of [jp(3, "nobody"), { justPushed: { key: "k", userid: "me", count: 3, minutes: ["01/01 00:00"] } }, {}, null]) {
      const r = fresh();
      applyJustPushedMark(r, texts, e);
      expect(marked(r)).toEqual([]);
    }
  });

  test("合併進同作者推文塊 ⇒ 標在塊的第一列；黑名單藏起來的不算", () => {
    const r = fresh();
    r[4] = { ...r[4], mergedIntoComment: 2 };
    r[3] = { ...r[3], hidden: true };
    applyJustPushedMark(r, texts, jp(1));
    expect(marked(r)).toEqual([2]);
  });

  test("key 進 annotationsKey（設定、到期都換 key ⇒ 那一幀全量重算）", () => {
    const base = { lines: [], enhance: {} };
    const k0 = annotationsKey(base);
    const k1 = annotationsKey({ ...base, enhance: { justPushed: { key: "a" } } });
    const k2 = annotationsKey({ ...base, enhance: { justPushed: { key: "b" } } });
    expect(new Set([k0, k1, k2]).size).toBe(3);
  });
});

describe("渲染", () => {
  const LINES = [
    row(seg(" 作者  opuser (原PO)                                     看板  Test")),
    row(seg(" 標題  [心得] 測試")),
    row(seg(" 時間  Sat Jun 14 10:00:00 2025")),
    row(seg("內文")),
    row(seg("推 other: 一                                          10/26 02:46")),
    row(seg("推 me: 二                                             10/26 02:47")),
  ];
  const props = (justPushed) => ({
    lines: LINES,
    enableLinkInlinePreview: false,
    enableLinkHoverPreview: false,
    enhance: {
      pageState: 3,
      blacklist: new Set(),
      titleBlacklist: [],
      showFloorNumbers: true,
      highlightAuthor: true,
      articleAuthor: "opuser",
      easyReading: true,
      dropHidden: true,
      justPushed,
    },
  });
  const lit = (m) =>
    [...m.container.querySelectorAll(".justPushed")].map((n) => n.getAttribute("data-pusher"));

  test("剛推的那則帶 class justPushed，別人的不帶；沒有狀態就都不帶", () => {
    expect(lit(mountScreen(props({ key: "k", userid: "me", count: 1, minutes: ["10/26 02:47"] })))).toEqual(["me"]);
    unmountAll();
    expect(lit(mountScreen(props(null)))).toEqual([]);
  });
});

describe("view 狀態", () => {
  const makeView = () => {
    const v = Object.create(TermView.prototype);
    v.markJustPushedEnabled = true;
    v._justPushed = null;
    v._justPushedTimer = null;
    v._selfId = null;
    v._articleInstanceId = 7;
    v.useEasyReadingMode = true;
    v.buf = { pageState: 3 };
    v.redraw = vi.fn();
    return v;
  };

  test("設定 ⇒ 生效、重畫；JUST_PUSHED_MS 後清掉再重畫", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const v = makeView();
    expect(v.markJustPushed({ userid: "Me", count: 2, since: NOW - 30 * 1000 })).toBe(true);
    expect(v.redraw).toHaveBeenCalledTimes(1);
    const e = v.justPushedEnhance();
    expect(e).toMatchObject({ userid: "me", count: 2 });
    expect(e.minutes).toContain("10/26 02:47");
    vi.advanceTimersByTime(JUST_PUSHED_MS);
    expect(v.justPushedEnhance()).toBeNull();
    expect(v.redraw).toHaveBeenCalledTimes(2);
  });

  test("沒給帳號 ⇒ 用選單底列記下的登入者；都沒有、pref 關、0 則 ⇒ 不設", () => {
    const v = makeView();
    v._selfId = "self1";
    expect(v.markJustPushed({ count: 1, since: Date.now() })).toBe(true);
    expect(v.justPushedEnhance().userid).toBe("self1");
    v.clearJustPushed();
    v._selfId = null;
    expect(v.markJustPushed({ count: 1 })).toBe(false);
    v.markJustPushedEnabled = false;
    expect(v.markJustPushed({ userid: "me", count: 1 })).toBe(false);
    v.markJustPushedEnabled = true;
    expect(v.markJustPushed({ userid: "me", count: 0 })).toBe(false);
  });

  test("換文章、離開好讀文章 ⇒ 不標", () => {
    const v = makeView();
    v.markJustPushed({ userid: "me", count: 1 });
    v.buf.pageState = 2;
    expect(v.justPushedEnhance()).toBeNull();
    v.buf.pageState = 3;
    v._articleInstanceId = 8;
    expect(v.justPushedEnhance()).toBeNull();
    v.clearJustPushed();
  });
});

describe("長推文收工", () => {
  const withMark = (h) => {
    const calls = [];
    h.session._view.markJustPushed = (info) => calls.push(info);
    return calls;
  };

  test("整段送完 ⇒ 呼叫一次，帶則數與開始送出的時間", () => {
    const h = harness();
    const calls = withMark(h);
    const before = Date.now();
    h.session.start({ text: "內容", type: "push" });
    runOne(h);
    expect(calls.length).toBe(1);
    expect(calls[0].count).toBe(1);
    expect(calls[0].since).toBeGreaterThanOrEqual(before);
  });

  test("取消 ⇒ 不呼叫", () => {
    const h = harness();
    const calls = withMark(h);
    h.session.start({ text: "內容", type: "push" });
    h.settle(TYPE_MENU);
    h.session.cancel();
    h.settle(PROMPT);
    h.settle(ARTICLE_FOOTER);
    expect(calls).toEqual([]);
  });
});
