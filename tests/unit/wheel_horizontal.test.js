// App.mouse_scroll 的水平事件處理（src/js/pttchrome.jsx）。
//
// 回歸鎖（2026-09 修）：方向判斷是 `var up = e.deltaY < 0 || e.wheelDelta > 0`，
// 而 Mac 觸控板純水平滑動送的是 deltaY === 0 ⇒ up === false ⇒ 原生 24 列畫面
// setBBSCmd('doPageDown')。也就是說左滑一次會**同時**「瀏覽器回上一頁」＋「偷送
// 一個 PageDown 給 PTT」。斜向滑動同理誤翻頁。
//
// 另一半是新功能：水平手勢 → 左右方向鍵（辨識在 swipe_gesture.js）。
import { App } from "../../src/js/pttchrome";
import { SwipeXDetector } from "../../src/js/swipe_gesture";

function makeApp({
  swipeX = 1,
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
    swipeX,
    backButton: 1,
  }));
  app.swipeX = new SwipeXDetector({ thresholdPx: 100 });
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
    const app = makeApp({ swipeX: 0 });
    app.mouse_scroll(wheelEvent(-120, 0));
    expect(app.setBBSCmd).not.toHaveBeenCalled();
  });

  test("水平主導的斜滑也不翻頁", () => {
    const app = makeApp({ swipeX: 0 });
    app.mouse_scroll(wheelEvent(-120, 10));
    expect(app.setBBSCmd).not.toHaveBeenCalled();
  });

  test("垂直主導的斜滑照舊翻頁（滾輪本來的行為不可以被搶走）", () => {
    const app = makeApp({ swipeX: 0 });
    app.mouse_scroll(wheelEvent(-40, -80));
    expect(app.setBBSCmd).toHaveBeenCalledWith("doPageUp");
  });

  test("純垂直照舊翻頁", () => {
    const app = makeApp({ swipeX: 0 });
    app.mouse_scroll(wheelEvent(0, 120));
    expect(app.setBBSCmd).toHaveBeenCalledWith("doPageDown");
  });
});

describe("水平手勢 → 方向鍵", () => {
  test("累積到閾值送左方向鍵（退出）", () => {
    const app = makeApp();
    app.mouse_scroll(wheelEvent(-60, 0, 0));
    expect(app.navKeys).toHaveLength(0);
    app.mouse_scroll(wheelEvent(-60, 0, 16));
    expect(app.navKeys).toEqual(["ArrowLeft"]);
    expect(app.setBBSCmd).not.toHaveBeenCalled();
  });

  test("反方向送右方向鍵（開文章）", () => {
    const app = makeApp();
    app.mouse_scroll(wheelEvent(60, 0, 0));
    app.mouse_scroll(wheelEvent(60, 0, 16));
    expect(app.navKeys).toEqual(["ArrowRight"]);
  });

  test("慣性事件不會連送好幾個方向鍵", () => {
    const app = makeApp();
    for (let i = 0; i < 12; ++i) app.mouse_scroll(wheelEvent(-40, 0, i * 16));
    expect(app.navKeys).toEqual(["ArrowLeft"]);
  });

  test("手勢 pref 關掉就完全不送（但水平事件仍不得翻頁）", () => {
    const app = makeApp({ swipeX: 0 });
    for (let i = 0; i < 12; ++i) app.mouse_scroll(wheelEvent(-40, 0, i * 16));
    expect(app.navKeys).toHaveLength(0);
    expect(app.setBBSCmd).not.toHaveBeenCalled();
  });

  test("滾輪翻頁關掉時手勢照樣有效（兩個是獨立的 pref）", () => {
    const app = makeApp({ wheel: false });
    app.mouse_scroll(wheelEvent(-60, 0, 0));
    app.mouse_scroll(wheelEvent(-60, 0, 16));
    expect(app.navKeys).toEqual(["ArrowLeft"]);
  });

  test("文章好讀模式（交給瀏覽器捲動的那條路）也收得到手勢", () => {
    const app = makeApp({ pageState: 3 });
    app.view.useEasyReadingMode = true;
    app.mouse_scroll(wheelEvent(-60, 0, 0));
    app.mouse_scroll(wheelEvent(-60, 0, 16));
    expect(app.navKeys).toEqual(["ArrowLeft"]);
  });

  test("對話框開著時什麼都不做", () => {
    const app = makeApp({ modalShown: true });
    app.mouse_scroll(wheelEvent(-60, 0, 0));
    app.mouse_scroll(wheelEvent(-60, 0, 16));
    expect(app.navKeys).toHaveLength(0);
    expect(app.setBBSCmd).not.toHaveBeenCalled();
  });

  test("AID 跳文在途時不送（序列化操作擁有這條線路）", () => {
    const app = makeApp();
    app.aidNavigation.active = true;
    app.mouse_scroll(wheelEvent(-60, 0, 0));
    app.mouse_scroll(wheelEvent(-60, 0, 16));
    expect(app.navKeys).toHaveLength(0);
  });
});
