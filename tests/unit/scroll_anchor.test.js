// 捲動錨定純邏輯回歸守護。
// 症狀來源：好讀模式捲到文章中段後點某張圖縮小，內容整體變短但 scrollTop 不變
// → 視窗落到文章更後面，被點的圖跑出視野（放大時往前偏，同源）。
import {
  computeAnchoredScrollTop,
  computeCenteredScrollTop,
  offsetTopWithin,
} from "../../src/js/scroll_anchor";

describe("computeAnchoredScrollTop", () => {
  test("縮小、anchor 頂端在視窗內 → 維持頂端間距（症狀守門）", () => {
    // 錨點圖原本在 3000px 處、高 600；視窗頂在 2900（圖頂低於視窗頂 100px）。
    // 縮小後它上面的內容變短，圖移到 1200px 處、高 200。
    const next = computeAnchoredScrollTop({
      topBefore: 3000,
      heightBefore: 600,
      scrollBefore: 2900,
      topAfter: 1200,
      heightAfter: 200,
      maxScroll: 5000,
    });
    // 圖頂仍應在視窗頂下方 100px；未補償的舊行為會停在 2900（差 1700px）。
    expect(next).toBe(1100);
    expect(1200 - next).toBe(100);
  });

  test("放大、anchor 頂端在視窗內 → 維持頂端間距", () => {
    const next = computeAnchoredScrollTop({
      topBefore: 1200,
      heightBefore: 200,
      scrollBefore: 1100,
      topAfter: 3000,
      heightAfter: 600,
      maxScroll: 8000,
    });
    expect(next).toBe(2900);
  });

  test("anchor 頂端已在視窗上方（看大圖中段）→ 依高度比例縮放，圖仍佔視窗頂端", () => {
    // 視窗頂端落在圖內 300/600 = 一半處。縮小後圖高 200 → 應落在 100 處。
    const heightAfter = 200;
    const topAfter = 1200;
    const next = computeAnchoredScrollTop({
      topBefore: 3000,
      heightBefore: 600,
      scrollBefore: 3300,
      topAfter,
      heightAfter,
      maxScroll: 5000,
    });
    expect(next).toBe(1300);
    // 不變式：視窗頂端仍落在圖片範圍內 → 該圖必定可見。
    expect(next).toBeGreaterThanOrEqual(topAfter);
    expect(next).toBeLessThanOrEqual(topAfter + heightAfter);
  });

  test("算出負值 → clamp 到 0", () => {
    const next = computeAnchoredScrollTop({
      topBefore: 3000,
      heightBefore: 600,
      scrollBefore: 2900,
      topAfter: 50,
      heightAfter: 200,
      maxScroll: 5000,
    });
    expect(next).toBe(0);
  });

  test("超過 maxScroll → clamp 到 maxScroll", () => {
    const next = computeAnchoredScrollTop({
      topBefore: 1000,
      heightBefore: 200,
      scrollBefore: 900,
      topAfter: 9000,
      heightAfter: 600,
      maxScroll: 4000,
    });
    expect(next).toBe(4000);
  });

  test("內容比視窗短（maxScroll 為負）→ 0，不寫入負 scrollTop", () => {
    const next = computeAnchoredScrollTop({
      topBefore: 1000,
      heightBefore: 200,
      scrollBefore: 900,
      topAfter: 300,
      heightAfter: 40,
      maxScroll: -120,
    });
    expect(next).toBe(0);
  });

  test("heightBefore 為 0（圖未載入）→ 退回維持固定間距，不除零", () => {
    const next = computeAnchoredScrollTop({
      topBefore: 1000,
      heightBefore: 0,
      scrollBefore: 1500,
      topAfter: 2000,
      heightAfter: 300,
      maxScroll: 9000,
    });
    expect(Number.isFinite(next)).toBe(true);
    expect(next).toBe(2500);
  });
});

// 影片退出全螢幕後的還原（症狀：文章跳到很後面，剛看的影片不見了）。
// 進全螢幕時 <video> 被提到全螢幕層、原位高度塌陷 → scrollTop 被夾到新的
// maxScroll；退出後高度回來但捲動位置回不去。退出當下已無「之前的相對位置」
// 可用（進場時 layout 就變了），故改用可預期的還原：把影片捲回視窗中央。
describe("computeCenteredScrollTop", () => {
  test("影片置中於視窗", () => {
    expect(
      computeCenteredScrollTop({
        top: 3000,
        height: 400,
        viewportHeight: 800,
        maxScroll: 9000,
      }),
    ).toBe(2800);
  });

  test("影片比視窗高 → 對齊影片頂端（不留負間距）", () => {
    expect(
      computeCenteredScrollTop({
        top: 3000,
        height: 1200,
        viewportHeight: 800,
        maxScroll: 9000,
      }),
    ).toBe(3000);
  });

  test("夾在 [0, maxScroll]", () => {
    expect(
      computeCenteredScrollTop({
        top: 100,
        height: 400,
        viewportHeight: 800,
        maxScroll: 9000,
      }),
    ).toBe(0);
    expect(
      computeCenteredScrollTop({
        top: 8000,
        height: 400,
        viewportHeight: 800,
        maxScroll: 5000,
      }),
    ).toBe(5000);
  });

  test("內容比視窗短（maxScroll <= 0）→ 0", () => {
    expect(
      computeCenteredScrollTop({
        top: 300,
        height: 100,
        viewportHeight: 800,
        maxScroll: -50,
      }),
    ).toBe(0);
  });
});

describe("offsetTopWithin", () => {
  // jsdom 不做 layout（offsetTop 恆 0），故偽造 offsetTop/offsetParent 鏈。
  const node = (offsetTop, offsetParent) => {
    const el = document.createElement("div");
    Object.defineProperty(el, "offsetTop", { value: offsetTop });
    Object.defineProperty(el, "offsetParent", { value: offsetParent });
    return el;
  };

  test("ancestor 在 offsetParent 鏈上 → 中間層距離累加", () => {
    const root = node(10, null);
    const container = node(40, root);
    const wrapper = node(100, container);
    const img = node(25, wrapper);
    expect(offsetTopWithin(img, container)).toBe(125);
  });

  test("ancestor 不在鏈上（未設 position，鏈跳過它）→ 相減法仍正確", () => {
    // 真實情境：#mainContainer 未設 position，img 的 offsetParent 鏈直達 body。
    const body = node(0, null);
    const container = node(40, body); // #mainContainer 自身距 body 40
    const img = node(165, body); // img 距 body 165 → 距 container 應為 125
    expect(offsetTopWithin(img, container)).toBe(125);
  });
});
