// @unit-env browser
// unit-browser 的測試檔之間不共用 storage（tests/unit/helpers/browser_storage.js）。
// 同一個 worker 分頁依序跑多個檔時，前一個檔留下的 prefs 會讓下一個檔讀到被關掉的功能
//（首頁儀表板、下一篇卡片都在安全模式名單裡，前一個檔留下 nativeSafeMode: true 就整檔紅）。
import { resetBrowserStorage } from "./helpers/browser_storage";

// 模組一載入就量：setup.js 已經跑過，這時 storage 必須是空的，不管前面跑過哪些檔。
const atStart = { local: localStorage.length, session: sessionStorage.length };

afterAll(() => {
  // 故意留東西給同一個分頁的下一個檔：setup.js 要清得掉。
  localStorage.setItem("pttchrome.pref.v1", JSON.stringify({ values: { nativeSafeMode: true } }));
  sessionStorage.setItem("__leftover__", "1");
});

test("每個檔開跑時 storage 是空的", () => {
  expect(atStart).toEqual({ local: 0, session: 0 });
});

test("resetBrowserStorage 清掉兩種 storage，且用的是真的 Storage", () => {
  localStorage.setItem("a", "1");
  sessionStorage.setItem("b", "2");
  resetBrowserStorage(window);
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
  expect(localStorage).toBeInstanceOf(Storage);
});
