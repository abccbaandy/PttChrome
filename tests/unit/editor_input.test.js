// @unit-env browser
// 編輯器輸入框（P27，js/editor_input.js、docs/editor-input.md）。
//
// 鎖的症狀：
//   1. 入口只在 PTT 編輯器（pageState 6）出現；功能開關關、安全模式 ⇒ 不出現。
//   2. 插入＝貼上漏斗（App.onPasteDone），整段一次交出去；PTT 畫不出來的字先濾掉並回報。
//   3. 不在編輯器（框開著時畫面換了）、只有空白 ⇒ 不送，框留著、內容不丟。
import {
  EditorInput,
  editorInputAvailable,
  prepareEditorInsert,
} from "../../src/js/editor_input";
import { DEFAULT_PREFS, NATIVE_SAFE_MODE_KEYS } from "../../src/js/pref_storage";
import { loadBig5Tables } from "./helpers/load_big5_tables";

beforeAll(() => loadBig5Tables());

describe("editorInputAvailable／prepareEditorInsert", () => {
  test("只在編輯器（pageState 6）、開關開、不是安全模式", () => {
    const base = { enabled: true, safeMode: false, pageState: 6, editorNow: true };
    expect(editorInputAvailable(base)).toBe(true);
    // pageState 黏在 6、底列已經不是編輯器（^Q 確認列等 prompt）⇒ 不出現
    expect(editorInputAvailable({ ...base, editorNow: false })).toBe(false);
    expect(editorInputAvailable({ ...base, pageState: 3 })).toBe(false);
    expect(editorInputAvailable({ ...base, enabled: false })).toBe(false);
    expect(editorInputAvailable({ ...base, safeMode: true })).toBe(false);
    expect(editorInputAvailable(null)).toBe(false);
  });

  test("功能開關預設開，而且在安全模式名單內（會替使用者送字）", () => {
    expect(DEFAULT_PREFS.enableEditorInput).toBe(true);
    expect(NATIVE_SAFE_MODE_KEYS).toContain("enableEditorInput");
  });

  test("濾掉 PTT 畫不出來的字（emoji、控制字元），換行留著；只剩空白＝空", () => {
    const p = prepareEditorInsert("第一行😀\n第二行\x1b");
    expect(p.text).toBe("第一行\n第二行");
    expect(p.dropped).toEqual(["😀", "\x1b"]);
    expect(p.empty).toBe(false);
    expect(prepareEditorInsert(" \n \n").empty).toBe(true);
  });
});

describe("EditorInput（控制器）", () => {
  const makeCore = (pageState) => ({
    buf: {
      pageState,
      addEventListener() {},
      isEditorScreenNow() {
        return this.pageState === 6 && !this.promptOnFooter;
      },
    },
    view: { mainDisplay: null, chh: 20 },
    onPasteDone: vi.fn(),
  });

  test("編輯器：open ⇒ 開框；insert ⇒ 濾過的整段交給貼上漏斗、框收起", () => {
    const core = makeCore(6);
    const ed = new EditorInput(core);
    ed.refresh();
    expect(ed.state.available).toBe(true);
    expect(ed.open()).toBe(true);
    expect(ed.state.open).toBe(true);
    const r = ed.insert("你好😀\n世界");
    expect(r).toMatchObject({ ok: true, dropped: ["😀"] });
    expect(core.onPasteDone).toHaveBeenCalledTimes(1);
    expect(core.onPasteDone).toHaveBeenCalledWith("你好\n世界");
    expect(ed.state.open).toBe(false);
  });

  test("不在編輯器：入口不出現、open 不開；框開著時畫面換了 ⇒ insert 不送、框留著", () => {
    const core = makeCore(3);
    const ed = new EditorInput(core);
    ed.refresh();
    expect(ed.state.available).toBe(false);
    expect(ed.open()).toBe(false);

    core.buf.pageState = 6;
    expect(ed.open()).toBe(true);
    core.buf.pageState = 3;
    expect(ed.insert("內容")).toMatchObject({ ok: false, reason: "not-editor" });
    expect(core.onPasteDone).not.toHaveBeenCalled();
    expect(ed.state.open).toBe(true);
  });

  test("框開著時編輯器底列跳出 prompt（pageState 還是 6）⇒ insert 不送、框留著", () => {
    const core = makeCore(6);
    const ed = new EditorInput(core);
    expect(ed.open()).toBe(true);
    core.buf.promptOnFooter = true;
    expect(ed.insert("yes")).toMatchObject({ ok: false, reason: "not-editor" });
    expect(core.onPasteDone).not.toHaveBeenCalled();
    expect(ed.state.open).toBe(true);
  });

  test("只有空白 ⇒ 不送", () => {
    const core = makeCore(6);
    const ed = new EditorInput(core);
    ed.open();
    expect(ed.insert("   ")).toMatchObject({ ok: false, reason: "empty" });
    expect(core.onPasteDone).not.toHaveBeenCalled();
  });
});
