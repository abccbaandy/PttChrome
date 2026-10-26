// @unit-env browser
// 長推文送到一半失敗時「改成只送剩下的」（P43，docs/long-push.md 不變量 14）。鎖：
//  1. 錯誤框只在「已經送出幾則、而且還有剩」時給這顆；一則都沒送（草稿本來就是整段）不給。
//  2. 按了才換草稿：錯誤框出現當下草稿還是整段原文（不自動改寫）。
//  3. 按了 ⇒ 草稿＝剩餘內容、走同一條入口重開（探路），錯誤框收掉；探路回來開框，內容就是剩下的。
//  4. 接不下來（線路上有別的序列化操作）⇒ 錯誤框留著、閃提示。
import { render, screen, act, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ContextMenu from "../../src/components/ContextMenu";
import LongPushErrorModal from "../../src/components/ContextMenu/LongPushErrorModal";
// ContextMenu 以 React.lazy 載長推文輸入框：先在檔案層級載好（冷載入不算進 case 的時間）。
import "../../src/components/ContextMenu/LongPushModal";
import { loadBig5Tables } from "./helpers/load_big5_tables";
import { setupI18n, i18n } from "../../src/js/i18n";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";
import { pushMaxBytes } from "../../src/js/long_push";
import { readDraft, writeDraft, resetDraftCacheForTests } from "../../src/js/long_push_draft";

vi.mock("../../src/js/pref_sync", () => ({
  savePrefs: vi.fn(),
  signIn: vi.fn(() => Promise.resolve()),
  signOut: vi.fn(() => Promise.resolve()),
  onAuthState: vi.fn(() => () => {}),
}));

const PREF_KEY = "pttchrome.pref.v1";
const AUTO_LOGIN_USER = "someuserid";
const MAX = pushMaxBytes({ userId: AUTO_LOGIN_USER });
const FULL = "第一段已經推出去了 第二段還沒送";
const REST = "第二段還沒送";
const FAILED = {
  blocked: true,
  phase: "sending",
  source: "ptt",
  message: "抱歉, 禁止推薦",
  sent: 1,
  rest: REST,
};

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
    JSON.stringify({ values: { ...DEFAULT_PREFS, autoLoginUser: AUTO_LOGIN_USER } }),
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

const resumeBtn = () => screen.queryByTestId("longPushResumeRest");

describe("錯誤框的按鈕", () => {
  const renderModal = (error) => {
    const onResumeRest = vi.fn();
    const onCopy = vi.fn();
    render(
      <MantineProvider>
        <LongPushErrorModal error={error} onHide={vi.fn()} onCopy={onCopy} onResumeRest={onResumeRest} />
      </MantineProvider>,
    );
    return { onResumeRest, onCopy };
  };

  test("送了幾則、還有剩 ⇒ 有這顆，按了交出剩餘內容（不走複製）", () => {
    const { onResumeRest, onCopy } = renderModal(FAILED);
    expect(resumeBtn().textContent).toBe(i18n("longPushError_resumeRest"));
    fireEvent.click(resumeBtn());
    expect(onResumeRest).toHaveBeenCalledWith(REST);
    expect(onCopy).not.toHaveBeenCalled();
  });

  test.each([
    ["一則都還沒送（草稿本來就是整段）", { ...FAILED, sent: 0, rest: FULL }],
    ["沒有剩", { ...FAILED, rest: "" }],
  ])("%s ⇒ 沒有這顆", (_l, error) => {
    renderModal(error);
    expect(resumeBtn()).toBeNull();
  });
});

describe("ContextMenu 接線", () => {
  const fail = (pttchrome) => act(() => pttchrome.longPush.onResult(FAILED));

  test("錯誤框出現時草稿不動；按了才換成剩下的、重開探路、錯誤框收掉；開框內容就是剩下的", async () => {
    const pttchrome = makePttchrome();
    mount(pttchrome);
    writeDraft(FULL);
    fail(pttchrome);
    expect(await screen.findByTestId("longPushResumeRest")).toBeTruthy();
    expect(readDraft()).toBe(FULL);

    fireEvent.click(resumeBtn());
    expect(readDraft()).toBe(REST);
    expect(pttchrome.longPush.startPreflight).toHaveBeenCalledTimes(1);
    expect(resumeBtn()).toBeNull();

    act(() => pttchrome.longPush.onPreflight({ blocked: false, maxBytes: MAX, booAllowed: true }));
    expect(await screen.findByText(i18n("longPushModal_title"))).toBeTruthy();
    expect(document.querySelector('[name="longPushText"]').value).toBe(REST);
    // 只開框，送不送由使用者決定。
    expect(pttchrome.longPush.start).not.toHaveBeenCalled();
  });

  test("接不下來 ⇒ 錯誤框留著、閃提示", async () => {
    const pttchrome = makePttchrome();
    pttchrome.longPush.startPreflight = vi.fn(() => false);
    mount(pttchrome);
    fail(pttchrome);
    fireEvent.click(await screen.findByTestId("longPushResumeRest"));
    expect(pttchrome.view.flashListHint).toHaveBeenCalled();
    expect(resumeBtn()).toBeTruthy();
  });
});
