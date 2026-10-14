// 手機長按選單的位置（src/js/sheet_placement.js）：sheet 不可蓋住長按的那一列。
// 實錄：長按畫面下方的文章叫「前已讀後未讀」，固定貼底的 sheet 把那一列整個蓋掉，
// 選中文章外框等於沒畫。
import {
  sheetPlacement,
  menuAnchorRect,
  SHEET_ANCHOR_GAP_PX,
  SHEET_POINT_ANCHOR_PX,
} from "../../src/js/sheet_placement";

const VH = 800;

describe("sheetPlacement", () => {
  test("對象在畫面下半部 ⇒ 貼頂，最高到對象上緣（不蓋住它）", () => {
    const p = sheetPlacement({
      anchor: { top: 700, bottom: 740 },
      viewportHeight: VH,
    });
    expect(p.position).toBe("top");
    expect(p.maxHeight).toBe(700 - SHEET_ANCHOR_GAP_PX);
    expect(p.maxHeight).toBeLessThanOrEqual(700);
  });

  test("對象在畫面上半部 ⇒ 照舊貼底，最高到對象下緣", () => {
    const p = sheetPlacement({
      anchor: { top: 100, bottom: 140 },
      viewportHeight: VH,
    });
    expect(p.position).toBe("bottom");
    expect(p.maxHeight).toBe(VH - 140 - SHEET_ANCHOR_GAP_PX);
    expect(VH - p.maxHeight).toBeGreaterThanOrEqual(140);
  });

  test("上下空間一樣 ⇒ 貼底（拇指搆得到）", () => {
    const p = sheetPlacement({
      anchor: { top: 380, bottom: 420 },
      viewportHeight: VH,
    });
    expect(p.position).toBe("bottom");
  });

  test("量不到對象 ⇒ 照舊貼底、不限高", () => {
    expect(sheetPlacement({ anchor: null, viewportHeight: VH })).toEqual({
      position: "bottom",
      maxHeight: null,
    });
    expect(
      sheetPlacement({ anchor: { top: 10, bottom: 20 }, viewportHeight: 0 }),
    ).toEqual({
      position: "bottom",
      maxHeight: null,
    });
    expect(sheetPlacement()).toEqual({ position: "bottom", maxHeight: null });
  });

  test("對象超出視口（捲到外面）也不會算出負高度", () => {
    const p = sheetPlacement({
      anchor: { top: 900, bottom: 950 },
      viewportHeight: VH,
    });
    expect(p.position).toBe("top");
    expect(p.maxHeight).toBe(VH - SHEET_ANCHOR_GAP_PX);
    const q = sheetPlacement({
      anchor: { top: -50, bottom: -10 },
      viewportHeight: VH,
    });
    expect(q.position).toBe("bottom");
    expect(q.maxHeight).toBeGreaterThan(0);
  });
});

describe("menuAnchorRect", () => {
  const el = (rect) => ({ getBoundingClientRect: () => rect });
  const target = (found) => ({ closest: vi.fn(() => found) });

  test("長按在文章列／卡片／選單按鈕上 ⇒ 用那一列的矩形", () => {
    const t = target(el({ top: 600, bottom: 640, height: 40 }));
    expect(menuAnchorRect(t, 620)).toEqual({ top: 600, bottom: 640 });
    expect(t.closest).toHaveBeenCalledWith(
      'span[type="bbsrow"], [data-menu-row]',
    );
  });

  test("不在任何一列上 ⇒ 觸點上下各一小段", () => {
    expect(menuAnchorRect(target(null), 300)).toEqual({
      top: 300 - SHEET_POINT_ANCHOR_PX,
      bottom: 300 + SHEET_POINT_ANCHOR_PX,
    });
  });

  test("列是收起的（高 0）⇒ 退回觸點", () => {
    const t = target(el({ top: 0, bottom: 0, height: 0 }));
    expect(menuAnchorRect(t, 500)).toEqual({
      top: 500 - SHEET_POINT_ANCHOR_PX,
      bottom: 500 + SHEET_POINT_ANCHOR_PX,
    });
  });

  test("什麼都量不到 ⇒ null", () => {
    expect(menuAnchorRect(null, undefined)).toBeNull();
  });
});
