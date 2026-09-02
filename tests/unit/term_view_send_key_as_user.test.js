// view.sendKeyAsUser（src/js/term_view.js）——手勢與瀏覽器返回鍵的唯一出口。
//
// 它合成一個 keydown 再走既有的 onKeyDown 分派鏈，所以三種 render 分支各自的
// 語意（原生直送／文章好讀先收狀態機／列表好讀走 {class:'leave'} 序列化交易）
// 全部自動沿用。這支鎖住那條鏈**還是那條鏈**：
//  1. cancelable: true —— 拿掉就紅。整條鏈靠 defaultPrevented 判斷「上游接手了」，
//     少了它 easyReading／listSession 接手之後 _keyboard 還會再送一次 \x1b[D
//     （列表好讀底下＝在序列化交易中途裸送 byte）。
//  2. 上游接手時不得落到 TermKeyboard。
//  3. 列表好讀模式必須交給 listSession，不可以自己送 byte。
import { TermView } from "../../src/js/term_view";

function makeView({ listRenderMode = "native", useEasyReadingMode = false } = {}) {
  const view = Object.create(TermView.prototype);
  const seen = { keyboard: [], easyReading: [], listSession: [], hints: [] };
  const listSession = { onKeyDown: vi.fn((e) => seen.listSession.push(e)) };
  view.useEasyReadingMode = useEasyReadingMode;
  view.buf = {
    pageState: 3,
    listRenderMode,
    startedEasyReading: useEasyReadingMode,
    easyReadingFunctionMode: false,
  };
  view.bbscore = {
    buf: view.buf,
    aidNavigation: { active: false },
    longPush: { active: false },
    deepLinkController: {},
    easyReading: {
      _onKeyDown: vi.fn((e) => seen.easyReading.push(e)),
      tryReenterFromNative: vi.fn(() => false),
    },
    listSession,
    // term_view 的鍵盤分派只認 App.activeListSession（buf.listRenderOwner 決定
    // 是文章列表還是看板列表的 session）。
    activeListSession: () =>
      listRenderMode === "buffer" || listRenderMode === "frozen" ? listSession : null,
    endTurnsOnLiveUpdate: false,
  };
  view._keyboard = { onKeyDown: vi.fn((e) => seen.keyboard.push(e)) };
  view.flashListHint = vi.fn((m) => seen.hints.push(m));
  view.seen = seen;
  return view;
}

describe("合成事件的形狀", () => {
  test("是一個 key 正確的 keydown", () => {
    const view = makeView();
    view.sendKeyAsUser("ArrowLeft");
    expect(view.seen.keyboard).toHaveLength(1);
    expect(view.seen.keyboard[0].type).toBe("keydown");
    expect(view.seen.keyboard[0].key).toBe("ArrowLeft");
  });

  test("cancelable 必須是 true —— 整條鏈靠 defaultPrevented 判斷有沒有人接手", () => {
    const view = makeView({ listRenderMode: "buffer" });
    view.sendKeyAsUser("ArrowLeft");
    const e = view.seen.listSession[0];
    expect(e.cancelable).toBe(true);
    e.preventDefault();
    expect(e.defaultPrevented).toBe(true);
  });

  test("右方向鍵（開文章）走同一條路", () => {
    const view = makeView();
    view.sendKeyAsUser("ArrowRight");
    expect(view.seen.keyboard[0].key).toBe("ArrowRight");
  });
});

describe("上游接手時不得重複送鍵", () => {
  test("文章好讀接手 ⇒ 不落到 TermKeyboard", () => {
    const view = makeView({ useEasyReadingMode: true });
    view.bbscore.easyReading._onKeyDown = vi.fn((e) => e.preventDefault());
    view.sendKeyAsUser("ArrowLeft");
    expect(view._keyboard.onKeyDown).not.toHaveBeenCalled();
  });

  test("列表好讀接手 ⇒ 不落到 TermKeyboard（交易中途不可以裸送 byte）", () => {
    const view = makeView({ listRenderMode: "buffer" });
    view.bbscore.listSession.onKeyDown = vi.fn((e) => e.preventDefault());
    view.sendKeyAsUser("ArrowLeft");
    expect(view._keyboard.onKeyDown).not.toHaveBeenCalled();
  });
});

describe("分派去向", () => {
  test("列表好讀模式交給 ListSession，不自己送 byte", () => {
    const view = makeView({ listRenderMode: "buffer" });
    view.sendKeyAsUser("ArrowLeft");
    expect(view.bbscore.listSession.onKeyDown).toHaveBeenCalled();
  });

  test("原生模式落到 TermKeyboard（＝真的送 \x1b[D 給 PTT）", () => {
    const view = makeView();
    view.sendKeyAsUser("ArrowLeft");
    expect(view._keyboard.onKeyDown).toHaveBeenCalled();
  });

  test("序列化操作（AID 跳文）在途時吞掉並提示，不送鍵", () => {
    const view = makeView();
    view.bbscore.aidNavigation.active = true;
    view.sendKeyAsUser("ArrowLeft");
    expect(view._keyboard.onKeyDown).not.toHaveBeenCalled();
    expect(view.seen.hints).toHaveLength(1);
  });
});
