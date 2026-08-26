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

  // 樣式層可以同時給提亮與底色 ⇒ 這裡拿到的是**多個 class 的字串**。
  // buildRow / LinkSegmentBuilder 一路把它當不透明字串傳下去，cx() 必須原樣吐出。
  test("提亮＋底色疊加：兩個 class 都掛到 bbsline span", () => {
    const { container } = mountRow({
      chars: chars("hello world"),
      row: 3,
      highlightClass: "cursorBrighten b2",
    });
    const line = bbsline(container);
    expect(line.classList.contains("cursorBrighten")).toBe(true);
    expect(line.classList.contains("b2")).toBe(true);
  });

  test("只有提亮（預設樣式）：掛得上，且不帶任何 bN 背景 class", () => {
    const BG_CLASSES = Array.from({ length: 15 }, (_, i) => "b" + (i + 1));
    const { container } = mountRow({
      chars: chars("hello world"),
      row: 3,
      highlightClass: "cursorBrighten",
    });
    const line = bbsline(container);
    expect(line.classList.contains("cursorBrighten")).toBe(true);
    expect([...line.classList].some((c) => BG_CLASSES.includes(c))).toBe(false);
  });

  // 防誤觸模式：底色／提亮只覆蓋可點區（col >= start），包在 wrapper span 裡。
  // .cursorHighlight 只是識別標記（無樣式），真正生效的是後面那些 class。
  test("部分寬度（col > 0）時提亮包在 .cursorHighlight wrapper 上", () => {
    const { container } = mountRow({
      chars: chars("hello world"),
      row: 3,
      highlightClass: "cursorBrighten",
      highlightColStart: 6,
    });
    const wrap = container.querySelector(".cursorHighlight");
    expect(wrap).not.toBeNull();
    expect(wrap.classList.contains("cursorBrighten")).toBe(true);
    expect(wrap.textContent).toBe("world");
    // bbsline 本身不上色（block 級元素，掛上去就是滿版）。
    expect(bbsline(container).classList.contains("cursorBrighten")).toBe(false);
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
