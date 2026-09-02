// 手勢／瀏覽器返回鍵送出方向鍵之前的守門（src/js/nav_key_gate.js）。
//
// 這條路不像滑鼠點擊有 mouse_regions 的區域判斷把關 —— 手勢在整個視窗上都有效，
// 所以「什麼畫面不可以送」全靠這支。送錯的代價是真的：PTT 開著輸入框時左方向鍵
// 只會被 vgetstring 吃掉（使用者的手勢石沉大海），編輯器裡則是把游標移到別處。
import { navKeyAllowed } from "../../src/js/nav_key_gate";

const core = (over = {}) => ({
  modalShown: false,
  conn: { isConnected: true },
  buf: { pageState: 3, isCursorOnInputField: () => false },
  ...over,
});

test("文章／列表／選單可以送", () => {
  [1, 2, 3, 4].forEach((pageState) =>
    expect(
      navKeyAllowed(core({ buf: { pageState, isCursorOnInputField: () => false } })),
    ).toBe(true),
  );
});

test("NORMAL(0)／密碼(5)／編輯器(6) 不送", () => {
  [0, 5, 6].forEach((pageState) =>
    expect(
      navKeyAllowed(core({ buf: { pageState, isCursorOnInputField: () => false } })),
    ).toBe(false),
  );
});

test("PTT 開著輸入框時不送（左方向鍵只會被輸入框吃掉）", () => {
  expect(
    navKeyAllowed(core({ buf: { pageState: 2, isCursorOnInputField: () => true } })),
  ).toBe(false);
});

test("對話框開著時不送（modalShown 是鍵盤總閘門）", () => {
  expect(navKeyAllowed(core({ modalShown: true }))).toBe(false);
});

test("未連線時不送", () => {
  expect(navKeyAllowed(core({ conn: null }))).toBe(false);
  expect(navKeyAllowed(core({ conn: { isConnected: false } }))).toBe(false);
});

test("缺值一律當不可送，不會意外發鍵", () => {
  expect(navKeyAllowed(null)).toBe(false);
  expect(navKeyAllowed({})).toBe(false);
  expect(navKeyAllowed({ conn: { isConnected: true } })).toBe(false);
});
