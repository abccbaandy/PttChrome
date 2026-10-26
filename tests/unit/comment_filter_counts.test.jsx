// @unit-env browser
// real-input: tests/e2e/offline/comment_filter.offline.spec.js
// 推文篩選切換鈕的則數（P44，docs/comment-filter.md「則數」）。
//
// 鎖的症狀：
//   1. 數的是推文區（過了文末 meta 列）的推文：內文裡引用的推文長相不算；還沒過 meta 列 ⇒ 不標數字。
//   2. 推／噓只數舊格式；全部／原 PO／帳號連新格式一起數；黑名單的人不算。
//   3. 還沒讀到文末（或反向讀取中）⇒「12+」；讀到文末 ⇒「12」。
//   4. 累積頁長出新推文 ⇒ 下一次重數就是新的數；換文章（首列變了）⇒ 從頭數，不會疊上一篇。
//   5. 橫幅每顆鈕後面帶則數，screenSettled 時跟著更新；view 不給則數 ⇒ 只有名稱（舊行為）。
import { chipCountText } from "../../src/js/comment_filter";
import { FilterChipCounter } from "../../src/js/comment_parse";
import { TermView } from "../../src/js/term_view";
import { setupI18n, i18n } from "../../src/js/i18n";
import { render, act, cleanup } from "@testing-library/react";
import { CommentFilterBar } from "../../src/components/CommentFilterBar";

beforeAll(() => setupI18n());
afterEach(() => cleanup());

const ts = (s) => s + "                 06/06 16:11";
const HEAD = " 作者  author1 (某人)                                     看板  Test";
const BODY = [HEAD, "內文", ts("推 quoted: 內文裡引用的推文長相"), "--", "※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 1.2.3.4"];
const COMMENTS = [
  ts("推 aa: 1"),
  ts("噓 bb: 2"),
  ts("→ author1: 3"),
  ts("推 author1: 4"),
  ts("噓 badguy: 5"),
  "[6] cc 新格式 06/14/2025 10:01",
  "│ 新格式內容",
  "[7] author1 新格式 06/14/2025 10:02",
];

const feedAll = (c, lines) => lines.forEach((t) => c.feed(t));

describe("FilterChipCounter", () => {
  test("只數 meta 列之後；推／噓只數舊格式；全部／原 PO／帳號含新格式；黑名單不算", () => {
    const c = new FilterChipCounter(new Set(["badguy"]));
    feedAll(c, BODY);
    expect(c.seen).toBe(true);
    feedAll(c, COMMENTS);
    expect(c.counts("author1", "aa")).toEqual({ all: 6, push: 2, boo: 1, op: 3, user: 1 });
    expect(c.counts(null, null)).toMatchObject({ op: 0, user: 0 });
    expect(c.counts("AUTHOR1", null).op).toBe(3);
  });

  test("還沒過 meta 列 ⇒ seen false（呼叫端不標數字），內文裡的推文長相不算", () => {
    const c = new FilterChipCounter(null);
    feedAll(c, BODY.slice(0, 4));
    expect(c.seen).toBe(false);
    expect(c.counts(null, null).all).toBe(0);
  });

  test("chipCountText：載完「12」、沒載完「12+」", () => {
    expect(chipCountText(12, true)).toBe("12");
    expect(chipCountText(12, false)).toBe("12+");
    expect(chipCountText(0, false)).toBe("0+");
  });
});

describe("view.commentFilterCounts", () => {
  const makeView = (lines) => {
    const v = Object.create(TermView.prototype);
    v._commentFilter = { key: "type:噓", userid: null, op: false, type: "噓", articleId: 3, expanded: [] };
    v._articleInstanceId = 3;
    v._articleAuthor = "author1";
    v.useEasyReadingMode = true;
    v.blacklist = new Set(["badguy"]);
    v.bbscore = { easyReading: { easyReadingReachedPageEnd: false, _reverse: false, _functionMode: false } };
    v.buf = { pageState: 3, cols: 80, pageLines: lines.slice(), getRowText: (r, a, b, ls) => ls[r] };
    return v;
  };

  test("沒讀到文末 ⇒ 不完整；長出新推文 ⇒ 重數；讀到文末 ⇒ 完整；反向讀取中不算完整", () => {
    const v = makeView([...BODY, ...COMMENTS.slice(0, 2)]);
    expect(v.commentFilterCounts()).toEqual({
      counts: { all: 2, push: 1, boo: 1, op: 0, user: 0 },
      complete: false,
    });
    v.buf.pageLines = [...BODY, ...COMMENTS];
    v.bbscore.easyReading.easyReadingReachedPageEnd = true;
    expect(v.commentFilterCounts()).toEqual({
      counts: { all: 6, push: 2, boo: 1, op: 3, user: 0 },
      complete: true,
    });
    v.bbscore.easyReading._reverse = true;
    expect(v.commentFilterCounts().complete).toBe(false);
    expect(v.commentFilterCounts().counts.all).toBe(6);
  });

  test("換文章（首列變了）⇒ 從頭數，不疊上一篇；篩選沒生效 ⇒ null", () => {
    const v = makeView([...BODY, ...COMMENTS]);
    expect(v.commentFilterCounts().counts.all).toBe(6);
    v.buf.pageLines = [" 作者  other (別人)", "※ 發信站: 批踢踢實業坊(ptt.cc)", ts("推 zz: 1")];
    expect(v.commentFilterCounts().counts).toEqual({ all: 1, push: 1, boo: 0, op: 0, user: 0 });
    v._articleInstanceId = 4;
    expect(v.commentFilterCounts()).toBeNull();
  });

  // 同作者同看板的下一篇：首列一字不差、上一篇又比較短 ⇒ 首列與長度都認不出換了文章。
  // 換文章的權威訊號是 _articleInstanceId；症狀：則數疊上上一篇的推文（P46 還會因此判錯哪顆是 0）。
  test("同作者同看板、下一篇較長（首列相同）⇒ 從頭數，不疊上一篇", () => {
    const v = makeView([...BODY, ts("噓 old: 上一篇")]);
    expect(v.commentFilterCounts().counts).toMatchObject({ all: 1, boo: 1 });
    v._articleInstanceId = 4;
    v._commentFilter = { ...v._commentFilter, articleId: 4 };
    v.buf.pageLines = [...BODY, ...COMMENTS.slice(0, 1), ts("推 dd: 新的")];
    expect(v.commentFilterCounts().counts).toMatchObject({ all: 2, push: 2, boo: 0 });
  });

  test("推文區還沒出現（沒過 meta 列）⇒ null", () => {
    const v = makeView(BODY.slice(0, 3));
    expect(v.commentFilterCounts()).toBeNull();
  });

  test("黑名單換了 ⇒ 重數", () => {
    const v = makeView([...BODY, ...COMMENTS]);
    expect(v.commentFilterCounts().counts.boo).toBe(1);
    v.blacklist = new Set();
    expect(v.commentFilterCounts().counts.boo).toBe(2);
  });
});

