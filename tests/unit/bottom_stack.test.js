// 底部堆疊的共用量測（架構 review A8 第一步，src/js/bottom_stack.js）。
// 浮層的組合（推文列、下一篇卡片、導覽軸）各自的測試照舊守位置；這裡守共用的那一段：
// footer 顯示中取上緣、收起（display:none）就不算、量不到版面回 null。
import { measureContentEdge, contentBottomOf, stackFloorOf } from "../../src/js/bottom_stack";

const rect = (top, bottom) => ({ top, bottom, left: 0, right: 800, width: 800, height: bottom - top });
const el = (r, display = "block") => ({ getBoundingClientRect: () => r, _display: display });
const win = { getComputedStyle: (node) => ({ display: node._display }) };

describe("measureContentEdge", () => {
  test("footer 顯示中 ⇒ 帶它的上緣", () => {
    const view = { mainDisplay: el(rect(0, 600)), lastRowDiv: el(rect(570, 600)) };
    expect(measureContentEdge(view, win)).toEqual({ mainRect: rect(0, 600), footerTop: 570 });
  });

  test("footer 收起（手機換行版面）⇒ footerTop 是 null", () => {
    const view = { mainDisplay: el(rect(0, 600)), lastRowDiv: el(rect(0, 0), "none") };
    expect(measureContentEdge(view, win).footerTop).toBe(null);
  });

  test("沒有 footer ⇒ footerTop 是 null", () => {
    expect(measureContentEdge({ mainDisplay: el(rect(0, 600)) }, win).footerTop).toBe(null);
  });

  test("量不到版面 ⇒ null", () => {
    expect(measureContentEdge(null, win)).toBe(null);
    expect(measureContentEdge({}, win)).toBe(null);
    expect(measureContentEdge({ mainDisplay: el(rect(0, 600)) }, null)).toBe(null);
  });
});

describe("contentBottomOf", () => {
  test("footer 在 .main 下緣之上 ⇒ 取 footer 上緣", () => {
    expect(contentBottomOf({ mainRect: rect(0, 600), footerTop: 570 })).toBe(570);
  });

  test("footer 不在（null／undefined）⇒ .main 下緣", () => {
    expect(contentBottomOf({ mainRect: rect(0, 600), footerTop: null })).toBe(600);
    expect(contentBottomOf({ mainRect: rect(0, 600) })).toBe(600);
  });

  test("footer 量到比 .main 還低（被捲出去）⇒ 仍以 .main 下緣為準", () => {
    expect(contentBottomOf({ mainRect: rect(0, 600), footerTop: 650 })).toBe(600);
  });
});

describe("stackFloorOf", () => {
  // offline-mobile 實測：.main 下緣 346.7、視窗高 390、底部導覽列 48 ⇒ .main 伸進導覽列 4.7 px。
  test("手機：.main 伸進底部導覽列 ⇒ 地板是導覽列上緣", () => {
    expect(stackFloorOf({ mainRect: rect(53, 346.7), footerTop: null, innerHeight: 390, keyboardInset: 48 })).toBe(342);
  });
  test("桌機：footer 在 ⇒ 地板是 footer 上緣", () => {
    expect(stackFloorOf({ mainRect: rect(0, 730), footerTop: 690, innerHeight: 720, keyboardInset: 0 })).toBe(690);
  });
  test("沒給視窗高（純幾何）⇒ 只看內容下緣", () => {
    expect(stackFloorOf({ mainRect: rect(0, 600), footerTop: null })).toBe(600);
  });
});
