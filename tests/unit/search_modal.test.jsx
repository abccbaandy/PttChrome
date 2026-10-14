// @unit-env browser
// 搜尋彈窗（src/components/ContextMenu/SearchModal.jsx）。
//
// 守的是使用者要的那個操作：**↑ 叫回之前用過的關鍵字**（PTT 原生的那份被跳號污染），
// 以及手機上沒有方向鍵時可以直接點最近的關鍵字。
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import SearchModal from "../../src/components/ContextMenu/SearchModal";
// 標籤一律經 i18n 取：CI 是英文語系，寫死中文字面在那裡找不到。
import { setupI18n, i18n } from "../../src/js/i18n";
import { rememberSearch, readSearchHistory } from "../../src/js/search_history";

beforeAll(() => {
  setupI18n();
});
beforeEach(() => {
  localStorage.clear();
});

const renderModal = (props = {}) => {
  const onConfirm = props.onConfirm || vi.fn();
  const onHide = props.onHide || vi.fn();
  render(
    <MantineProvider>
      <SearchModal
        show
        kind={props.kind || "title"}
        kinds={props.kinds || ["title", "author", "push", "board"]}
        onHide={onHide}
        onConfirm={onConfirm}
        createBoardSearch={props.createBoardSearch}
        mobile={props.mobile}
      />
    </MantineProvider>,
  );
  const input = document.querySelector('input[name="searchKeyword"]');
  return { onConfirm, onHide, input };
};

test("↑ 從最新的開始往舊的叫，↓ 回到自己打到一半的字", () => {
  rememberSearch("title", "舊的");
  rememberSearch("title", "新的");
  const { input } = renderModal();
  fireEvent.change(input, { target: { value: "草稿" } });
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(input.value).toBe("新的");
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(input.value).toBe("舊的");
  fireEvent.keyDown(input, { key: "ArrowUp" }); // 到底了停在最舊
  expect(input.value).toBe("舊的");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input.value).toBe("草稿");
});

test("記憶分種類：作者的 ↑ 不會叫出標題關鍵字", () => {
  rememberSearch("title", "標題字");
  rememberSearch("author", "someone");
  const { input } = renderModal({ kind: "author" });
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(input.value).toBe("someone");
});

test("Enter 送出 {kind, text}", () => {
  const { input, onConfirm } = renderModal({ kind: "author" });
  fireEvent.change(input, { target: { value: "testuser" } });
  fireEvent.submit(input.closest("form"));
  expect(onConfirm).toHaveBeenCalledWith({ kind: "author", text: "testuser" });
});

test("最近的關鍵字可以直接點（手機沒有方向鍵）", () => {
  rememberSearch("title", "問卦");
  const { onConfirm } = renderModal();
  fireEvent.click(document.querySelector('[data-search-recent-item="問卦"]'));
  expect(onConfirm).toHaveBeenCalledWith({ kind: "title", text: "問卦" });
});

test("× 刪掉一筆：清單與 ↑ 都不再出現它，也不會送出", () => {
  rememberSearch("title", "舊的");
  rememberSearch("title", "新的");
  const { input, onConfirm } = renderModal();
  fireEvent.click(document.querySelector('[data-search-forget="新的"]'));
  expect(onConfirm).not.toHaveBeenCalled();
  expect(document.querySelector('[data-search-recent-item="新的"]')).toBeNull();
  expect(readSearchHistory().title).toEqual(["舊的"]);
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(input.value).toBe("舊的");
});

test("全部清除：只清目前這一類", () => {
  rememberSearch("title", "t1");
  rememberSearch("author", "someone");
  renderModal();
  fireEvent.click(document.querySelector("[data-search-forget-all]"));
  expect(document.querySelector("[data-search-recent]")).toBeNull();
  expect(readSearchHistory().title).toEqual([]);
  expect(readSearchHistory().author).toEqual(["someone"]);
});

test("推文數不是非零整數 ⇒ 不送出", () => {
  const { input, onConfirm } = renderModal({ kind: "push" });
  fireEvent.change(input, { target: { value: "0" } });
  fireEvent.submit(input.closest("form"));
  fireEvent.change(input, { target: { value: "abc" } });
  fireEvent.submit(input.closest("form"));
  expect(onConfirm).not.toHaveBeenCalled();
});

