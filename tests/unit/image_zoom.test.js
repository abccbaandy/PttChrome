// 整頁圖片倍率的純邏輯（src/js/image_zoom.js）。
import {
  IMAGE_ZOOM_STEPS,
  stepImageZoom,
  isMinImageZoom,
  isMaxImageZoom,
  imageSizeMode,
  zoomFromSizeMode,
  formatZoomLabel,
} from "../../src/js/image_zoom";

describe("stepImageZoom", () => {
  test("從 100% 起一格一格放大／縮小", () => {
    expect(stepImageZoom(1, 1)).toBe(1.25);
    expect(stepImageZoom(1.25, 1)).toBe(1.5);
    expect(stepImageZoom(1, -1)).toBe(0.75);
  });

  test("到端點就停住", () => {
    const max = IMAGE_ZOOM_STEPS[IMAGE_ZOOM_STEPS.length - 1];
    expect(stepImageZoom(max, 1)).toBe(max);
    expect(stepImageZoom(IMAGE_ZOOM_STEPS[0], -1)).toBe(IMAGE_ZOOM_STEPS[0]);
    expect(isMaxImageZoom(max)).toBe(true);
    expect(isMinImageZoom(IMAGE_ZOOM_STEPS[0])).toBe(true);
    expect(isMinImageZoom(1)).toBe(false);
    expect(isMaxImageZoom(1)).toBe(false);
  });

  test("dir 0 ＝ 回 100%", () => {
    expect(stepImageZoom(2.5, 0)).toBe(1);
  });

  test("非階梯值先吸附最近一格再移動", () => {
    expect(stepImageZoom(1.3, 1)).toBe(1.5);
    expect(stepImageZoom(1.3, -1)).toBe(1);
    expect(stepImageZoom(NaN, 1)).toBe(1.25);
  });
});

describe("sizeMode 字串", () => {
  test("放大態優先於倍率", () => {
    expect(imageSizeMode(true, 2)).toBe("enlarged");
    expect(zoomFromSizeMode("enlarged")).toBeNull();
  });

  test("100% 維持舊鍵 normal（既有的分模式高度記錄不失效）", () => {
    expect(imageSizeMode(false, 1)).toBe("normal");
    expect(zoomFromSizeMode("normal")).toBe(1);
  });

  test("其他倍率各自一個鍵，可往返", () => {
    for (const z of IMAGE_ZOOM_STEPS) {
      expect(zoomFromSizeMode(imageSizeMode(false, z))).toBe(z);
    }
    expect(imageSizeMode(false, 1.25)).not.toBe(imageSizeMode(false, 1.5));
  });

  test("標籤", () => {
    expect(formatZoomLabel(1.25)).toBe("125%");
    expect(formatZoomLabel(0.5)).toBe("50%");
  });
});
