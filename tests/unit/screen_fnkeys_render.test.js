// 功能鍵按鈕的渲染契約（`<a class="fnKey">`）。
//
// 為什麼一定要有這一支：`<a>` 是**刻意**選的 —— App.mouse_click 的 isAnchorTarget
// 早退讓它自動贏過所有滑鼠瀏覽分支（優先權第 4 條，見 docs/mouse.md），所以
// App.mouse_click 一行都沒改。標籤名一旦被改成 span，功能鍵會靜默變成「點了就
// 退出文章／開錯文」，而且完全看不出來。
//
// 另外鎖住 term_view.countCol 的契約：那個函式遞迴累加 u2b(textContent).length
// 來反查選取的 col，fnKey **不得插入任何文字節點**（title 屬性不算）。
import { mountRow, unmountAll } from "./helpers/mount_screen";

afterEach(unmountAll);

const COLOR = {
  fg: 7,
  bg: 0,
  blink: false,
  equals(o) {
    return o === this;
  },
};

const cell = (c) => ({
  ch: c,
  isStartOfURL: () => false,
  isEndOfURL: () => false,
  getFullURL: () => null,
  getColor: () => COLOR,
});

const chars = (str) => str.split("").map(cell);

// " 文章選讀  (y)回應" 的 ASCII 替身：DBCS 路徑由 golden 場景覆蓋，這裡只驗 DOM。
const LINE = "abc [d]xy (y)z";
// [d] 在 cols 4..7（exclusive）、(y) 在 cols 10..13（exclusive）
const FN_D = { startCol: 4, endCol: 7, label: "[d]" };
const FN_Y = { startCol: 10, endCol: 13, label: "(y)" };

function mount(fnKeys, extra) {
  return mountRow(
    Object.assign({ chars: chars(LINE), fnKeys }, extra || {}),
  );
}

describe("a.fnKey 的屬性", () => {
  test("每一組括號各自成為一個 <a class=\"fnKey\">", () => {
    const { container } = mount([
      { ...FN_D, onClick: () => {} },
      { ...FN_Y, onClick: () => {} },
    ]);
    const anchors = container.querySelectorAll("a.fnKey");
    expect(anchors.length).toBe(2);
    expect([...anchors].map((a) => a.textContent)).toEqual(["[d]", "(y)"]);
  });

  test("範圍含括號本身（邊界落在 ASCII 格上，不會切在 DBCS trail cell）", () => {
    const { container } = mount([{ ...FN_D, onClick: () => {} }]);
    expect(container.querySelector("a.fnKey").textContent).toBe("[d]");
  });

  test("href='#' ＋ data-fnkey ＋ title", () => {
    const { container } = mount([{ ...FN_D, onClick: () => {} }]);
    const a = container.querySelector("a.fnKey");
    expect(a.getAttribute("href")).toBe("#");
    expect(a.getAttribute("data-fnkey")).toBe("[d]");
    expect(a.getAttribute("title")).toContain("[d]");
  });

  test("整列文字一字不多不少（term_view.countCol 的 col 反查契約）", () => {
    const plain = mountRow({ chars: chars(LINE) });
    const withKeys = mount([
      { ...FN_D, onClick: () => {} },
      { ...FN_Y, onClick: () => {} },
    ]);
    expect(withKeys.container.textContent).toBe(plain.container.textContent);
  });
});

describe("點擊行為", () => {
  test("點下去呼叫 onClick，且 preventDefault（href='#' 不可以塞垃圾 hash）", () => {
    const onClick = vi.fn();
    const { container } = mount([{ ...FN_D, onClick }]);
    const ev = new window.MouseEvent("click", { bubbles: true, cancelable: true });
    container.querySelector("a.fnKey").dispatchEvent(ev);
    expect(onClick).toHaveBeenCalledTimes(1);
    // 本 app 用 URL hash 做 deep link（docs/deep-link.md），漏 preventDefault 會
    // 塞垃圾 hash 甚至觸發跳文解析。
    expect(ev.defaultPrevented).toBe(true);
  });

  test("onClick 缺失時點下去不炸（仍然 preventDefault）", () => {
    const { container } = mount([{ ...FN_D, onClick: null }]);
    const ev = new window.MouseEvent("click", { bubbles: true, cancelable: true });
    expect(() =>
      container.querySelector("a.fnKey").dispatchEvent(ev),
    ).not.toThrow();
    expect(ev.defaultPrevented).toBe(true);
  });

  test("兩個按鈕各自送自己的鍵（閉包沒有共用同一個 item）", () => {
    const calls = [];
    mount([
      { ...FN_D, onClick: () => calls.push("d") },
      { ...FN_Y, onClick: () => calls.push("y") },
    ]);
    const anchors = document.querySelectorAll("a.fnKey");
    anchors[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    anchors[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(calls).toEqual(["y", "d"]);
  });
});

describe("與其他裝飾共存", () => {
  test("部分底色 wrapper（防誤觸模式）之下仍然產生按鈕", () => {
    const { container } = mount([{ ...FN_D, onClick: () => {} }], {
      highlightClass: "b2",
      highlightColStart: 2,
    });
    expect(container.querySelector(".b2")).not.toBeNull();
    expect(container.querySelector("a.fnKey")).not.toBeNull();
    expect(container.textContent).toBe(LINE);
  });

  test("整列底色（highlightColStart 0）之下也一樣", () => {
    const { container } = mount([{ ...FN_D, onClick: () => {} }], {
      highlightClass: "b2",
    });
    expect(container.querySelector("a.fnKey")).not.toBeNull();
  });
});

describe("沒給 fnKeys 時 DOM 逐字不變", () => {
  test("undefined / null / 空陣列都與完全不傳相同", () => {
    const base = mountRow({ chars: chars(LINE) }).container.innerHTML;
    [undefined, null, []].forEach((v) => {
      expect(mountRow({ chars: chars(LINE), fnKeys: v }).container.innerHTML).toBe(
        base,
      );
    });
    expect(document.querySelectorAll("a.fnKey").length).toBe(0);
  });
});
