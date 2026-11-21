// @unit-env browser
// A9 列表引擎合一第一步：文章列表與看板列表逐字相同的方法搬進 list_engine_shared.js。
// 鎖：兩個 prototype 用的是同一份函式（沒有各自再寫一份）、靜置探針的安靜時間兩邊一致、
// 「文字一樣但行為不同」的方法沒有被誤搬（提示字來自各檔私有的 nativeResumeHint）。
import { LIST_ENGINE_SHARED, RESUME_QUIET_MS } from "../../src/js/list_engine_shared";
import { ListSession } from "../../src/js/list_session";
import { BoardListSession } from "../../src/js/board_list_session";
import listSrc from "../../src/js/list_session.js?raw";
import boardSrc from "../../src/js/board_list_session.js?raw";

const NAMES = Object.keys(LIST_ENGINE_SHARED);

test("兩個列表引擎的共用方法是同一份函式", () => {
  expect(NAMES.length).toBeGreaterThan(10);
  for (const name of NAMES) {
    expect(ListSession.prototype[name], name).toBe(LIST_ENGINE_SHARED[name]);
    expect(BoardListSession.prototype[name], name).toBe(LIST_ENGINE_SHARED[name]);
  }
});

test("各檔沒有再寫一份同名方法", () => {
  for (const name of NAMES) {
    const re = new RegExp(`^  ${name}: function\\(`, "m");
    expect(re.test(listSrc), `list_session.js 又寫了 ${name}`).toBe(false);
    expect(re.test(boardSrc), `board_list_session.js 又寫了 ${name}`).toBe(false);
  }
});

test("靜置探針的安靜時間兩邊一致（各檔的 CMD_PROBE_AFTER_MS 還有別的用途）", () => {
  const probeOf = (src) => Number(/const CMD_PROBE_AFTER_MS = (\d+)/.exec(src)[1]);
  expect(probeOf(listSrc)).toBe(RESUME_QUIET_MS);
  expect(probeOf(boardSrc)).toBe(RESUME_QUIET_MS);
});

test("提示字不同的 onPaste／noteTextInput 不共用（看板列表講的是平滑捲動）", () => {
  expect(NAMES).not.toContain("onPaste");
  expect(NAMES).not.toContain("noteTextInput");
  expect(ListSession.prototype.onPaste).not.toBe(BoardListSession.prototype.onPaste);
});
