// Unit tests for easy_reading's AID-back scroll restore decision
// (nextScrollRestoreStep): where the reading position may be re-applied while
// the returned-to article is still growing page by page.

import {
  nextScrollRestoreStep,
  MAX_SCROLL_RESTORE_TRIES
} from "../../src/js/easy_reading";

const step = over =>
  nextScrollRestoreStep({
    lineIndex: 100,
    tries: 1,
    chh: 20, // 目標 = 2000px
    scrollHeight: 0,
    clientHeight: 600,
    reachedPageEnd: false,
    ...over
  });

test("文章還沒長到那個位置 → 等下一頁併進來", () => {
  expect(step({ scrollHeight: 1200 }).action).toBe("wait");
});

test("長度夠了就套用，位置＝行索引 × 行高", () => {
  expect(step({ scrollHeight: 5000 })).toEqual({
    action: "apply",
    scrollTop: 2000
  });
});

test("剛好可捲到目標（scrollHeight - clientHeight == target）也算數", () => {
  expect(step({ scrollHeight: 2600 })).toEqual({
    action: "apply",
    scrollTop: 2000
  });
});

test("全文載完卻仍不夠高（改過視窗/文章變短）→ 夾到底收工，不空等", () => {
  expect(step({ scrollHeight: 1000, reachedPageEnd: true })).toEqual({
    action: "apply",
    scrollTop: 400
  });
});

test("全文載完且完全不需捲動 → scrollTop 0，不出現負值", () => {
  expect(step({ scrollHeight: 300, reachedPageEnd: true })).toEqual({
    action: "apply",
    scrollTop: 0
  });
});

test("次數用盡 → 放棄（自動翻頁卡住時不無限掛著）", () => {
  expect(step({ tries: MAX_SCROLL_RESTORE_TRIES + 1 }).action).toBe("giveup");
});
