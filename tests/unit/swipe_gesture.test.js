// 觸控板兩指水平滑動的辨識器（src/js/swipe_gesture.js）。
//
// 這支鎖的是「一次手勢＝一個方向鍵」這件事本身：macOS 的慣性滾動在手指離開後
// 還會送幾十個 wheel 事件，少了 idle 鎖就會連送好幾個左方向鍵（在文章裡＝一路
// 退到主功能表）。對角線滑動則不可以既翻頁又退出。
import { SwipeXDetector, isHorizontalWheel } from "../../src/js/swipe_gesture";

// deltaMode 0 = px（觸控板一律是這個）。
const ev = (deltaX, deltaY, timeStamp, deltaMode = 0) => ({
  deltaX,
  deltaY,
  deltaMode,
  timeStamp,
});

// 把一串同方向的事件餵進去，回傳每一次的結果。
const feedAll = (d, events) => events.map((e) => d.feed(e));

describe("水平主導", () => {
  test("純水平滑動累積到閾值就觸發", () => {
    const d = new SwipeXDetector({ thresholdPx: 100 });
    expect(d.feed(ev(-60, 0, 0))).toBeNull();
    expect(d.feed(ev(-60, 0, 16))).toBe("back");
  });

  test("反方向＝forward（開文章）", () => {
    const d = new SwipeXDetector({ thresholdPx: 100 });
    d.feed(ev(60, 0, 0));
    expect(d.feed(ev(60, 0, 16))).toBe("forward");
  });

  test("對角線（垂直為主）永不觸發 —— 捲文章時不可以順便跳出去", () => {
    const d = new SwipeXDetector({ thresholdPx: 100 });
    const out = feedAll(
      d,
      [0, 1, 2, 3, 4, 5].map((i) => ev(-40, -80, i * 16)),
    );
    expect(out.every((r) => r === null)).toBe(true);
  });

  test("垂直分量夠大就把累積歸零（先水平、後轉垂直不可以補刀成手勢）", () => {
    const d = new SwipeXDetector({ thresholdPx: 100 });
    d.feed(ev(-90, 0, 0));
    expect(d.feed(ev(-10, -200, 16))).toBeNull();
    expect(d.feed(ev(-90, 0, 32))).toBeNull(); // 重新從 -90 開始算
  });

  test("純垂直（滾輪）完全不干擾", () => {
    const d = new SwipeXDetector({ thresholdPx: 100 });
    expect(d.feed(ev(0, -120, 0))).toBeNull();
    expect(d.feed(ev(0, -120, 16))).toBeNull();
  });
});

describe("慣性（momentum）", () => {
  test("一次滑動只觸發一次，之後的慣性事件全部吞掉", () => {
    const d = new SwipeXDetector({ thresholdPx: 100, idleMs: 200 });
    const out = feedAll(
      d,
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ev(-40, 0, i * 16)),
    );
    expect(out.filter((r) => r === "back")).toHaveLength(1);
  });

  test("靜止超過 idleMs 之後才允許下一次", () => {
    const d = new SwipeXDetector({ thresholdPx: 100, idleMs: 200 });
    d.feed(ev(-60, 0, 0));
    expect(d.feed(ev(-60, 0, 16))).toBe("back");
    // 慣性尾巴：鎖住
    expect(d.feed(ev(-60, 0, 32))).toBeNull();
    // 手放開、隔了 500ms 再滑一次
    expect(d.feed(ev(-60, 0, 532))).toBeNull();
    expect(d.feed(ev(-60, 0, 548))).toBe("back");
  });
});

describe("方向翻轉", () => {
  test("翻轉時歸零重算，不會被前一段抵消掉", () => {
    const d = new SwipeXDetector({ thresholdPx: 100 });
    d.feed(ev(-90, 0, 0)); // 差一點觸發
    expect(d.feed(ev(60, 0, 16))).toBeNull(); // 翻轉 ⇒ 從 +60 開始，不是 -30
    expect(d.feed(ev(60, 0, 32))).toBe("forward");
  });
});

describe("deltaMode 換算", () => {
  test("行（deltaMode 1）要換算成 px 才判閾值", () => {
    const d = new SwipeXDetector({ thresholdPx: 100 });
    // 3 行 × 16px = 48px，還不夠
    expect(d.feed(ev(-3, 0, 0, 1))).toBeNull();
    expect(d.feed(ev(-4, 0, 16, 1))).toBe("back"); // 累積 112px
  });

  test("頁（deltaMode 2）一格就過閾值", () => {
    const d = new SwipeXDetector({ thresholdPx: 100 });
    expect(d.feed(ev(-1, 0, 0, 2))).toBe("back");
  });
});

describe("isHorizontalWheel", () => {
  test("水平主導才是 true", () => {
    expect(isHorizontalWheel(ev(-120, 0, 0))).toBe(true);
    expect(isHorizontalWheel(ev(-120, -10, 0))).toBe(true);
  });

  test("垂直與斜向都是 false（滾輪翻頁那條路不可以被搶走）", () => {
    expect(isHorizontalWheel(ev(0, -120, 0))).toBe(false);
    expect(isHorizontalWheel(ev(-40, -80, 0))).toBe(false);
    expect(isHorizontalWheel(ev(0, 0, 0))).toBe(false);
  });

  test("deltaMode 換算後才比大小", () => {
    // 1 行水平 vs 20px 垂直：換算後是 16px vs 20px ⇒ 不是水平主導
    expect(isHorizontalWheel({ deltaX: -1, deltaY: -20, deltaMode: 1 })).toBe(false);
  });
});
