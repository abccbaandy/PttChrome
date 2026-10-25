// 手機「更多」的分組（P40，src/components/MobileToolbar/more_sheet_layout.js）：常用的收成上面的
// 圖示格、少用的留在清單；太少就不收；順序照圖示格清單；每個常用項目都有短字。
import {
  splitMoreGrid,
  MORE_GRID_KEYS,
  MORE_GRID_MIN,
  MORE_GRID_LABEL_KEYS,
} from "../../src/components/MobileToolbar/more_sheet_layout";
import { zh_TW } from "../../src/js/zh_TW_messages";
import { en_US } from "../../src/js/en_US_messages";

describe("splitMoreGrid", () => {
  test("常用的進圖示格（照 MORE_GRID_KEYS 順序），其餘照原順序留在清單", () => {
    const visible = ["__unreadJump", "__markAllRead", "__help", "__threadNav", "__select", "__selectAll", "__settings", "__logout"];
    expect(splitMoreGrid(visible)).toEqual({
      grid: ["__unreadJump", "__markAllRead", "__select", "__selectAll", "__help"],
      list: ["__threadNav", "__settings", "__logout"],
    });
  });

  test(`少於 ${MORE_GRID_MIN} 個就不收`, () => {
    const visible = ["__select", "__settings", "__logout"];
    expect(splitMoreGrid(visible)).toEqual({ grid: [], list: visible });
  });

  test("設定、登出、文章導覽、上傳紀錄永遠不進圖示格", () => {
    for (const k of ["__settings", "__logout", "__threadNav", "__uploadHistory"]) {
      expect(MORE_GRID_KEYS).not.toContain(k);
    }
  });

  test("每個常用項目兩個語系都有短字", () => {
    for (const k of MORE_GRID_KEYS) {
      const key = MORE_GRID_LABEL_KEYS[k];
      expect(key).toBeTruthy();
      expect(zh_TW[key] && zh_TW[key].message).toBeTruthy();
      expect(en_US[key] && en_US[key].message).toBeTruthy();
    }
  });
});
