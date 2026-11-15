// @unit-env browser
// P76：手機把右下「⋯」浮動工具收進「更多」面板（render/screen.js#sheetTools，
// enhance.floatToolsInSheet＝手機版面＋pref mobileFloatToolsInMore）。
//   - 收進去 ⇒ 不畫「⋯」，同一份工具由 sheetTools() 交出去（label＝按鈕此刻的字）；
//   - run() ＝按那顆按鈕本身 ⇒ 效果與在「⋯」面板點一模一樣（這裡用錄製鈕驗：onDebugRecord 被叫、label 換）；
//   - 開關關掉 ⇒ 照舊畫「⋯」、sheetTools() 是空的（兩邊不會同時出現）；
//   - 任何畫面都收（主選單／列表上的 debug 鈕也在「更多」，不只文章裡）；debug 鈕歸 group "debug"，
//     文章工具歸 "article"（面板據此分「除錯」「這篇文章」兩區）；
//   - 開關切換時下一次 render 就換位置，不殘留另一邊；debug 錄製中照舊畫紅色「⋯」。
// real-input: tests/e2e/offline/mobile_float_tools.offline.spec.js
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { setupI18n, i18n } from "../../src/js/i18n";
import { PAGE_READING } from "../../src/js/screen_annotations";

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
const line = (str) =>
  str.split("").map((c) => ({
    ch: c,
    isLeadByte: false,
    isStartOfURL: () => false,
    isEndOfURL: () => false,
    getFullURL: () => null,
    getColor: () => NORMAL,
  }));
const LINES = [line("main menu"), line("(A)nnounce")];

function props(enhance) {
  return {
    lines: LINES,
    enableLinkInlinePreview: false,
    enableLinkHoverPreview: false,
    enhance: Object.assign({ pageState: PAGE_READING, debugRecordButton: true }, enhance),
  };
}

const floatTools = (s) => s.container.querySelector("#floatTools");

test("收進更多 ⇒ 沒有「⋯」，sheetTools 交出同一顆工具", () => {
  const s = mountScreen(props({ floatToolsInSheet: true }));
  expect(floatTools(s)).toBe(null);
  const tools = s.controller.sheetTools();
  expect(tools.map((t) => t.id)).toEqual(["debugRecordBtn"]);
  expect(tools[0].label).toBe("● " + i18n("debugRecord_start"));
  expect(tools[0].active).toBe(false);
});

test("run() ＝按那顆按鈕：呼叫 onDebugRecord，下一次問就是新的字與作用中", () => {
  let recording = false;
  const onDebugRecord = () => (recording = !recording);
  const s = mountScreen(props({ floatToolsInSheet: true, onDebugRecord, isDebugRecording: () => recording }));
  s.controller.sheetTools()[0].run();
  expect(recording).toBe(true);
  // 開始錄製 ⇒ 立刻換成紅色「⋯」（不等下一幀），面板裡不再有它。
  expect(floatTools(s)).not.toBe(null);
  expect(floatTools(s).hasAttribute("data-recording")).toBe(true);
  expect(floatTools(s).querySelector("#debugRecordBtn").textContent).toBe(
    "■ " + i18n("debugRecord_stop"),
  );
  expect(s.controller.sheetTools()).toEqual([]);
  // 從「⋯」停止 ⇒ 立刻收回面板。
  floatTools(s).querySelector("#debugRecordBtn").click();
  expect(recording).toBe(false);
  expect(floatTools(s)).toBe(null);
  expect(s.controller.sheetTools()[0].label).toBe("● " + i18n("debugRecord_start"));
});

test("開關關掉 ⇒ 照舊畫「⋯」，sheetTools 是空的", () => {
  const s = mountScreen(props({ floatToolsInSheet: false }));
  expect(floatTools(s)).not.toBe(null);
  expect(floatTools(s).querySelector("#debugRecordBtn")).not.toBe(null);
  expect(s.controller.sheetTools()).toEqual([]);
});

test("切換開關 ⇒ 下一次 render 換到另一邊，不殘留", () => {
  const s = mountScreen(props({ floatToolsInSheet: false }));
  s.update(props({ floatToolsInSheet: true }));
  expect(floatTools(s)).toBe(null);
  expect(s.controller.sheetTools()).toHaveLength(1);
  s.update(props({ floatToolsInSheet: false }));
  expect(floatTools(s)).not.toBe(null);
  expect(s.controller.sheetTools()).toEqual([]);
});

test("debug 錄製中 ⇒ 照舊畫紅色「⋯」（正在錄要一直看得到），停了再收回更多", () => {
  let recording = true;
  const isDebugRecording = () => recording;
  const s = mountScreen(props({ floatToolsInSheet: true, isDebugRecording }));
  expect(floatTools(s)).not.toBe(null);
  expect(floatTools(s).hasAttribute("data-recording")).toBe(true);
  expect(s.controller.sheetTools()).toEqual([]);
  recording = false;
  s.update(props({ floatToolsInSheet: true, isDebugRecording }));
  expect(floatTools(s)).toBe(null);
  expect(s.controller.sheetTools()).toHaveLength(1);
});

test("沒有任何工具 ⇒ 兩邊都沒有", () => {
  const s = mountScreen(props({ floatToolsInSheet: true, debugRecordButton: false }));
  expect(floatTools(s)).toBe(null);
  expect(s.controller.sheetTools()).toEqual([]);
});

test("不在文章裡（主選單）⇒ debug 鈕一樣收進更多，歸「除錯」區", () => {
  const s = mountScreen(
    props({ floatToolsInSheet: true, pageState: 1, debugSaveButton: true, onDebugSave: () => {} }),
  );
  expect(floatTools(s)).toBe(null);
  expect(s.controller.sheetTools().map((t) => [t.id, t.group])).toEqual([
    ["debugRecordBtn", "debug"],
    ["debugSaveBtn", "debug"],
  ]);
});
