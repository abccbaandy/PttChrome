// beforeunload 確認框（src/js/unload_guard.js）。
// 回歸：APK 內點文章連結（target=_blank）會先跳「離開這個網站？」，因為 beforeunload 在原生
// shouldOverrideUrlLoading 把連結轉給外部瀏覽器之前就跑了。
import { shouldWarnBeforeUnload } from "../../src/js/unload_guard";

describe("shouldWarnBeforeUnload", () => {
  test("網頁版：連線中且已過登入畫面 → 確認", () => {
    expect(shouldWarnBeforeUnload({ connected: true, pageState: 1, androidApp: false })).toBe(true);
  });

  test("網頁版：未連線或仍在登入畫面 → 不確認", () => {
    expect(shouldWarnBeforeUnload({ connected: false, pageState: 1, androidApp: false })).toBe(false);
    expect(shouldWarnBeforeUnload({ connected: true, pageState: 0, androidApp: false })).toBe(false);
  });

  test("APK：連線中點連結也不跳確認框", () => {
    expect(shouldWarnBeforeUnload({ connected: true, pageState: 1, androidApp: true })).toBe(false);
  });
});
