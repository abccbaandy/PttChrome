// 全域未捕捉例外只寫本機 debug 錄製（src/js/page_error_log.js；架構 review A1 步驟 c）。
// 鎖：沒開錄製什麼都不做、開著才記；不 preventDefault（console／e2e pageerror 照樣看得到）；可拆。
import fs from "node:fs";
import path from "node:path";
import { installPageErrorLog } from "../../src/js/page_error_log";

function fakeWin() {
  const handlers = {};
  return {
    handlers,
    addEventListener: (type, fn) => ((handlers[type] = handlers[type] || []).push(fn)),
    removeEventListener: (type, fn) => (handlers[type] = (handlers[type] || []).filter((f) => f !== fn)),
    fire(type, e) {
      (handlers[type] || []).forEach((fn) => fn(e));
    },
  };
}

test("沒開錄製 ⇒ 什麼都不做、不丟例外", () => {
  const win = fakeWin();
  installPageErrorLog(win, () => null);
  expect(() => win.fire("error", { message: "x", error: new Error("x") })).not.toThrow();
  expect(() => win.fire("unhandledrejection", { reason: "r" })).not.toThrow();
});

test("開著錄製 ⇒ error／unhandledrejection 各記一筆，不 preventDefault", () => {
  const win = fakeWin();
  const logs = [];
  installPageErrorLog(win, () => ({ log: (tag, info) => logs.push([tag, info]) }));
  const preventDefault = vi.fn();
  win.fire("error", { message: "Uncaught boom", error: new Error("boom"), lineno: 12, preventDefault });
  win.fire("unhandledrejection", { reason: new Error("later"), preventDefault });
  win.fire("unhandledrejection", { reason: "plain", preventDefault });
  expect(logs.map((l) => l[0])).toEqual(["pageError", "pageRejection", "pageRejection"]);
  expect(logs[0][1]).toMatchObject({ message: "boom", line: 12 });
  expect(logs[0][1].stack).toMatch(/boom/);
  expect(logs[1][1].message).toBe("later");
  expect(logs[2][1]).toEqual({ message: "plain", stack: null });
  expect(preventDefault).not.toHaveBeenCalled();
});

test("錄製是後來才開的也記得到（每次都向 App 取現在的錄製器）", () => {
  const win = fakeWin();
  let rec = null;
  installPageErrorLog(win, () => rec);
  const logs = [];
  rec = { log: (tag) => logs.push(tag) };
  win.fire("error", { message: "m" });
  expect(logs).toEqual(["pageError"]);
});

test("回傳的函式拆掉兩個監聽", () => {
  const win = fakeWin();
  const off = installPageErrorLog(win, () => null);
  off();
  expect(win.handlers.error).toEqual([]);
  expect(win.handlers.unhandledrejection).toEqual([]);
});

test("App 有接上（只開著錄製時記）", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../../src/js/pttchrome.jsx"), "utf8");
  expect(src).toMatch(/installPageErrorLog\(window,\s*\(\)\s*=>\s*this\.debugRecorder\)/);
});
