// @unit-env browser
// 搜尋鍵（/ ? a Z）改開搜尋彈窗——term_view 的兩條入口：鍵盤 onKeyDown 與
// IME／Android 軟鍵盤 onTextInput（軟鍵盤的字多半走 input 事件，不經 keydown）。
//
// 最重要的兩條：
//   - 攔截排在列表好讀 keyOwner 之前（那邊會把 / 當 passthrough 直接送出去）
//   - openSearchModal 沒開成 ⇒ 不准吞鍵
import { TermView } from "../../src/js/term_view";
import { writeValues, readValuesWithDefault } from "../../src/js/pref_storage";

const ROWS = 24;
const LIST_ROWS = Array.from({ length: ROWS }, () => "");
LIST_ROWS[0] = " 【板主:none】看板《Test》";
LIST_ROWS[23] = " 文章選讀  (y)回應(X)推文(^X)轉錄 ";

beforeEach(() => {
  localStorage.clear();
  writeValues({ ...readValuesWithDefault(), searchKeyOpensModal: true });
});

function ctxOnList(over) {
  const o = over || {};
  const keyboard = { onKeyDown: vi.fn() };
  const keyOwner = { onKeyDown: vi.fn(), noteTextInput: vi.fn(() => false) };
  const buf = {
    pageState: 2,
    rows: ROWS,
    cols: 80,
    cur_x: 0,
    cur_y: 5,
    getRowText: (r) => LIST_ROWS[r],
    isCursorOnInputField: () => false,
    easyReadingFunctionMode: false,
    startedEasyReading: false,
    listRenderMode: o.owned ? "buffer" : "native",
    listRenderOwner: o.owned ? "article-list" : null,
  };
  const openSearchModal = vi.fn(o.opens === false ? () => undefined : () => true);
  const ctx = {
    bbscore: {
      aidNavigation: { active: false },
      longPush: { active: false },
      easyReading: { tryReenterFromNative: () => false, _onKeyDown: vi.fn(), noteTextInput: vi.fn() },
      buf,
      openSearchModal,
      openLongPushModal: vi.fn(),
      activeListSession: () => (o.owned ? keyOwner : null),
      listSession: keyOwner,
      noteListNativeInput: vi.fn(),
    },
    buf,
    useEasyReadingMode: false,
    _keyboard: keyboard,
    _convSend: vi.fn(),
    flashListHint: vi.fn(),
  };
  return { ctx, keyboard, keyOwner, openSearchModal };
}

const keyEvent = (key, over) => ({
  key,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  defaultPrevented: false,
  preventDefault: vi.fn(),
  ...over,
});

describe("鍵盤（onKeyDown）", () => {
  test.each([
    ["/", "title"],
    ["?", "title"],
    ["a", "author"],
    ["Z", "push"],
    ["s", "board"],
  ])("文章列表按 %s → 開彈窗（%s），一個 byte 都不送", (key, kind) => {
    const { ctx, keyboard, openSearchModal } = ctxOnList();
    const e = keyEvent(key);
    TermView.prototype.onKeyDown.call(ctx, e);
    expect(openSearchModal).toHaveBeenCalledWith(kind);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(keyboard.onKeyDown).not.toHaveBeenCalled();
  });

  test("列表好讀接管中：攔在 keyOwner 之前", () => {
    const { ctx, keyOwner, openSearchModal } = ctxOnList({ owned: true });
    TermView.prototype.onKeyDown.call(ctx, keyEvent("/"));
    expect(openSearchModal).toHaveBeenCalled();
    expect(keyOwner.onKeyDown).not.toHaveBeenCalled();
  });

  test("openSearchModal 沒開成 ⇒ 不吞，照原生送出", () => {
    const { ctx, keyboard } = ctxOnList({ opens: false });
    const e = keyEvent("/");
    TermView.prototype.onKeyDown.call(ctx, e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(keyboard.onKeyDown).toHaveBeenCalled();
  });

  test("pref 關掉 ⇒ 原生", () => {
    writeValues({ ...readValuesWithDefault(), searchKeyOpensModal: false });
    const { ctx, keyboard, openSearchModal } = ctxOnList();
    TermView.prototype.onKeyDown.call(ctx, keyEvent("/"));
    expect(openSearchModal).not.toHaveBeenCalled();
    expect(keyboard.onKeyDown).toHaveBeenCalled();
  });
});

describe("IME／軟鍵盤（onTextInput）", () => {
  test("單一 / 字元 → 開彈窗、不送字", () => {
    const { ctx, openSearchModal } = ctxOnList();
    TermView.prototype.onTextInput.call(ctx, "/");
    expect(openSearchModal).toHaveBeenCalledWith("title");
    expect(ctx._convSend).not.toHaveBeenCalled();
  });
  test("貼上的 / 不是按鍵", () => {
    const { ctx, openSearchModal } = ctxOnList();
    TermView.prototype.onTextInput.call(ctx, "/", true);
    expect(openSearchModal).not.toHaveBeenCalled();
  });
  test("一次上字多個字元（ab）不攔", () => {
    const { ctx, openSearchModal } = ctxOnList();
    TermView.prototype.onTextInput.call(ctx, "ab");
    expect(openSearchModal).not.toHaveBeenCalled();
    expect(ctx._convSend).toHaveBeenCalledWith("ab");
  });
});
