// Unit tests for easy_reading's AID-back scroll restore decision
// (nextScrollRestoreStep): where the reading position may be re-applied while
// the returned-to article is still growing page by page.

import {
  nextScrollRestoreStep,
  nextScrollRestoreHold,
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

// 手機換行版面（term_view.reflow）：一列可能折成好幾行，lineIndex*chh 失準 ⇒ 呼叫端
// 改量 srow 節點的頂端（term_view.pageRowTop）傳 targetTop。
describe("換行版面：targetTop（量到的列頂端）取代 lineIndex*chh", () => {
  test("量到的位置優先於算術（換行後同一列比算術位置更低）", () => {
    expect(step({ scrollHeight: 9000, targetTop: 3500 })).toEqual({
      action: "apply",
      scrollTop: 3500
    });
  });

  test("那一列還沒畫出來（null）→ 等，即使算術位置已經捲得到", () => {
    expect(step({ scrollHeight: 9000, targetTop: null }).action).toBe("wait");
  });

  test("全文載完仍量不到（該列被黑名單拿掉之類）→ 夾到底收工", () => {
    expect(step({ scrollHeight: 1000, targetTop: null, reachedPageEnd: true })).toEqual({
      action: "apply",
      scrollTop: 400
    });
  });
});

// 落地後守位（easy_reading._reassertScrollRestore）：版面在落地之後又變了，量到的目標
// 位置跟視窗對不上就拉回。數字取自 offline-mobile 實測的兩種偏移。
describe("落地後守位：nextScrollRestoreHold", () => {
  const hold = over =>
    nextScrollRestoreHold({ targetTop: 0, scrollTop: 0, scrollHeight: 10000, clientHeight: 293, ...over });

  test("目標列的圖載完撐高（39→248px）：anchoring 保住像素位移，比例換算的目標變了 ⇒ 拉回", () => {
    // 落地：列頂 2173、比例 0.927 × 39px ⇒ +36。圖載完列高 248 ⇒ 目標 2173 + 230。
    expect(hold({ scrollTop: 2209, targetTop: 2403 })).toEqual({ action: "apply", scrollTop: 2403 });
  });

  test("強制渲染的鄰塊被收回、內容變短把 scrollTop 夾到底；內容長回來之後拉回", () => {
    // 收短當下：目標 2090 捲不到（max 1858）⇒ 先不動。
    expect(hold({ scrollTop: 1858, targetTop: 2090, scrollHeight: 2151 })).toEqual({ action: "keep" });
    // 又併進幾頁：捲得到了 ⇒ 拉回。
    expect(hold({ scrollTop: 1858, targetTop: 2117, scrollHeight: 2694 })).toEqual({
      action: "apply",
      scrollTop: 2117
    });
  });

  test("已在原位（1px 內，非整數 DPR 的 scrollTop 是小數）⇒ 不動", () => {
    expect(hold({ scrollTop: 2402.4, targetTop: 2403 })).toEqual({ action: "keep" });
  });

  test("目標列量不到（null）⇒ 不動", () => {
    expect(hold({ scrollTop: 500, targetTop: null })).toEqual({ action: "keep" });
  });
});
