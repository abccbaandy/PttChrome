// @unit-env browser
// Debug 錄製鈕收在「⋯」浮動工具裡（render/screen.js#_syncOverlays）：
//   - enhance.debugRecordButton ⇒ 任何畫面（列表／主選單）都出現，不限文章頁；
//   - 關掉 ⇒ 沒有其他工具時整個「⋯」不出現；
//   - 點下去呼叫 enhance.onDebugRecord，以回傳值立即更新 label 與「⋯」的錄製中標示；
//   - 錄製狀態以 enhance.debugRecording 每幀對帳（App 端才是真相）；
//   - 與文章工具並存時排在面板最後。
// 回歸：舊版是獨立 fixed 按鈕（right/bottom 16），手機上疊在底部工具列上
// （真版面守護在 tests/e2e/offline/mobile_float_tools.offline.spec.js）。
// real-input: tests/e2e/offline/debug_record.offline.spec.js
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { setupI18n, i18n } from "../../src/js/i18n";

beforeAll(() => setupI18n());
afterEach(unmountAll);

const NORMAL = {
  fg: 7,
  bg: 0,
  blink: false,
  equals(o) {
    return !!o && o.fg === this.fg && o.bg === this.bg && o.blink === this.blink;
  },
};
const HIDDEN = { ...NORMAL, fg: 0, equals: NORMAL.equals };

const line = (str, col = NORMAL) =>
  str.split("").map((c) => ({
    ch: c,
    isLeadByte: false,
    isStartOfURL: () => false,
    isEndOfURL: () => false,
    getFullURL: () => null,
    getColor: () => col,
  }));

const MENU_LINES = [line("main menu"), line("(A)nnounce")];

function render(lines, enhance) {
  return mountScreen({
    lines,
    enableLinkInlinePreview: false,
    enableLinkHoverPreview: false,
    enhance: Object.assign({ pageState: 1 }, enhance),
  });
}

const rec = (s) => s.container.querySelector("#debugRecordBtn");
const tools = (s) => s.container.querySelector("#floatTools");

test("debug 模式關 ⇒ 沒有錄製鈕，也沒有「⋯」", () => {
  const s = render(MENU_LINES, { debugRecordButton: false });
  expect(rec(s)).toBe(null);
  expect(tools(s)).toBe(null);
});

test.each([
  ["主選單", 1],
  ["文章列表", 2],
  ["文章", 3],
])("debug 模式開 ⇒ %s 也出現在「⋯」面板裡", (_name, pageState) => {
  const s = render(MENU_LINES, { debugRecordButton: true, pageState });
  expect(tools(s).querySelector(".floatTools__panel #debugRecordBtn")).toBe(rec(s));
  expect(rec(s).textContent).toBe("● " + i18n("debugRecord_start"));
  expect(tools(s).hasAttribute("data-recording")).toBe(false);
});

test("點一下 ⇒ 呼叫 onDebugRecord，依回傳值立即切到錄製中；再點切回", () => {
  let recording = false;
  const calls = [];
  const onDebugRecord = () => {
    calls.push(recording);
    recording = !recording;
    return recording;
  };
  const s = render(MENU_LINES, { debugRecordButton: true, onDebugRecord });
  rec(s).click();
  expect(calls).toEqual([false]);
  expect(rec(s).getAttribute("data-recording")).toBe("on");
  expect(rec(s).textContent).toBe("■ " + i18n("debugRecord_stop"));
  expect(tools(s).hasAttribute("data-recording")).toBe(true);
  rec(s).click();
  expect(rec(s).getAttribute("data-recording")).toBe("off");
  expect(tools(s).hasAttribute("data-recording")).toBe(false);
});

test("錄製狀態以 enhance.debugRecording 對帳；關掉 debug 模式 ⇒ 鈕與「⋯」消失", () => {
  const s = render(MENU_LINES, { debugRecordButton: true, debugRecording: true });
  expect(rec(s).getAttribute("data-recording")).toBe("on");
  expect(tools(s).hasAttribute("data-recording")).toBe(true);
  s.update({
    lines: MENU_LINES,
    enableLinkInlinePreview: false,
    enableLinkHoverPreview: false,
    enhance: { pageState: 1, debugRecordButton: false },
  });
  expect(rec(s)).toBe(null);
  expect(tools(s)).toBe(null);
});

test("與文章工具並存：同一顆「⋯」、錄製鈕排最後", () => {
  const s = render([line("body"), line("hidden", HIDDEN)], {
    pageState: 3,
    easyReading: true,
    dropHidden: true,
    articleId: 1,
    debugRecordButton: true,
  });
  const panel = tools(s).querySelector(".floatTools__panel");
  const ids = Array.from(panel.children).map((b) => b.id);
  expect(ids).toEqual(["lightsOnBtn", "debugRecordBtn"]);
  expect(s.container.querySelectorAll("#floatTools").length).toBe(1);
});
