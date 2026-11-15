// @unit-env browser
// P90 列表按推文改出推文列：長推文狀態機從列表上的類型選單接手（long_push_session.startFromList）
// 與收起時替使用者取消（dismissListMenu）。harness 與畫面常數同 long_push_flow.test.js。
//
// 守的是會推到別篇、或替使用者按錯鍵的坑：
//   - 送出那一刻畫面已經不是推文列出現時那一幀（選單收了、游標換了一篇）⇒ 一個鍵都不送
//   - 選單正在等 vkey ⇒ 第一個鍵是類型鍵（不是 X，也不帶 Enter）
//   - 第二則起在列表重按 X 前先確認游標還是同一篇，**日期也要對**（同作者同主題的另一篇）
//   - 整段送完停在列表、不按 Enter 開文

import { loadBig5Tables } from "./helpers/load_big5_tables";
import { u2b } from "../../src/js/string_util";
import {
  harness,
  ROWS,
  PROMPT,
  ARROW_PROMPT,
  CONFIRM,
  ANCHOR_ROW,
  OTHER_ROW,
  TYPE_MENU,
} from "./helpers/long_push_harness";
import { listPushTarget, listPushFactsOf, parseListPushMenu } from "../../src/js/list_push";
import { recordFor } from "../../src/js/reading_record";

beforeAll(() => loadBig5Tables());

const NO_BOO_MENU = "您覺得這篇文章 1.值得推薦 3.只加→註解 [1]? ";
// 原篇在第 2 列（0-based 1），游標在它上面。
const PAGE = (cursorOnAnchor = true) => [
  OTHER_ROW(100),
  ANCHOR_ROW(101, cursorOnAnchor),
  OTHER_ROW(102, !cursorOnAnchor),
];

function setup(opts) {
  const h = harness({ pageState: 2, articleRows: [] });
  h.paintListMenu(PAGE(), opts && opts.menu);
  const target = listPushTarget(listPushFactsOf(h.session._termBuf));
  return { h, target };
}

