// wheel 事件的水平／垂直判斷（src/js/swipe_gesture.js，純函式）。
//
// **手勢辨識器已於 2026-09 移除**：觸控板的返回手勢交給瀏覽器原生跑，由
// history sentinel 接住（見 tests/unit/history_back_guard.test.js）。這裡剩下的
// 是滾輪翻頁的守門——純水平的 wheel 不可以被算成「往下」而偷送 PageDown。
import { isHorizontalWheel } from "../../src/js/swipe_gesture";

// deltaMode 0 = px（觸控板一律是這個）。
const ev = (deltaX, deltaY, timeStamp, deltaMode = 0) => ({
  deltaX,
  deltaY,
  deltaMode,
  timeStamp,
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
