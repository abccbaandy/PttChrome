// @unit-env browser
// 底部推文列 → ContextMenu 的送出橋接：pttchrome.openQuickPush（docs/long-push.md
// 「底部常駐推文列」）。鎖：
//  1. 回 true ＝接手了；內容先寫進草稿（退回輸入框／送到一半失敗都救得回來）；
//  2. 探路回來沒有要使用者看一眼的事 ⇒ 直接 session.start，**不開輸入框**，遮罩不閃；
//  3. 該看一眼（PTT 改成 →、禁噓板選噓…）⇒ 開長推文輸入框，內容就是剛打的；
//  4. 探路接不下來 ⇒ 回 false（列上的字不准清掉）；
//  5. 卸載後還原成 noop。
import { render, screen, act } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ContextMenu from "../../src/components/ContextMenu";
// ContextMenu 以 React.lazy 載長推文輸入框：先在檔案層級載好，否則第一條開輸入框的 case
// 要在 findByText 的 1000ms 內付冷載入（整批 unit 吃滿 CPU 時量過 >1s，偶發紅）。
import "../../src/components/ContextMenu/LongPushModal";
import { loadBig5Tables } from "./helpers/load_big5_tables";
import { setupI18n, i18n } from "../../src/js/i18n";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";
import { pushMaxBytes } from "../../src/js/long_push";
import { readDraft, resetDraftCacheForTests } from "../../src/js/long_push_draft";

vi.mock("../../src/js/pref_sync", () => ({
  savePrefs: vi.fn(),
  signIn: vi.fn(() => Promise.resolve()),
  signOut: vi.fn(() => Promise.resolve()),
  onAuthState: vi.fn(() => () => {}),
}));

const PREF_KEY = "pttchrome.pref.v1";
const AUTO_LOGIN_USER = "someuserid";
const MAX = pushMaxBytes({ userId: AUTO_LOGIN_USER });

const makePttchrome = () => ({
  buf: {
    pageState: 3,
    rows: 24,
    cols: 80,
    getRowText: () =>
      "  瀏覽 第 1/2 頁 ( 45%)  目前顯示: 第 1~23 行  (y)回應(X%)推文(h)說明(←)離開 ",
  },
  longPush: {
    start: vi.fn(() => true),
    cancel: vi.fn(),
    startPreflight: vi.fn(() => true),
    disarm: vi.fn(),
  },
  view: { flashListHint: vi.fn() },
  doCopy: vi.fn(),
  imageUpload: { setInsertTarget: vi.fn(), clearInsertTarget: vi.fn() },
  setModalOpen: vi.fn(),
  onDebugRecordDownloaded: () => () => {},
  contextMenuShown: false,
  openLongPushModal: function noop() {},
  openQuickPush: function noop() {},
});

const mount = (pttchrome) => {
  document.body.innerHTML = '<div id="BBSWindow"></div>';
  window.localStorage.setItem(
    PREF_KEY,
    JSON.stringify({
      values: { ...DEFAULT_PREFS, autoLoginUser: AUTO_LOGIN_USER },
    }),
  );
  return render(
    <MantineProvider>
      <ContextMenu pttchrome={pttchrome} />
    </MantineProvider>,
  );
};

