// @unit-env browser
// 每秒閃爍相位（App timerEverySec → TermView.onBlink → TermBuf.notify 尾端）的省電不變量。
//
// 前身是每秒無條件切換 `body.blink--active`：整棵樹做一次樣式失效，再加上 #cursor 的
// display 在 none/block 之間切換所觸發的 layout。實測前景閒置時九成以上的 CPU 花在這裡，
// 而且成本會隨畫面節點數增加（docs/handoff/android-battery-drain.md）。現在的規則：
//   - 游標只切換自己的 class（CSS 只動 visibility，不觸發 layout）
//   - body class 只在 DOM 裡真的有 SGR 5 閃爍字（.qq*）時才掛上
//   - 頁面隱藏時不閃
// CSS 有沒有真的接上，由 tests/e2e/offline/blink_cursor.offline.spec.js 驗。
import { TermView } from "../../src/js/term_view";
import { TermBuf } from "../../src/js/term_buf";

function makeView() {
  const cursor = document.createElement("div");
  cursor.id = "cursor";
  document.body.appendChild(cursor);
  return {
    bbsCursor: cursor,
    _blinkPhase: false,
    blinkOn: false,
    buf: { queueUpdate: vi.fn() },
    onBlink: TermView.prototype.onBlink,
    toggleBlinkPhase: TermView.prototype.toggleBlinkPhase,
  };
}

function bodyBlink() {
  return document.body.classList.contains("blink--active");
}

function cursorOn(v) {
  return v.bbsCursor.classList.contains("cursor--blink-on");
}

describe("TermView.toggleBlinkPhase", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.body.className = "";
  });

  test("畫面沒有閃爍字：游標交替明暗，body class 從頭到尾不掛", () => {
    const v = makeView();
    const seen = [];
    for (let i = 0; i < 4; i++) {
      v.toggleBlinkPhase();
      expect(bodyBlink()).toBe(false);
      seen.push(cursorOn(v));
    }
    expect(seen).toEqual([true, false, true, false]);
  });

  test("畫面有閃爍字（.qq*）：body class 跟著相位交替", () => {
    const v = makeView();
    const span = document.createElement("span");
    span.className = "q7 b0 qq0";
    document.body.appendChild(span);
    const seen = [];
    for (let i = 0; i < 4; i++) {
      v.toggleBlinkPhase();
      seen.push(bodyBlink());
    }
    expect(seen).toEqual([true, false, true, false]);
  });

  test("二色字的閃爍（qq2）也算", () => {
    const v = makeView();
    const span = document.createElement("span");
    span.className = "o w7 q3 b0 qq2";
    document.body.appendChild(span);
    v.toggleBlinkPhase();
    expect(bodyBlink()).toBe(true);
  });

  test("body class 掛著時閃爍字被換掉：之後不會一直留著 class", () => {
    const v = makeView();
    const span = document.createElement("span");
    span.className = "qq1";
    document.body.appendChild(span);
    v.toggleBlinkPhase();
    expect(bodyBlink()).toBe(true);
    span.remove();
    v.toggleBlinkPhase();
    v.toggleBlinkPhase();
    expect(bodyBlink()).toBe(false);
  });
});

describe("TermView.onBlink", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("頁面可見：排一次 notify", () => {
    const v = makeView();
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    v.onBlink();
    expect(v.blinkOn).toBe(true);
    expect(v.buf.queueUpdate).toHaveBeenCalledTimes(1);
  });

  test("頁面隱藏：不閃、不排 notify", () => {
    const v = makeView();
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    v.onBlink();
    expect(v.blinkOn).toBe(false);
    expect(v.buf.queueUpdate).not.toHaveBeenCalled();
  });
});

describe("TermBuf.notify 的閃爍出口", () => {
  test("blinkOn 時交給 view.toggleBlinkPhase，不自己切換 body class", () => {
    document.body.className = "";
    const toggleBlinkPhase = vi.fn();
    const buf = new TermBuf(80, 24);
    buf.setView({
      update() {},
      updateCursorPos() {},
      refreshCursorVisibility() {},
      toggleBlinkPhase,
      blinkOn: true,
    });
    buf.useMouseBrowsing = false;
    buf.notify();
    expect(toggleBlinkPhase).toHaveBeenCalledTimes(1);
    expect(buf.view.blinkOn).toBe(false);
    expect(document.body.classList.contains("blink--active")).toBe(false);
  });
});