test("切換種類：送出的是切換後的種類", () => {
  const { input, onConfirm } = renderModal();
  fireEvent.click(screen.getByText(i18n("searchModal_kindBoard")));
  fireEvent.change(input, { target: { value: "C_Chat" } });
  fireEvent.submit(input.closest("form"));
  expect(onConfirm).toHaveBeenCalledWith({ kind: "board", text: "C_Chat" });
});

test("只有一個可用種類時不畫切換列", () => {
  renderModal({ kind: "board", kinds: ["board"] });
  expect(screen.queryByText(i18n("searchModal_kindTitle"))).toBeNull();
});

// ---- 看板：比照 PTT 原生補全（board_search_bridge.js；這裡用假橋接驅動結論）----
// 使用者回報：彈窗的看板搜尋只是普通輸入框；原生會提示後續關鍵字，沒有 bbb 這個
// 看板就打不進 bbb。
function fakeBoardSearch() {
  const made = [];
  const factory = (onUpdate) => {
    const b = {
      status: "ready",
      result: null,
      query: vi.fn(),
      submit: vi.fn(() => true),
      cancel: vi.fn(),
      setStatus(status) {
        b.status = status;
        act(() => onUpdate({ status: b.status, result: b.result }));
      },
      answer(result) {
        b.result = {
          rejected: false,
          more: false,
          accepted: result.query.length,
          ...result,
        };
        act(() => onUpdate({ status: b.status, result: b.result }));
      },
    };
    made.push(b);
    return b;
  };
  factory.made = made;
  return factory;
}

test("看板：打字即向 PTT 查，被拒的字退回並提示（沒有 bbb 就打不進 bbb）", () => {
  const createBoardSearch = fakeBoardSearch();
  const { input } = renderModal({
    kind: "board",
    kinds: ["board"],
    createBoardSearch,
  });
  const bridge = createBoardSearch.made[0];
  fireEvent.change(input, { target: { value: "bbb" } });
  expect(bridge.query).toHaveBeenLastCalledWith("bbb");
  bridge.answer({
    query: "bbb",
    accepted: 2,
    rejected: true,
    completion: "bbb",
    candidates: [],
  });
  expect(input.value).toBe("bb");
  expect(document.querySelector("[data-board-status]").textContent).toBe(
    i18n("searchModal_boardNoMatch").replace("{0}", "bbb"),
  );
  expect(bridge.query).toHaveBeenLastCalledWith("bb");
});

test("看板：列出 PTT 的補全清單，點一個就送出那個板", () => {
  const createBoardSearch = fakeBoardSearch();
  const { input, onConfirm } = renderModal({
    kind: "board",
    kinds: ["board"],
    createBoardSearch,
  });
  const bridge = createBoardSearch.made[0];
  fireEvent.change(input, { target: { value: "go" } });
  bridge.answer({
    query: "go",
    completion: "go",
    candidates: ["GO", "Golf", "Gossiping"],
    more: true,
  });
  expect(document.querySelector("[data-board-more]")).not.toBeNull();
  fireEvent.click(document.querySelector('[data-board-candidate="Golf"]'));
  expect(onConfirm).toHaveBeenCalledWith({
    kind: "board",
    text: "Golf",
    bridge,
  });
});

test("看板：空白鍵自動完成到 PTT 延伸出的字", () => {
  const createBoardSearch = fakeBoardSearch();
  const { input } = renderModal({
    kind: "board",
    kinds: ["board"],
    createBoardSearch,
  });
  const bridge = createBoardSearch.made[0];
  fireEvent.change(input, { target: { value: "goss" } });
  bridge.answer({
    query: "goss",
    completion: "Gossiping",
    candidates: ["Gossiping"],
  });
  fireEvent.change(input, { target: { value: "goss " } });
  expect(input.value).toBe("Gossiping");
});