beforeAll(() => {
  loadBig5Tables();
  setupI18n();
});
beforeEach(() => {
  window.localStorage.clear();
  resetDraftCacheForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

const quick = (pttchrome, text, type) => {
  let r;
  act(() => {
    r = pttchrome.openQuickPush({ text, type });
  });
  return r;
};
const answerPreflight = (pttchrome, result) =>
  act(() => {
    pttchrome.longPush.onPreflight({ blocked: false, maxBytes: MAX, booAllowed: true, ...result });
  });

describe("pttchrome.openQuickPush（底部推文列送出）", () => {
  test("一般推文：回 true、先寫草稿、探路回來直接 start，不開輸入框", async () => {
    vi.useFakeTimers();
    const pttchrome = makePttchrome();
    mount(pttchrome);
    pttchrome.setModalOpen.mockClear(); // 掛載時的初值 false 不算
    expect(quick(pttchrome, "推推", "boo")).toBe(true);
    expect(readDraft()).toBe("推推");
    expect(pttchrome.longPush.startPreflight).toHaveBeenCalled();

    answerPreflight(pttchrome, {});
    // start 不在 onPreflight 裡同步重入（那一刻還在 session 的 _preflightDone 裡）。
    expect(pttchrome.longPush.start).not.toHaveBeenCalled();
    act(() => vi.runAllTimers());
    expect(pttchrome.longPush.start).toHaveBeenCalledWith({ text: "推推", type: "boo", maxBytes: MAX });
    expect(screen.queryByText(i18n("longPushModal_title"))).toBeNull();
    // 探路遮罩直接接到送出進度：modal 來源從頭到尾沒有掉成 false。
    const calls = pttchrome.setModalOpen.mock.calls.filter((c) => c[0] === "contextMenu");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c[1] === true)).toBe(true);
  });

  // 回歸：90 秒內連推第二則（PTT 回「時間太近, 使用 → 加註方式」）時跳出長推文輸入框。
  test("PTT 會改成 →（90 秒內連推／作者本人）⇒ 照樣直接 start，不開輸入框", () => {
    vi.useFakeTimers();
    const pttchrome = makePttchrome();
    mount(pttchrome);
    quick(pttchrome, "推推", "push");
    answerPreflight(pttchrome, { degraded: true, userId: "testuser" });
    act(() => vi.runAllTimers());
    expect(pttchrome.longPush.start).toHaveBeenCalledWith({ text: "推推", type: "push", maxBytes: MAX });
    expect(screen.queryByText(i18n("longPushModal_title"))).toBeNull();
  });

  test.each([
    ["禁噓板選了噓", { booAllowed: false }, "不推", "boo"],
  ])("%s ⇒ 不直接送，開長推文輸入框且內容就是剛打的", async (_l, result, text, type) => {
    const pttchrome = makePttchrome();
    mount(pttchrome);
    quick(pttchrome, text, type);
    answerPreflight(pttchrome, result);
    expect(await screen.findByText(i18n("longPushModal_title"))).toBeTruthy();
    expect(document.querySelector('[name="longPushText"]').value).toBe(text);
    expect(pttchrome.longPush.start).not.toHaveBeenCalled();
  });

  test("探路接不下來 ⇒ 回 false、閃提示，列上的字留著", () => {
    const pttchrome = makePttchrome();
    pttchrome.longPush.startPreflight = vi.fn(() => false);
    mount(pttchrome);
    expect(quick(pttchrome, "推推", "push")).toBe(false);
    expect(pttchrome.view.flashListHint).toHaveBeenCalled();
  });

  test("下一次一般的 X 探路不會被上一則快速推文誤當成直接送", async () => {
    const pttchrome = makePttchrome();
    pttchrome.longPush.startPreflight = vi.fn(() => false);
    mount(pttchrome);
    quick(pttchrome, "推推", "push"); // 沒接手 ⇒ 不可留下待送
    pttchrome.longPush.startPreflight = vi.fn(() => true);
    act(() => {
      pttchrome.openLongPushModal();
    });
    answerPreflight(pttchrome, {});
    expect(await screen.findByText(i18n("longPushModal_title"))).toBeTruthy();
    expect(pttchrome.longPush.start).not.toHaveBeenCalled();
  });

  test("只有空白 ⇒ 回 false，不探路", () => {
    const pttchrome = makePttchrome();
    mount(pttchrome);
    expect(quick(pttchrome, "   ", "push")).toBe(false);
    expect(pttchrome.longPush.startPreflight).not.toHaveBeenCalled();
  });

  test("卸載後還原成 noop", () => {
    const pttchrome = makePttchrome();
    const { unmount } = mount(pttchrome);
    unmount();
    expect(pttchrome.openQuickPush({ text: "推推" })).toBeFalsy();
  });
});
