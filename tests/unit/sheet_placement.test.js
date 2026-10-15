// 手機長按選單的位置（src/js/sheet_placement.js）：像原生浮動選單一樣浮在長按的那一列
// 旁邊，且不蓋住它。
// 實錄 1：長按畫面下方的文章叫「前已讀後未讀」，固定貼底的 sheet 把那一列整個蓋掉，
//         選中文章外框等於沒畫。
// 實錄 2：改成「對象在下半部就貼頂」後，選單跑到畫面最上方，離手指一整個畫面遠。
import {
  floatMenuPlacement,
  menuAnchorRect,
  SHEET_ANCHOR_GAP_PX,
  SHEET_POINT_ANCHOR_PX,
  FLOAT_MENU_MARGIN_PX,
  FLOAT_MENU_WIDTH_PX,
} from "../../src/js/sheet_placement";

const VW = 400;
const VH = 800;
const place = (anchor, vw = VW, vh = VH) =>
  floatMenuPlacement({ anchor, viewportWidth: vw, viewportHeight: vh });

describe("floatMenuPlacement", () => {
  test("REGRESSION：對象在畫面最下方 ⇒ 選單貼在對象正上方往上長，不是跑到畫面頂端", () => {
    const p = place({ top: 740, bottom: 780, x: 100 });
    expect(p.side).toBe("above");
    // 選單下緣（client y）＝ VH - bottom：緊貼對象上緣、留 GAP，不蓋住它
    const menuBottomY = VH - p.bottom;
    expect(menuBottomY).toBe(740 - SHEET_ANCHOR_GAP_PX);
    expect(menuBottomY).toBeLessThanOrEqual(740);
    expect(p.top).toBeNull();
    // 往上長到視窗頂（留 MARGIN）為止
    expect(p.maxHeight).toBe(740 - SHEET_ANCHOR_GAP_PX - FLOAT_MENU_MARGIN_PX);
  });

  test("對象在畫面上半部 ⇒ 選單貼在對象正下方往下長", () => {
    const p = place({ top: 100, bottom: 140, x: 100 });
    expect(p.side).toBe("below");
    expect(p.top).toBe(140 + SHEET_ANCHOR_GAP_PX);
    expect(p.bottom).toBeNull();
    expect(p.maxHeight).toBe(
      VH - 140 - SHEET_ANCHOR_GAP_PX - FLOAT_MENU_MARGIN_PX,
    );
  });

  test("上下空間一樣 ⇒ 往下長", () => {
    expect(place({ top: 380, bottom: 420, x: 0 }).side).toBe("below");
  });

  test("水平：左緣對齊觸點；靠右放不下就往左推，永遠在視窗內", () => {
    const W = Math.min(FLOAT_MENU_WIDTH_PX, VW - 2 * FLOAT_MENU_MARGIN_PX);
    expect(place({ top: 100, bottom: 140, x: 50 })).toMatchObject({
      left: 50,
      width: W,
    });
    const r = place({ top: 100, bottom: 140, x: 390 });
    expect(r.left + r.width).toBe(VW - FLOAT_MENU_MARGIN_PX);
    expect(place({ top: 100, bottom: 140, x: 2 }).left).toBe(
      FLOAT_MENU_MARGIN_PX,
    );
    // 沒有 x ⇒ 靠左
    expect(place({ top: 100, bottom: 140 }).left).toBe(FLOAT_MENU_MARGIN_PX);
  });

  test("窄螢幕：寬度取視窗扣兩側 MARGIN", () => {
    const p = place({ top: 100, bottom: 140, x: 10 }, 200);
    expect(p.width).toBe(200 - 2 * FLOAT_MENU_MARGIN_PX);
    expect(p.left).toBe(FLOAT_MENU_MARGIN_PX);
  });

  test("量不到對象或視窗 ⇒ null（呼叫端退回貼底 sheet）", () => {
    expect(place(null)).toBeNull();
    expect(place({ top: 10, bottom: 20 }, VW, 0)).toBeNull();
    expect(place({ top: 10, bottom: 20 }, 0, VH)).toBeNull();
    expect(floatMenuPlacement()).toBeNull();
  });

  test("對象超出視口（捲到外面）也不會算出負高度或跑出視窗", () => {
    const p = place({ top: 900, bottom: 950, x: 100 });
    expect(p.side).toBe("above");
    expect(VH - p.bottom).toBeLessThanOrEqual(VH);
    expect(p.maxHeight).toBeGreaterThan(0);
    const q = place({ top: -50, bottom: -10, x: 100 });
    expect(q.side).toBe("below");
    expect(q.top).toBeGreaterThanOrEqual(0);
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

  test("帶觸點 x ⇒ 一併記下（選單左緣對齊它）", () => {
    const t = target(el({ top: 600, bottom: 640, height: 40 }));
    expect(menuAnchorRect(t, 620, 123)).toEqual({
      top: 600,
      bottom: 640,
      x: 123,
    });
    expect(menuAnchorRect(target(null), 300, 50)).toEqual({
      top: 300 - SHEET_POINT_ANCHOR_PX,
      bottom: 300 + SHEET_POINT_ANCHOR_PX,
      x: 50,
    });
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