describe("從列表的類型選單接手", () => {
  test("類型鍵（單一 byte）→ 內容 → y，送完停在列表、不開文", () => {
    const { h, target } = setup();
    expect(target).toMatchObject({ author: "abcuser", date: "9/01", num: 101, booAllowed: true });
    expect(h.session.startFromList({ text: "hello", type: "push", target })).toBe(true);
    expect(h.sent).toEqual(["1"]);
    h.settle(PROMPT);
    expect(h.sent).toEqual(["1", u2b("hello") + "\r"]);
    h.settle(CONFIRM);
    expect(h.sent).toEqual(["1", u2b("hello") + "\r", "y\r"]);
    h.settleList(PAGE(), 1);
    expect(h.sent).toHaveLength(3);
    expect(h.session.active).toBe(false);
    expect(h.session.busy).toBe(false);
    expect(h.results).toEqual([]);
  });

  test("噓／→ 送對應的類型鍵；禁噓板選噓不接手", () => {
    const a = setup();
    expect(a.h.session.startFromList({ text: "x", type: "arrow", target: a.target })).toBe(true);
    expect(a.h.sent).toEqual(["3"]);
    const b = setup({ menu: NO_BOO_MENU });
    expect(b.target.booAllowed).toBe(false);
    expect(b.h.session.startFromList({ text: "x", type: "boo", target: b.target })).toBe(false);
    expect(b.h.sent).toEqual([]);
  });

  test("送出那一刻畫面變了（選單收了／游標換篇）⇒ 不接手、一個鍵都不送", () => {
    const { h, target } = setup();
    h.paintListMenu(PAGE(), "");
    expect(h.session.startFromList({ text: "hello", type: "push", target })).toBe(false);
    h.paintListMenu(PAGE(false));
    expect(h.session.startFromList({ text: "hello", type: "push", target })).toBe(false);
    expect(h.sent).toEqual([]);
    expect(h.session.active).toBe(false);
  });

  test("第二則：游標還是同一篇 ⇒ 在列表重按 X（PTT 改成 → 就直接送內容）", () => {
    const { h, target } = setup();
    // 第一則上限 30 byte，內容 40 字 ⇒ 兩則。
    h.session.startFromList({ text: "一二三四五六七八九十一二三四五六七八九十", type: "push", target, maxBytes: 30 });
    h.settle(PROMPT);
    h.settle(CONFIRM);
    h.settleList(PAGE(), 1);
    expect(h.sent[h.sent.length - 1]).toBe("X");
    h.settle(ARROW_PROMPT);
    expect(h.sent[h.sent.length - 1]).toMatch(/\r$/);
    h.settle(CONFIRM);
    h.settleList(PAGE(), 1);
    expect(h.session.active).toBe(false);
    expect(h.results).toEqual([]);
  });

  test("REGRESSION 第二則前同作者同主題、日期不同的另一篇在游標上 ⇒ 不按 X、停手", () => {
    const { h, target } = setup();
    h.session.startFromList({ text: "一二三四五六七八九十一二三四五六七八九十", type: "push", target, maxBytes: 30 });
    h.settle(PROMPT);
    h.settle(CONFIRM);
    const sentBefore = h.sent.length;
    // 原篇被刪、同一人同一串隔天那篇滑到這一列（作者＋主題相同，只有日期不同）。
    const sameButNextDay = ANCHOR_ROW(101, true).replace(" 9/01 ", " 9/02 ");
    h.settleList([OTHER_ROW(100), sameButNextDay, OTHER_ROW(102)], 1);
    expect(h.sent.slice(sentBefore)).not.toContain("X");
    expect(h.session.active).toBe(false);
    expect(h.results).toHaveLength(1);
    expect(h.results[0]).toMatchObject({ blocked: true, sent: 1, fromList: true });
    expect(h.results[0].rest).toBeTruthy();
  });

  test.each([
    ["被水球／訊息蓋住（transient）", "transient"],
    ["看起來像文章", "article"],
  ])("REGRESSION 第二則前落地畫面不是乾淨列表（%s）⇒ 不比對身分就不按 X、停手", (_name, kind) => {
    const { h, target } = setup();
    h.session.startFromList({ text: "一二三四五六七八九十一二三四五六七八九十", type: "push", target, maxBytes: 30 });
    h.settle(PROMPT);
    h.settle(CONFIRM);
    const sentBefore = h.sent.length;
    // 列表流程沒有「人還在文章裡」這回事：認不出是列表就沒有東西能證明游標還在原篇。
    h.settle("", { kind });
    expect(h.sent.slice(sentBefore)).not.toContain("X");
    expect(h.session.active).toBe(false);
    expect(h.results).toHaveLength(1);
    expect(h.results[0]).toMatchObject({ sent: 1, fromList: true });
  });

  test("閱讀紀錄：開頭 begin('list-push')、收尾 end", () => {
    const { h, target } = setup();
    const rr = recordFor(h.core);
    const begin = vi.spyOn(rr, "begin");
    const end = vi.spyOn(rr, "end");
    h.session.startFromList({ text: "hello", type: "push", target });
    expect(begin).toHaveBeenCalledWith("list-push", expect.anything());
    h.settle(PROMPT);
    h.settle(CONFIRM);
    h.settleList(PAGE(), 1);
    expect(end).toHaveBeenCalledWith(expect.objectContaining({ feature: "list-push" }), "done");
  });
});

describe("收起推文列 ⇒ 替使用者取消（dismissListMenu）", () => {
  test("類型選單 Ctrl-C 進內容列、再 Ctrl-C 放棄，不開錯誤框", () => {
    const { h } = setup();
    expect(h.session.dismissListMenu()).toBe(true);
    expect(h.session.active).toBe(true);
    expect(h.sent).toEqual(["\x03"]);
    h.settle(PROMPT);
    expect(h.sent).toEqual(["\x03", "\x03"]);
    h.settleList(PAGE(), 1);
    expect(h.session.active).toBe(false);
    expect(h.results).toEqual([]);
  });

  test("底列已經不是類型選單 ⇒ 不送", () => {
    const { h } = setup();
    h.paintListMenu(PAGE(), PROMPT);
    expect(h.session.dismissListMenu()).toBe(false);
    expect(h.sent).toEqual([]);
  });
});

