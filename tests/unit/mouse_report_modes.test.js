// 主機宣告的滑鼠模式狀態機。
//
// 這一組同時是兩個「參考實作 ptt-term 做錯了、我們刻意不照抄」的回歸鎖：
//   (b) ptt-term 的 locator.js:92-94 讓 handleDECRST(1006) 完全 no-op
//       ⇒ 主機關掉 SGR 之後它繼續送 SGR。
//   (f) ptt-term 的 locator.js:22 把 sgrMode 初始化成 true
//       ⇒ 主機只開 1000、沒開 1006 時它照樣送 SGR。
import { MouseReportState } from "../../src/js/mouse_report";

function st(enabled) {
  const s = new MouseReportState();
  s.enabled = enabled !== false;
  return s;
}

describe("MouseReportState", () => {
  test("初值：什麼都沒有 ⇒ 不 active，且 sgr 必須是 false", () => {
    const s = new MouseReportState();
    expect(s.trackingMode).toBe(0);
    expect(s.sgr).toBe(false); // 缺陷 (f) 的回歸鎖
    expect(s.enabled).toBe(false);
    expect(s.isActive()).toBe(false);
  });

  test("只開 1000 沒開 1006 ⇒ 不 active（不可以送 SGR）", () => {
    const s = st();
    s.handleDECSET(1000);
    expect(s.trackingMode).toBe(1000);
    expect(s.isActive()).toBe(false);
  });

  test("1000 + 1006 ⇒ active", () => {
    const s = st();
    s.handleDECSET(1000);
    s.handleDECSET(1006);
    expect(s.isActive()).toBe(true);
  });

  test("pref 關掉 ⇒ 永遠不 active，即使主機都開了", () => {
    const s = st(false);
    s.handleDECSET(1000);
    s.handleDECSET(1006);
    expect(s.isActive()).toBe(false);
  });

  // 缺陷 (b) 的回歸鎖。
  test("主機送 ESC[?1006l 之後必須停止回報", () => {
    const s = st();
    s.handleDECSET(1000);
    s.handleDECSET(1006);
    expect(s.isActive()).toBe(true);

    s.handleDECRST(1006);
    expect(s.sgr).toBe(false);
    expect(s.isActive()).toBe(false);
  });

  test("PTT 的 MOUSE_MODE_CLICK 實際序列：1003l → 1000h → 1006h", () => {
    const s = st();
    s.handleDECRST(1003); // 當前是 0，不該有任何影響
    s.handleDECSET(1000);
    s.handleDECSET(1006);
    expect(s.trackingMode).toBe(1000);
    expect(s.isActive()).toBe(true);
  });

  test("PTT 的關閉四連（無 UF_MOUSE 的人實際收到的）⇒ 全關", () => {
    const s = st();
    s.handleDECSET(1000);
    s.handleDECSET(1006);
    s.handleDECRST(1000);
    s.handleDECRST(1002);
    s.handleDECRST(1003);
    s.handleDECRST(1006);
    expect(s.trackingMode).toBe(0);
    expect(s.sgr).toBe(false);
    expect(s.isActive()).toBe(false);
  });

  // term.c 的 CLICK/DRAG 模式第一件事就是送 ESC[?1003l，不可以把當前模式清掉。
  test("不相符的 DECRST 不得清掉當前 tracking 模式", () => {
    const s = st();
    s.handleDECSET(1000);
    s.handleDECRST(1002);
    s.handleDECRST(1003);
    expect(s.trackingMode).toBe(1000);
  });

  test("相符的 DECRST 才清掉", () => {
    const s = st();
    s.handleDECSET(1002);
    s.handleDECRST(1002);
    expect(s.trackingMode).toBe(0);
  });

  test("reset() 清連線狀態但不動 enabled（那是使用者偏好）", () => {
    const s = st();
    s.handleDECSET(1003);
    s.handleDECSET(1006);
    s.reset();
    expect(s.trackingMode).toBe(0);
    expect(s.sgr).toBe(false);
    expect(s.enabled).toBe(true);
  });

  // 這些是別的 wire 格式；記錄了卻不實作是最難查的不一致，所以完全不收。
  test.each([9, 1001, 1005, 1015])(
    "模式 %i 完全不改變狀態（刻意不實作也不記錄）",
    (mode) => {
      const s = st();
      s.handleDECSET(mode);
      expect(s.trackingMode).toBe(0);
      expect(s.sgr).toBe(false);
      expect(s.isActive()).toBe(false);
    }
  );
});
