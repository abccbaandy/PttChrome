// 上傳紀錄（本機）：面板要能挑一張舊圖再插入，所以清單順序與去重是行為的一部分。
import {
  MAX_HISTORY,
  addHistoryEntry,
  clearHistory,
  readHistory,
  removeHistoryEntry,
  writeHistory,
} from "../../src/js/upload_history";

const entry = (n) => ({
  url: "https://i.urusai.cc/" + n + ".png",
  filename: n + ".png",
  at: n,
});

beforeEach(() => {
  window.localStorage.clear();
});

describe("addHistoryEntry", () => {
  test("最新的排最前面", () => {
    const list = addHistoryEntry(addHistoryEntry([], entry(1)), entry(2));
    expect(list.map((e) => e.filename)).toEqual(["2.png", "1.png"]);
  });

  test("同一個網址不重複佔位（重傳同一張圖只留最新那筆）", () => {
    const first = addHistoryEntry([], entry(1));
    const again = addHistoryEntry(first, { ...entry(1), at: 99 });
    expect(again).toHaveLength(1);
    expect(again[0].at).toBe(99);
  });

  test("超過上限就截斷（不讓 localStorage 無限長大）", () => {
    let list = [];
    for (let i = 0; i < MAX_HISTORY + 5; i++) list = addHistoryEntry(list, entry(i));
    expect(list).toHaveLength(MAX_HISTORY);
    // 最舊的被丟掉，最新的還在
    expect(list[0].filename).toBe(MAX_HISTORY + 4 + ".png");
  });

  test("沒有 url 的東西不進清單", () => {
    expect(addHistoryEntry([], { filename: "x.png" })).toEqual([]);
    expect(addHistoryEntry(null, null)).toEqual([]);
  });
});

test("removeHistoryEntry 只移除指定網址", () => {
  const list = [entry(1), entry(2)];
  expect(removeHistoryEntry(list, entry(1).url).map((e) => e.filename)).toEqual([
    "2.png",
  ]);
  expect(removeHistoryEntry(null, "x")).toEqual([]);
});

describe("readHistory / writeHistory", () => {
  test("寫進去讀得回來", () => {
    writeHistory([entry(1)]);
    expect(readHistory()).toEqual([entry(1)]);
  });

  test("壞掉的 JSON 回空陣列（附屬功能不可以炸掉呼叫端）", () => {
    window.localStorage.setItem("pttchrome.upload.v1", "{not json");
    expect(readHistory()).toEqual([]);
  });

  test("存的不是陣列、或元素沒有 url 都濾掉", () => {
    window.localStorage.setItem("pttchrome.upload.v1", '{"a":1}');
    expect(readHistory()).toEqual([]);
    window.localStorage.setItem(
      "pttchrome.upload.v1",
      JSON.stringify([{ filename: "x" }, entry(3)]),
    );
    expect(readHistory()).toEqual([entry(3)]);
  });

  test("clearHistory 清空", () => {
    writeHistory([entry(1)]);
    clearHistory();
    expect(readHistory()).toEqual([]);
  });
});

test("紀錄不進偏好設定（不會被雲端同步／設定匯出帶走）", () => {
  writeHistory([entry(1)]);
  expect(window.localStorage.getItem("pttchrome.pref.v1")).toBeNull();
});