describe("類型選單要整句對上（parseListPushMenu）", () => {
  test.each([
    ["一般板", TYPE_MENU, true],
    ["禁噓板", NO_BOO_MENU, false],
  ])("%s", (_n, row, boo) => {
    expect(parseListPushMenu(row)).toEqual({ booAllowed: boo });
  });
  test.each([
    ["選項字改版", "您覺得這篇文章 1.推 2.噓 3.→ [1]? "],
    ["預設值不是 1", "您覺得這篇文章 1.值得推薦 2.給它噓聲 3.只加→註解 [3]? "],
    ["多一個選項", "您覺得這篇文章 1.值得推薦 2.給它噓聲 3.只加→註解 4.其他 [1]? "],
    ["前面有字", "  您覺得這篇文章 1.值得推薦 2.給它噓聲 3.只加→註解 [1]? "],
    ["半繪", "您覺得這篇文章 1.值得推薦 2.給它噓聲"],
  ])("%s → 不認", (_n, row) => {
    expect(parseListPushMenu(row)).toBeNull();
  });
  test("ROWS 常數一致（harness 是 24 列）", () => {
    expect(ROWS).toBe(24);
  });
});

// P91：90 秒內再推、或推自己的文章，PTT 不給類型選單、直接給 → 輸入列（bbs.c#comment）。
describe("從列表上只有 → 的輸入列接手（P91）", () => {
  const TOO_CLOSE = "時間太近, 使用 → 加註方式";
  const OWNER = "作者本人, 使用 → 加註方式";
  function setupArrow(notice = TOO_CLOSE, prompt = ARROW_PROMPT) {
    const h = harness({ pageState: 2, articleRows: [] });
    h.paintListMenu(PAGE(), prompt, notice);
    const target = listPushTarget(listPushFactsOf(h.session._termBuf));
    return { h, target };
  }

  test.each([["時間太近", TOO_CLOSE], ["作者本人", OWNER]])("%s ⇒ 認得出、只能 →，帶 PTT 原話", (_n, notice) => {
    const { target } = setupArrow(notice);
    expect(target).toMatchObject({ author: "abcuser", num: 101, arrowOnly: true, booAllowed: false, notice });
  });

  test("不送類型鍵：第一個鍵就是內容 → y，送完停在列表", () => {
    const { h, target } = setupArrow();
    expect(h.session.startFromList({ text: "hello", type: "arrow", target })).toBe(true);
    expect(h.sent).toEqual([u2b("hello") + "\r"]);
    h.settle(CONFIRM);
    expect(h.sent).toEqual([u2b("hello") + "\r", "y\r"]);
    h.settleList(PAGE(), 1);
    expect(h.session.active).toBe(false);
    expect(h.results).toEqual([]);
  });

  test("要推／噓 ⇒ 不接手（PTT 這時只收 →）", () => {
    const { h, target } = setupArrow();
    expect(h.session.startFromList({ text: "x", type: "push", target })).toBe(false);
    expect(h.session.startFromList({ text: "x", type: "boo", target })).toBe(false);
    expect(h.sent).toEqual([]);
  });

  // 推文列出現前使用者已經在原生輸入列打了字：接手會把兩段字接在一起送出。
  test("輸入列已經有字 ⇒ 認不出（照原生）", () => {
    const { target } = setupArrow(TOO_CLOSE, ARROW_PROMPT + "abc");
    expect(target).toBeNull();
  });

  test("第二則 90 秒內：重按 X 又直接給 → 輸入列 ⇒ 不送類型鍵、直接送內容", () => {
    const { h, target } = setupArrow();
    h.session.startFromList({ text: "一二三四五六七八九十一二三四五六七八九十", type: "arrow", target, maxBytes: 30 });
    h.settle(CONFIRM);
    h.settleList(PAGE(), 1);
    expect(h.sent[h.sent.length - 1]).toBe("X");
    h.settle(ARROW_PROMPT);
    expect(h.sent[h.sent.length - 1]).toMatch(/\r$/);
    expect(h.sent).not.toContain("3");
    h.settle(CONFIRM);
    h.settleList(PAGE(), 1);
    expect(h.session.active).toBe(false);
    expect(h.results).toEqual([]);
  });

  test("第二則過了 90 秒、PTT 改給類型選單 ⇒ 選 →（不是推）", () => {
    const { h, target } = setupArrow();
    h.session.startFromList({ text: "一二三四五六七八九十一二三四五六七八九十", type: "arrow", target, maxBytes: 30 });
    h.settle(CONFIRM);
    h.settleList(PAGE(), 1);
    expect(h.sent[h.sent.length - 1]).toBe("X");
    h.settle(TYPE_MENU);
    expect(h.sent[h.sent.length - 1]).toBe("3");
  });

  test("收起 ⇒ dismissListMenu 照樣替你取消", () => {
    const { h } = setupArrow();
    expect(h.session.dismissListMenu()).toBe(true);
    expect(h.sent).toHaveLength(1);
  });
});
