// SGR 滑鼠回報的編碼（純函式）。
//
// 對照 server 端 common/sys/vtkbd.c:299-326：只認 `ESC[<Cb;Cx;Cy` + 'M'(press)
// 或 'm'(release)，且 `flags = btn_raw & (4|8|16)`。
import {
  sgrButtonCode,
  toOneBased,
  encodeSgrMouse,
  encodeClick,
  encodeWheel
} from "../../src/js/mouse_report";

describe("sgrButtonCode", () => {
  test("三顆按鍵", () => {
    expect(sgrButtonCode({ button: 0 })).toBe(0);
    expect(sgrButtonCode({ button: 1 })).toBe(1);
    expect(sgrButtonCode({ button: 2 })).toBe(2);
  });

  test("滾輪是 64（上）／65（下），與 button 無關", () => {
    expect(sgrButtonCode({ wheel: "up" })).toBe(64);
    expect(sgrButtonCode({ wheel: "down" })).toBe(65);
    expect(sgrButtonCode({ wheel: "down", button: 2 })).toBe(65);
  });

  test("modifier bits：shift 4 / alt|meta 8 / ctrl 16", () => {
    expect(sgrButtonCode({ button: 0, shiftKey: true })).toBe(4);
    expect(sgrButtonCode({ button: 0, altKey: true })).toBe(8);
    expect(sgrButtonCode({ button: 0, metaKey: true })).toBe(8);
    expect(sgrButtonCode({ button: 0, ctrlKey: true })).toBe(16);
    expect(
      sgrButtonCode({ button: 2, shiftKey: true, ctrlKey: true })
    ).toBe(2 | 4 | 16);
    expect(sgrButtonCode({ wheel: "up", ctrlKey: true })).toBe(64 | 16);
  });
});

describe("toOneBased", () => {
  test("0-based → 1-based", () => {
    expect(toOneBased({ col: 0, row: 0 })).toEqual({ col1: 1, row1: 1 });
    expect(toOneBased({ col: 39, row: 11 })).toEqual({ col1: 40, row1: 12 });
  });

  test("夾在畫面範圍內（clientToPos 邊緣會回傳 -1 / cols）", () => {
    expect(toOneBased({ col: -1, row: -5 })).toEqual({ col1: 1, row1: 1 });
    expect(toOneBased({ col: 80, row: 24, cols: 80, rows: 24 })).toEqual({
      col1: 80,
      row1: 24
    });
    expect(toOneBased({ col: 999, row: 999, cols: 80, rows: 24 })).toEqual({
      col1: 80,
      row1: 24
    });
  });

  test("非數字退回 1，不得產生 NaN", () => {
    expect(toOneBased({ col: undefined, row: null })).toEqual({
      col1: 1,
      row1: 1
    });
  });
});

describe("encodeSgrMouse / encodeClick / encodeWheel", () => {
  test("press 結尾 M、release 結尾 m", () => {
    expect(encodeSgrMouse({ cb: 0, col1: 1, row1: 1 })).toBe("\x1b[<0;1;1M");
    expect(
      encodeSgrMouse({ cb: 0, col1: 1, row1: 1, release: true })
    ).toBe("\x1b[<0;1;1m");
  });

  test("一次點擊 = press + release 兩段合成一次送", () => {
    expect(encodeClick({ button: 0, col: 4, row: 9 })).toBe(
      "\x1b[<0;5;10M\x1b[<0;5;10m"
    );
  });

  test("滾輪只有 press", () => {
    expect(encodeWheel({ wheel: "down", col: 0, row: 0 })).toBe(
      "\x1b[<65;1;1M"
    );
    expect(encodeWheel({ wheel: "up", col: 10, row: 3 })).toBe(
      "\x1b[<64;11;4M"
    );
  });
});