describe("橫幅", () => {
  const fakeView = (filter, tally) => {
    const buf = new EventTarget();
    return {
      buf,
      tally,
      onCommentFilterChange: (f) => {
        f(filter);
        return () => {};
      },
      articleAuthorId: () => "author1",
      commentFilterCounts() {
        return this.tally;
      },
      clearCommentFilter: vi.fn(),
      setCommentFilter: vi.fn(),
      setCommentTypeFilter: vi.fn(),
    };
  };
  const bar = () => document.getElementById("commentFilterBar");
  const labels = () =>
    Array.from(bar().querySelectorAll("button")).map((b) => b.textContent);

  test("每顆後面帶則數；沒載完標 +；screenSettled 後跟著更新", () => {
    const view = fakeView(
      { type: null, userid: "friend", op: false },
      { counts: { all: 10, push: 6, boo: 2, op: 1, user: 3 }, complete: false },
    );
    render(<CommentFilterBar pttchrome={{ view }} />);
    expect(labels()).toEqual([
      "friend3+",
      i18n("commentFilter_chipAll") + "10+",
      i18n("commentFilter_chipPush") + "6+",
      i18n("commentFilter_chipBoo") + "2+",
      i18n("commentFilter_chipOp") + "1+",
    ]);
    view.tally = { counts: { all: 12, push: 7, boo: 3, op: 1, user: 3 }, complete: true };
    act(() => view.buf.dispatchEvent(new CustomEvent("screenSettled")));
    expect(labels()[1]).toBe(i18n("commentFilter_chipAll") + "12");
    expect(bar().querySelector('[data-filter="boo"] .commentFilterChipCount').textContent).toBe("3");
  });

  // P46：讀到文末還是 0 則的推／噓／原 PO 變淡，點了只閃一句、不切過去（一個 byte 都不送）。
  const chip = (k) => bar().querySelector(`[data-filter="${k}"]`);
  test("讀完 0 則 ⇒ 變淡、點了只閃提示不切；全部／亮著的那顆不算", () => {
    const view = fakeView(
      { type: "噓", userid: null, op: false },
      { counts: { all: 5, push: 5, boo: 0, op: 0, user: 0 }, complete: true },
    );
    view.flashListHint = vi.fn();
    render(<CommentFilterBar pttchrome={{ view }} />);
    expect(chip("op").hasAttribute("data-empty")).toBe(true);
    expect(chip("op").getAttribute("aria-disabled")).toBe("true");
    // 亮著的「噓」就算 0 則也不變淡（目前的篩選）；有則數的不變淡。
    expect(chip("boo").hasAttribute("data-empty")).toBe(false);
    expect(chip("push").hasAttribute("data-empty")).toBe(false);
    expect(chip("all").hasAttribute("data-empty")).toBe(false);
    chip("op").click();
    expect(view.setCommentFilter).not.toHaveBeenCalled();
    expect(view.flashListHint).toHaveBeenCalledWith(i18n("commentFilter_emptyOp"), 1500);
    chip("push").click();
    expect(view.setCommentTypeFilter).toHaveBeenCalledWith("推");
  });

  test("還沒讀完（0+）⇒ 照常能點；「全部」0 則也照常能還原", () => {
    const view = fakeView(
      { type: "推", userid: null, op: false },
      { counts: { all: 0, push: 0, boo: 0, op: 0, user: 0 }, complete: false },
    );
    view.flashListHint = vi.fn();
    render(<CommentFilterBar pttchrome={{ view }} />);
    expect(bar().querySelectorAll("[data-empty]").length).toBe(0);
    chip("boo").click();
    expect(view.setCommentTypeFilter).toHaveBeenCalledWith("噓");
    expect(view.flashListHint).not.toHaveBeenCalled();
    view.tally = { counts: { all: 0, push: 0, boo: 0, op: 0, user: 0 }, complete: true };
    act(() => view.buf.dispatchEvent(new CustomEvent("screenSettled")));
    expect(chip("boo").hasAttribute("data-empty")).toBe(true);
    expect(chip("all").hasAttribute("data-empty")).toBe(false);
    chip("all").click();
    expect(view.clearCommentFilter).toHaveBeenCalled();
  });

  test("view 給不出則數 ⇒ 只有名稱", () => {
    render(<CommentFilterBar pttchrome={{ view: fakeView({ type: "推", userid: null, op: false }, null) }} />);
    expect(bar().querySelector(".commentFilterChipCount")).toBeNull();
  });
});
