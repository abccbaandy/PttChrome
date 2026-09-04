// App.mouse_scroll 的水平事件處理（src/js/pttchrome.jsx）。
//
// 回歸鎖（2026-09 修）：方向判斷是 `var up = e.deltaY < 0 || e.wheelDelta > 0`，
// 而 Mac 觸控板純水平滑動送的是 deltaY === 0 ⇒ up === false ⇒ 原生 24 列畫面
// setBBSCmd('doPageDown')。也就是說左滑一次會**同時**「瀏覽器回上一頁」＋「偷送
// 一個 PageDown 給 PTT」。斜向滑動同理誤翻頁。
//
// 手勢本身**不在這條路上**（2026-09 起交給瀏覽器原生 + history sentinel），所以
// 這支只鎖「水平事件不得變成上下翻頁」。
import { App } from "../../src/js/pttchrome";

function makeApp({
  wheel = true,
  listRenderMode = "native",
  pageState = 2,
  modalShown = false,
} = {}) {
  const app = Object.create(App.prototype);
  app.modalShown = modalShown;
  app.mouseButtons = { syncFromButtons: vi.fn() };
  app.aidNavigation = { active: false };
  app._onUploadLayer = vi.fn(() => false);
  app.mouseGates = vi.fn(() => ({
    wheel,
    wheelSmoothScroll: false,
    backNav: 1,
  }));
  app.buf = { pageState, listRenderMode };
  app.view = { useEasyReadingMode: false };
  app.listSession = null;
  app.CmdHandler = { setAttribute: vi.fn() };
  app.setBBSCmd = vi.fn();
  app.navKeys = [];
  app.sendNavKeyAsUser = vi.fn((k) => (app.navKeys.push(k), true));
  return app;
}

const wheelEvent = (deltaX, deltaY, timeStamp = 0) => ({
  deltaX,
  deltaY,
  deltaMode: 0,
  timeStamp,
  buttons: 0,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
});

describe("水平 wheel 不可以變成上下翻頁", () => {
  test("純水平滑動不送 PageDown（原生列表）", () => {
    const app = makeApp();
    app.mouse_scroll(wheelEvent(-120, 0));
    expect(app.setBBSCmd).not.toHaveBeenCalled();
  });

  test("水平主導的斜滑也不翻頁", () => {
    const app = makeApp();
    app.mouse_scroll(wheelEvent(-120, 10));
    expect(app.setBBSCmd).not.toHaveBeenCalled();
  });

  test("垂直主導的斜滑照舊翻頁（滾輪本來的行為不可以被搶走）", () => {
    const app = makeApp();
    app.mouse_scroll(wheelEvent(-40, -80));
    expect(app.setBBSCmd).toHaveBeenCalledWith("doPageUp");
  });

  test("純垂直照舊翻頁", () => {
    const app = makeApp();
    app.mouse_scroll(wheelEvent(0, 120));
    expect(app.setBBSCmd).toHaveBeenCalledWith("doPageDown");
  });
});

// 2026-09 的行為改變：水平 wheel **完全不送任何鍵**（返回手勢由瀏覽器原生跑，
// history sentinel 接住）。加回 wheel 版辨識就會紅。
test("水平 wheel 不再送出任何方向鍵", () => {
  const app = makeApp();
  for (let i = 0; i < 12; ++i) app.mouse_scroll(wheelEvent(-40, 0, i * 16));
  expect(app.navKeys).toHaveLength(0);
  expect(app.setBBSCmd).not.toHaveBeenCalled();
});
