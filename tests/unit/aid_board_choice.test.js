// 沒寫看板的 #AID → 先問看板（src/js/aid_board_choice.js、App.onAidClick）。
//
// 症狀：推文裡貼別板的 `#1abcdEFG`（沒有 (Board) 後綴）點下去，舊版一律在目前文章的
// 看板找 ⇒ 必定「找不到原文章」。現在要先問；帶了看板的連結維持一鍵直跳。
import {
  needsAidBoardChoice,
  currentBoardOption,
} from "../../src/js/aid_board_choice";
// 檔案層級 import（理由見 bell.test.js）。
import { App } from "../../src/js/pttchrome";

describe("needsAidBoardChoice", () => {
  test("沒有看板 ＋ 好讀開著 ＋ 沒有導航在跑 ⇒ 問", () => {
    expect(needsAidBoardChoice({ explicitBoard: null, startedEasyReading: true })).toBe(true);
    expect(needsAidBoardChoice({ explicitBoard: "", startedEasyReading: true })).toBe(true);
  });
  test("連結自己帶看板 ⇒ 不問（一鍵直跳）", () => {
    expect(needsAidBoardChoice({ explicitBoard: "Browsers", startedEasyReading: true })).toBe(false);
  });
  test("跳轉反正不會發生（導航中／好讀沒開）⇒ 不問", () => {
    expect(
      needsAidBoardChoice({ explicitBoard: null, navigating: true, startedEasyReading: true }),
    ).toBe(false);
    expect(needsAidBoardChoice({ explicitBoard: null, startedEasyReading: false })).toBe(false);
    expect(needsAidBoardChoice(null)).toBe(false);
  });
});

test("currentBoardOption：只有合法板名才能選「本版」", () => {
  expect(currentBoardOption("Gossiping")).toBe("Gossiping");
  expect(currentBoardOption(null)).toBe(null);
  expect(currentBoardOption("")).toBe(null);
  expect(currentBoardOption("不明")).toBe(null);
});

describe("App.onAidClick", () => {
  const makeApp = (over = {}) => ({
    view: { _articleBoard: "ask" },
    buf: { startedEasyReading: true },
    aidNavigation: { active: false, start: vi.fn() },
    openAidBoardChoice: vi.fn(() => true),
    ...over,
  });

  test("沒有看板 ⇒ 開選擇彈窗，不送任何跳轉", () => {
    const app = makeApp();
    App.prototype.onAidClick.call(app, "1abcdEFG", null);
    expect(app.openAidBoardChoice).toHaveBeenCalledWith("1abcdEFG", "ask");
    expect(app.aidNavigation.start).not.toHaveBeenCalled();
  });

  test("連結帶看板 ⇒ 直接跳那個看板，不問", () => {
    const app = makeApp();
    App.prototype.onAidClick.call(app, "1gU3wwNZ", "Browsers");
    expect(app.openAidBoardChoice).not.toHaveBeenCalled();
    expect(app.aidNavigation.start).toHaveBeenCalledWith("1gU3wwNZ", "Browsers");
  });

  test("彈窗沒接手（ContextMenu 未 mount 的 noop）⇒ 照舊在本版跳", () => {
    const app = makeApp({ openAidBoardChoice: () => undefined });
    App.prototype.onAidClick.call(app, "1abcdEFG", null);
    expect(app.aidNavigation.start).toHaveBeenCalledWith("1abcdEFG", "ask");
  });

  test("App.prototype 預設 noop（合約：回 falsy）", () => {
    expect(App.prototype.openAidBoardChoice()).toBeFalsy();
  });
});
