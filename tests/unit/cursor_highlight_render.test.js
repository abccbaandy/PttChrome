// 游標底色的**渲染**回歸守護（2026-08-15）。
//
// 壞過的 bug：設定頁的「底色」色票怎麼選畫面都是綠的。pref
// mouseBrowsingHighlightColor → view.highlightBG 是一條死鏈（全 repo 沒有讀取點），
// 實際上色的是渲染鏈硬寫的 `cx({ b2: highlighted })`。
// 這裡鎖住「這一列收到什麼 class 就掛什麼 class」，而不是鎖死某個顏色。
import { mountRow, unmountAll } from "./helpers/mount_screen";

const COLOR = {
  fg: 7,
  bg: 0,
  blink: false,
  equals(o) {
    return o === this;
  },
};

function cell(c) {
  return {
    ch: c,
    isStartOfURL: () => false,
    isEndOfURL: () => false,
    getFullURL: () => null,
    getColor: () => COLOR,
  };
}

const chars = (str) => str.split("").map(cell);

const bbsline = (container) => container.querySelector('[data-type="bbsline"]');

afterEach(unmountAll);

describe("一列的游標底色 class", () => {
  test("highlightClass 直接掛到 bbsline span（不再硬寫 b2）", () => {
    const { container } = mountRow({
      chars: chars("hello world"),
      row: 3,
      highlightClass: "b4",
    });
    const line = bbsline(container);
    expect(line.classList.contains("b4")).toBe(true);
    expect(line.classList.contains("b2")).toBe(false);
  });

  test("預設綠 b2 仍照常運作", () => {
    const { container } = mountRow({
      chars: chars("hello world"),
      row: 3,
      highlightClass: "b2",
    });
    expect(bbsline(container).classList.contains("b2")).toBe(true);
  });

  test("沒帶 highlightClass 的列不上任何底色", () => {
    const { container } = mountRow({ chars: chars("hello world"), row: 3 });
    const line = bbsline(container);
    expect(line.className || "").toBe("");
  });

  test("黑名單通知列（blacklistNotice 路徑）也吃同一個 class", () => {
    const { container } = mountRow({
      chars: chars("x"),
      row: 5,
      forceWidth: 16,
      blacklistNotice: "(本文已被黑名單) someone",
      highlightClass: "b6",
    });
    const line = bbsline(container);
    expect(line.classList.contains("b6")).toBe(true);
    expect(line.classList.contains("b2")).toBe(false);
  });
});
