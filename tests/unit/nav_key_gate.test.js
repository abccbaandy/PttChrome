// 手勢／瀏覽器返回鍵送出方向鍵之前的守門（src/js/nav_key_gate.js）。
//
// 這條路不像滑鼠點擊有 mouse_regions 的區域判斷把關 —— 手勢在整個視窗上都有效，
// 所以「什麼畫面不可以送」全靠這支。送錯的代價是真的：PTT 開著輸入框時左方向鍵
// 只會被 vgetstring 吃掉（使用者的手勢石沉大海），編輯器裡則是把游標移到別處。
import { navKeyAllowed, navKeyBlockReason } from "../../src/js/nav_key_gate";

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

// 觸控板左滑「有時」失效：有原生返回動畫、沒送 ←、閃「再按一次上一頁可離開本站」，
// 進任一篇文章後恢復。根因是 setPageState 沒有 reset 分支 ⇒ pressanykey(5) 之後落在
// 判不出的畫面時 pageState **黏在 5**。這一幀根本不是 pass 畫面 ⇒ 5 是殘留，不可擋。
describe("黏住的 pageState 5", () => {
  const buf5 = (passNow) => ({
    pageState: 5,
    isCursorOnInputField: () => false,
    isPassScreenNow: () => passNow,
  });

  test("本幀已非 pass 畫面 ⇒ 5 是上一幀殘留，照送", () => {
    expect(navKeyAllowed(core({ buf: buf5(false) }))).toBe(true);
    expect(navKeyBlockReason(core({ buf: buf5(false) }))).toBe(null);
  });

  test("本幀仍是 pass 畫面 ⇒ 照舊擋（保留離站逃生門語意）", () => {
    expect(navKeyAllowed(core({ buf: buf5(true) }))).toBe(false);
    expect(navKeyBlockReason(core({ buf: buf5(true) }))).toBe("pageState:5");
  });
});

describe("navKeyBlockReason（debug log 用：擋下時說得出是哪一道）", () => {
  test("各道閘門的原因字串", () => {
    expect(navKeyBlockReason(null)).toBe("noCore");
    expect(navKeyBlockReason(core({ modalShown: true }))).toBe("modal");
    expect(navKeyBlockReason(core({ conn: null }))).toBe("disconnected");
    expect(navKeyBlockReason(core({ buf: null }))).toBe("noBuf");
    expect(
      navKeyBlockReason(core({ buf: { pageState: 0, isCursorOnInputField: () => false } })),
    ).toBe("pageState:0");
    expect(
      navKeyBlockReason(core({ buf: { pageState: 2, isCursorOnInputField: () => true } })),
    ).toBe("inputField");
    expect(navKeyBlockReason(core())).toBe(null);
  });
});
