// App（純 JS）→ React 的橋接：pttchrome.openLongPushModal。
//
// 攔截推文鍵的三條入口都在非 React 的那一側（term_view / App），而長推文輸入框是
// ContextMenu 的 React state。橋接方式比照既有的 onToggleLiveHelperModalState：
// App.prototype 上預設 noop，ContextMenu 掛載時注入真實作、卸載時還原。
//
// 這裡守三件事：
//  1. 掛載後叫得動，而且**回 true**（呼叫端靠這個回傳值決定要不要吞掉按鍵）。
//     注意 true 的意思是「**我接手了這次按鍵**」——探路上線後，輸入框要等
//     onPreflight 回來才開，中間先蓋一層遮罩；
//  2. 沒開過右鍵選單也要算對 maxBytes（攔截這條沒有「開選單」那一刻）；
//  3. 卸載後還原成 noop ⇒ 回 falsy ⇒ 攔截自動退回原生推文；
//  4. 探路接不下來（線路上已經有別的序列化操作）⇒ 回 falsy ⇒ **不准吞掉按鍵**。
import { render, screen, act, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ContextMenu from "../../src/components/ContextMenu";
import { loadBig5Tables } from "./helpers/load_big5_tables";
import { setupI18n, i18n } from "../../src/js/i18n";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";
import { pushMaxBytes } from "../../src/js/long_push";
import {
  readDraft,
  writeDraft,
  resetDraftCacheForTests,
} from "../../src/js/long_push_draft";

vi.mock("../../src/js/pref_sync", () => ({
  savePrefs: vi.fn(),
  signIn: vi.fn(() => Promise.resolve()),
  signOut: vi.fn(() => Promise.resolve()),
  onAuthState: vi.fn(() => () => {}),
}));

const PREF_KEY = "pttchrome.pref.v1";
const AUTO_LOGIN_USER = "someuserid";

window.matchMedia =
  window.matchMedia ||
  (() => ({
    matches: false,
    media: "",
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
window.ResizeObserver =
  window.ResizeObserver ||
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
window.scrollTo = window.scrollTo || (() => {});
// Mantine 的 Textarea autosize 會掛在 document.fonts 上，jsdom 沒有 FontFaceSet
// ⇒ 不補會在 mount 就 throw（同 long_push_modal.test.jsx）。
if (!document.fonts)
  Object.defineProperty(document, "fonts", {
    value: { addEventListener() {}, removeEventListener() {} },
    configurable: true,
  });

const makePttchrome = () => ({
  buf: {
    pageState: 3,
    rows: 24,
    cols: 80,
    getRowText: () =>
      "  瀏覽 第 1/2 頁 ( 45%)  目前顯示: 第 1~23 行  (y)回應(X%)推文(h)說明(←)離開 ",
  },
  longPush: {
    start: vi.fn(),
    cancel: vi.fn(),
    // 探路：真的 session 會送一個 X 出去問 PTT，輸入框要等它的答案才開。
    startPreflight: vi.fn(() => true),
    disarm: vi.fn(),
  },
  doCopy: vi.fn(),
  imageUpload: { setInsertTarget: vi.fn(), clearInsertTarget: vi.fn() },
  setModalOpen: vi.fn(),
  contextMenuShown: false,
  // ContextMenu 掛載時會覆蓋這個，卸載時還原 —— 初值比照 App.prototype 的 noop。
  openLongPushModal: function noop() {},
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
  loadBig5Tables(); // 輸入框算則數要 u2b
  setupI18n();
});
beforeEach(() => {
  window.localStorage.clear();
  resetDraftCacheForTests();
});

// 探路回報「可以推」。真實路徑上這是 LongPushSession._preflightDone 打進來的。
const answerPreflight = (pttchrome, result) =>
  act(() => {
    pttchrome.longPush.onPreflight({ blocked: false, ...result });
  });

describe("pttchrome.openLongPushModal 橋接", () => {
  test("掛載後叫得動：先探路（還不開輸入框）、回 true、modalShown 由 render state 推導", async () => {
    const pttchrome = makePttchrome();
    mount(pttchrome);
    expect(screen.queryByText(i18n("longPushModal_title"))).toBeNull();

    let opened;
    act(() => {
      opened = pttchrome.openLongPushModal();
    });

    // 回傳值就是合約：呼叫端靠它決定要不要 preventDefault／不送 byte。
    expect(opened).toBe(true);
    expect(pttchrome.longPush.startPreflight).toHaveBeenCalled();
    // 還在問 PTT，輸入框不該出現——但畫面上要有東西（遮罩），不能什麼反應都沒有。
    expect(
      await screen.findByText(i18n("longPushProgress_preflight")),
    ).toBeTruthy();
    expect(screen.queryByText(i18n("longPushModal_title"))).toBeNull();
    // 遮罩與輸入框都要收鍵盤。**不可以**直接賦值 modalShown，一律走 setModalOpen。
    expect(pttchrome.setModalOpen).toHaveBeenCalledWith("contextMenu", true);

    answerPreflight(pttchrome, {});
    expect(await screen.findByText(i18n("longPushModal_title"))).toBeTruthy();
  });

  test("探路說不能推 → 開的是錯誤框，而且是 PTT 的原文", async () => {
    const pttchrome = makePttchrome();
    mount(pttchrome);
    act(() => {
      pttchrome.openLongPushModal();
    });
    act(() => {
      pttchrome.longPush.onPreflight({
        blocked: true,
        phase: "preflight",
        source: "ptt",
        message: "抱歉, 禁止推薦",
        sent: 0,
        rest: "",
      });
    });
    expect(await screen.findByTestId("longPushErrorMessage")).toHaveTextContent(
      "抱歉, 禁止推薦",
    );
    // 使用者不該對著一個推不出去的板打一大段字。
    expect(screen.queryByText(i18n("longPushModal_title"))).toBeNull();
  });

  test("探路接不下來（線路上有別的操作）→ 回 falsy，按鍵不准被吞掉", () => {
    const pttchrome = makePttchrome();
    pttchrome.longPush.startPreflight = vi.fn(() => false);
    mount(pttchrome);
    let opened;
    act(() => {
      opened = pttchrome.openLongPushModal();
    });
    expect(opened).toBeFalsy();
  });

  // 攔截這條沒有「開右鍵選單」那一刻，若沿用開選單時算好的值就會拿到 initialState
  // 的保守預設（帳號當 12 字），輸入框上的「將分成 N 則」明顯高估。
  test("沒開過右鍵選單也算得出 maxBytes（用自動登入帳號）", async () => {
    const pttchrome = makePttchrome();
    mount(pttchrome);
    act(() => {
      pttchrome.openLongPushModal();
    });
    answerPreflight(pttchrome, {});
    await screen.findByText(i18n("longPushModal_title"));

    const expected = pushMaxBytes({ userId: AUTO_LOGIN_USER });
    expect(expected).not.toBe(pushMaxBytes({})); // 保守預設與真值要真的不同
    // 剛好塞滿一則的內容不得被算成兩則（沿用保守預設就會）。
    const textarea = document.querySelector('[name="longPushText"]');
    fireEvent.change(textarea, { target: { value: "a".repeat(expected) } });
    expect(screen.getByTestId("longPushSegments").textContent).toContain("1");
    fireEvent.change(textarea, { target: { value: "a".repeat(expected + 1) } });
    expect(screen.getByTestId("longPushSegments").textContent).toContain("2");
  });

  test("卸載後還原成 noop → 回 falsy，攔截自動退回原生推文", () => {
    const pttchrome = makePttchrome();
    const { unmount } = mount(pttchrome);
    unmount();
    expect(pttchrome.openLongPushModal()).toBeFalsy();
  });
});

// onSent 與既有的 onChange／onPreflight／onResult 是同一組：掛載時注入、卸載時歸
// null。它的消費者是草稿清除，漏掉 cleanup 就是「元件早就卸了，session 還在打
// 一個指向舊 closure 的 callback」。
describe("longPush.onSent 的掛接", () => {
  test("掛載後是函式，呼叫會把草稿清掉", () => {
    const pttchrome = makePttchrome();
    writeDraft("送完就該清掉的內容");
    mount(pttchrome);
    expect(typeof pttchrome.longPush.onSent).toBe("function");
    act(() => pttchrome.longPush.onSent());
    expect(readDraft()).toBe("");
  });

  test("卸載後歸 null（與 onChange／onPreflight／onResult 同組）", () => {
    const pttchrome = makePttchrome();
    const { unmount } = mount(pttchrome);
    unmount();
    expect(pttchrome.longPush.onSent).toBe(null);
    expect(pttchrome.longPush.onChange).toBe(null);
    expect(pttchrome.longPush.onPreflight).toBe(null);
    expect(pttchrome.longPush.onResult).toBe(null);
  });
});
