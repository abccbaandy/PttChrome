// @unit-env browser
// 沒寫看板的 #AID → 二選一彈窗 → 本版跳轉／搜尋彈窗挑看板（ContextMenu 整合）。
//
// 守的行為：
//  1. pttchrome.openAidBoardChoice 掛載後回 true（App.onAidClick 靠它決定不直接跳）；
//  2. 「本版」＝以目前文章看板跑 AID 跳轉；看板判不出來時停用；
//  3. 「其他看板」＝原樣的 `s` 看板搜尋彈窗：背景開原生 `s` prompt 做即時補全
//     （使用者回報：少了它就打不出正確板名）；開之前先 preparePicked 記返回錨；
//     在 prompt 上送出進板、落地後才 continuePicked 接手 #AID；
//  4. 板名記進看板種類的搜尋記憶，下次可直接點。
// 橋接是真的 BoardSearchBridge，佇列是假的：逐條取出它排進來的命令手動完成。
import {
  render,
  screen,
  act,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import ContextMenu from "../../src/components/ContextMenu";
import { setupI18n, i18n } from "../../src/js/i18n";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";
import { readSearchHistory } from "../../src/js/search_history";

vi.mock("../../src/js/pref_sync", () => ({
  savePrefs: vi.fn(),
  signIn: vi.fn(() => Promise.resolve()),
  signOut: vi.fn(() => Promise.resolve()),
  onAuthState: vi.fn(() => () => {}),
}));

const PREF_KEY = "pttchrome.pref.v1";
const AID = "1abcdEFG";

const makePttchrome = () => ({
  buf: {
    pageState: 3,
    rows: 24,
    cols: 80,
    startedEasyReading: true,
    getRowText: () => "",
  },
  view: { flashListHint: vi.fn() },
  aidNavigation: {
    active: false,
    start: vi.fn(),
    preparePicked: vi.fn((aid) => ({ aid, prepared: true })),
    continuePicked: vi.fn(() => true),
    reopenPicked: vi.fn(() => true),
    endPicked: vi.fn(),
  },
  commandQueue: { enqueue: vi.fn() },
  searchInFlight: false,
  longPush: { start: vi.fn(), cancel: vi.fn(), disarm: vi.fn() },
  imageUpload: { setInsertTarget: vi.fn(), clearInsertTarget: vi.fn() },
  setModalOpen: vi.fn(),
  onDebugRecordDownloaded: () => () => {},
  contextMenuShown: false,
  openAidBoardChoice: function noop() {},
});

const mount = (pttchrome) => {
  document.body.innerHTML = '<div id="BBSWindow"></div>';
  window.localStorage.setItem(
    PREF_KEY,
    JSON.stringify({ values: { ...DEFAULT_PREFS } }),
  );
  return render(
    <MantineProvider>
      <ContextMenu pttchrome={pttchrome} />
    </MantineProvider>,
  );
};

const open = (pttchrome, currentBoard) => {
  let opened;
  act(() => {
    opened = pttchrome.openAidBoardChoice(AID, currentBoard);
  });
  return opened;
};

const choiceButton = (which) =>
  document.querySelector(`[data-aid-choice="${which}"]`);

beforeAll(() => setupI18n());
beforeEach(() => window.localStorage.clear());

test("掛載後接手（回 true）、算 modal；卸載後還原成 noop", async () => {
  const pttchrome = makePttchrome();
  const { unmount } = mount(pttchrome);
  expect(open(pttchrome, "ask")).toBe(true);
  expect(
    await screen.findByText(i18n("aidBoardChoice_title").replace("{0}", "#" + AID)),
  ).toBeTruthy();
  expect(pttchrome.setModalOpen).toHaveBeenCalledWith("contextMenu", true);
  unmount();
  expect(pttchrome.openAidBoardChoice()).toBeFalsy();
});

test("本版跳轉 ⇒ 以目前文章的看板跑 AID 跳轉", async () => {
  const pttchrome = makePttchrome();
  mount(pttchrome);
  open(pttchrome, "ask");
  await screen.findByText(i18n("aidBoardChoice_current").replace("{0}", "ask"));
  fireEvent.click(choiceButton("current"));
  expect(pttchrome.aidNavigation.start).toHaveBeenCalledWith(AID, "ask");
});

test("目前看板判不出來 ⇒「本版」停用，只能挑看板", async () => {
  const pttchrome = makePttchrome();
  mount(pttchrome);
  open(pttchrome, null);
  await screen.findByText(i18n("aidBoardChoice_currentUnknown"));
  expect(choiceButton("current")).toBeDisabled();
  expect(choiceButton("pick")).not.toBeDisabled();
});

// 假佇列裡排到的第 n 條命令（真橋接排進來的）。
const queued = (pttchrome, kind) =>
  pttchrome.commandQueue.enqueue.mock.calls
    .map((c) => c[0])
    .filter((c) => c.kind === kind);

const openPicker = async (pttchrome) => {
  open(pttchrome, "ask");
  await screen.findByText(i18n("aidBoardChoice_pick"));
  fireEvent.click(choiceButton("pick"));
  expect(
    await screen.findByText(
      i18n("aidBoardChoice_pickTitle").replace("{0}", "#" + AID),
    ),
  ).toBeTruthy();
  return document.querySelector('input[name="searchKeyword"]');
};

test("其他看板 ⇒ 先記返回錨，再開原生 `s` 補全（同一般看板搜尋）", async () => {
  const pttchrome = makePttchrome();
  mount(pttchrome);
  await openPicker(pttchrome);
  expect(pttchrome.aidNavigation.preparePicked).toHaveBeenCalledWith(AID);
  const openCmd = queued(pttchrome, "search-board-open");
  expect(openCmd).toHaveLength(1);
  expect(openCmd[0].keys).toBe("s");
  // 記返回錨在送 `s` 之前（送出 `s` 的瞬間就離開文章）。
  expect(
    pttchrome.aidNavigation.preparePicked.mock.invocationCallOrder[0],
  ).toBeLessThan(pttchrome.commandQueue.enqueue.mock.invocationCallOrder[0]);
});

test("PTT 補全回來的板名可直接點；進板落地後才接手 #AID", async () => {
  const pttchrome = makePttchrome();
  mount(pttchrome);
  const input = await openPicker(pttchrome);
  act(() =>
    queued(pttchrome, "search-board-open")[0].onDone({
      field: "",
      candidates: null,
      more: false,
    }),
  );
  fireEvent.change(input, { target: { value: "c_c" } });
  const sync = queued(pttchrome, "search-board-sync").pop();
  sync.onSend();
  expect(sync.keys).toBe("c_c ");
  act(() =>
    sync.onDone({ field: "C_Chat", candidates: ["C_Chat"], more: false }),
  );
  const pick = await waitFor(() => {
    const el = document.querySelector('[data-board-candidate="C_Chat"]');
    expect(el).not.toBeNull();
    return el;
  });
  fireEvent.click(pick);

  const submit = queued(pttchrome, "search-board-submit");
  expect(submit).toHaveLength(1);
  submit[0].onSend();
  expect(submit[0].keys).toMatch(/C_Chat\r$/);
  // 還沒落地前不接手。
  expect(pttchrome.aidNavigation.continuePicked).not.toHaveBeenCalled();
  act(() => submit[0].onDone(true));
  expect(pttchrome.aidNavigation.continuePicked).toHaveBeenCalledWith(
    { aid: AID, prepared: true },
    "C_Chat",
  );
  expect(pttchrome.aidNavigation.start).not.toHaveBeenCalled();
  expect(readSearchHistory().board).toEqual(["C_Chat"]);
});

test("prompt 根本沒開出來（人還在文章裡）⇒ 退回一般 AID 跳轉", async () => {
  const pttchrome = makePttchrome();
  mount(pttchrome);
  const input = await openPicker(pttchrome);
  act(() => queued(pttchrome, "search-board-open")[0].onFail());
  fireEvent.change(input, { target: { value: "C_Chat" } });
  fireEvent.submit(input.closest("form"));
  expect(pttchrome.aidNavigation.start).toHaveBeenCalledWith(AID, "C_Chat");
  expect(pttchrome.aidNavigation.continuePicked).not.toHaveBeenCalled();
  // 人還在原文：挑板結束、返回堆疊保留。
  expect(pttchrome.aidNavigation.endPicked).toHaveBeenCalledWith(
    { aid: AID, prepared: true },
    true,
  );
  expect(pttchrome.aidNavigation.reopenPicked).not.toHaveBeenCalled();
});

test("取消（Esc）⇒ Ctrl-C 收掉 prompt，收完才重開原文（回原位）", async () => {
  const pttchrome = makePttchrome();
  mount(pttchrome);
  const input = await openPicker(pttchrome);
  act(() =>
    queued(pttchrome, "search-board-open")[0].onDone({
      field: "",
      candidates: null,
      more: false,
    }),
  );
  fireEvent.keyDown(input, { key: "Escape" });
  await waitFor(() =>
    expect(queued(pttchrome, "search-board-cancel")).toHaveLength(1),
  );
  const cancel = queued(pttchrome, "search-board-cancel")[0];
  cancel.onSend();
  expect(cancel.keys).toBe("\x03");
  expect(pttchrome.aidNavigation.reopenPicked).not.toHaveBeenCalled();
  act(() => cancel.onDone(true));
  expect(pttchrome.aidNavigation.reopenPicked).toHaveBeenCalledWith({
    aid: AID,
    prepared: true,
  });
  expect(pttchrome.aidNavigation.continuePicked).not.toHaveBeenCalled();
});

test("一般 `s` 看板搜尋的取消不會去重開文章", async () => {
  const pttchrome = makePttchrome();
  pttchrome.buf.getRowText = (r) =>
    r === 0 ? "【主功能表】                                 批踢踢實業坊" : "";
  mount(pttchrome);
  let opened;
  act(() => {
    opened = pttchrome.openSearchModal("board");
  });
  expect(opened).toBe(true);
  const input = await waitFor(() => {
    const el = document.querySelector('input[name="searchKeyword"]');
    expect(el).not.toBeNull();
    return el;
  });
  act(() =>
    queued(pttchrome, "search-board-open")[0].onDone({
      field: "",
      candidates: null,
      more: false,
    }),
  );
  fireEvent.keyDown(input, { key: "Escape" });
  await waitFor(() =>
    expect(queued(pttchrome, "search-board-cancel")).toHaveLength(1),
  );
  act(() => queued(pttchrome, "search-board-cancel")[0].onDone(true));
  expect(pttchrome.aidNavigation.reopenPicked).not.toHaveBeenCalled();
});

test("記不了返回錨（另一趟在跑）⇒ 不開搜尋彈窗、不送 `s`", async () => {
  const pttchrome = makePttchrome();
  pttchrome.aidNavigation.preparePicked = vi.fn(() => null);
  mount(pttchrome);
  open(pttchrome, "ask");
  await screen.findByText(i18n("aidBoardChoice_pick"));
  fireEvent.click(choiceButton("pick"));
  expect(pttchrome.commandQueue.enqueue).not.toHaveBeenCalled();
  expect(pttchrome.view.flashListHint).toHaveBeenCalled();
});