test("看板：多個符合時擋下送出；唯一符合時送出完整板名", () => {
  const createBoardSearch = fakeBoardSearch();
  const { input, onConfirm } = renderModal({
    kind: "board",
    kinds: ["board"],
    createBoardSearch,
  });
  const bridge = createBoardSearch.made[0];
  fireEvent.change(input, { target: { value: "gol" } });
  bridge.answer({
    query: "gol",
    completion: "gol",
    candidates: ["Golf", "Golfer"],
  });
  fireEvent.submit(input.closest("form"));
  expect(onConfirm).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "goss" } });
  bridge.answer({
    query: "goss",
    completion: "Gossiping",
    candidates: ["Gossiping"],
  });
  fireEvent.submit(input.closest("form"));
  expect(onConfirm).toHaveBeenCalledWith({
    kind: "board",
    text: "Gossiping",
    bridge,
  });
});

test("看板：切到別的種類就取消背景的看板 prompt", () => {
  const createBoardSearch = fakeBoardSearch();
  renderModal({ kind: "board", createBoardSearch });
  const bridge = createBoardSearch.made[0];
  fireEvent.click(screen.getByText(i18n("searchModal_kindTitle")));
  expect(bridge.cancel).toHaveBeenCalled();
});

// ---- 看板補全區的版面 ----
// 使用者回報：按 s 叫出的看板搜尋會依清單長短改變大小，邊打字視窗邊抖。手機 sheet 貼底、
// 桌機原本置中 ⇒ 高度一變輸入框就被推動。守的是「打字過程中表單高度不變」。
const BOARD_NAMES = Array.from({ length: 60 }, (_, i) => "Go" + i);
for (const mobile of [false, true]) {
  test(`看板補全區高度固定：開啟中／查詢中／多筆／少筆／被拒／無清單，表單一樣高（${mobile ? "手機" : "桌機"}）`, () => {
    const createBoardSearch = fakeBoardSearch();
    const { input } = renderModal({
      kind: "board",
      kinds: ["board"],
      createBoardSearch,
      mobile,
    });
    const bridge = createBoardSearch.made[0];
    const form = () => document.querySelector("[data-search-modal]");
    const heights = [];
    const snap = (label) =>
      heights.push([label, Math.round(form().getBoundingClientRect().height)]);
    bridge.setStatus("opening");
    snap("opening");
    bridge.setStatus("ready");
    snap("ready, empty");
    fireEvent.change(input, { target: { value: "go" } });
    snap("pending");
    bridge.answer({
      query: "go",
      completion: "go",
      candidates: BOARD_NAMES,
      more: true,
    });
    snap("many + more");
    fireEvent.change(input, { target: { value: "gol" } });
    snap("interim");
    bridge.answer({
      query: "gol",
      completion: "gol",
      candidates: ["Golf", "Golfer"],
    });
    snap("ambiguous, few");
    fireEvent.change(input, { target: { value: "golx" } });
    bridge.answer({
      query: "golx",
      accepted: 3,
      rejected: true,
      completion: "golx",
      candidates: [],
    });
    snap("rejected");
    expect(heights[0][1]).toBeGreaterThan(0);
    for (const [label, h] of heights)
      expect([label, h]).toEqual([label, heights[0][1]]);
  });
}

test("看板：查詢在飛時先顯示上一份清單篩過的結果（不先清空），回來後換成 PTT 的", () => {
  const createBoardSearch = fakeBoardSearch();
  const { input } = renderModal({
    kind: "board",
    kinds: ["board"],
    createBoardSearch,
  });
  const bridge = createBoardSearch.made[0];
  const shown = () =>
    [...document.querySelectorAll("[data-board-candidate]")].map(
      (e) => e.dataset.boardCandidate,
    );
  fireEvent.change(input, { target: { value: "go" } });
  bridge.answer({
    query: "go",
    completion: "go",
    candidates: ["GO", "Golf", "Golfer", "Gossiping"],
  });
  fireEvent.change(input, { target: { value: "gol" } });
  expect(shown()).toEqual(["Golf", "Golfer"]);
  expect(document.querySelector("[data-board-interim]")).not.toBeNull();
  bridge.answer({
    query: "gol",
    completion: "gol",
    candidates: ["Golf", "Golfer", "Golfing"],
  });
  expect(shown()).toEqual(["Golf", "Golfer", "Golfing"]);
  expect(document.querySelector("[data-board-interim]")).toBeNull();
});
