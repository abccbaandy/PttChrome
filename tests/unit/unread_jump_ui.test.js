// @unit-env browser
// 跳到第一篇未讀的畫面回饋（src/js/unread_jump_ui.js，P83／P84）：進度卡（延遲出現、更新、
// 取消、調暗）與落地分界（量列的位置、捲動／按鍵就收）。送鍵與收手在 unread_jump.test.js。
// real-input: tests/e2e/offline/unread_jump.offline.spec.js
import {
  UnreadJumpProgress,
  progressDetail,
  dividerLabel,
  rowShowsNum,
  PROGRESS_DELAY_MS,
  DIVIDER_FLASH_MS,
  BUSY_BODY_CLASS,
} from "../../src/js/unread_jump_ui";

// 可控的計時器：只在 flush() 時跑到期的。
function fakeTimers() {
  let now = 0;
  let id = 0;
  const q = new Map();
  return {
    setTimeout: (fn, ms) => {
      q.set(++id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (i) => q.delete(i),
    advance(ms) {
      now += ms;
      for (const [i, t] of Array.from(q)) {
        if (t.at <= now) {
          q.delete(i);
          t.fn();
        }
      }
    },
  };
}

const card = () => document.querySelector(".unreadJumpProgress");

afterEach(() => {
  document.querySelectorAll(".unreadJumpProgress, .unreadJumpDividerLayer, [data-test-row]").forEach((n) => n.remove());
  document.body.classList.remove(BUSY_BODY_CLASS);
});

describe("文字", () => {
  test("進度第二行：End 那頁不算翻頁", () => {
    expect(progressDetail(0, 20)).toBe("看過 20 篇");
    expect(progressDetail(2, 60)).toBe("已往上翻 2 頁・看過 60 篇");
  });
  test("分界標籤：沒有數字就只寫以下未讀", () => {
    expect(dividerLabel(8)).toBe("以下未讀 8 篇");
    expect(dividerLabel(0)).toBe("以下未讀");
    expect(dividerLabel(null)).toBe("以下未讀");
  });
  test("列上的編號要是獨立一串數字：1013 不配 11013、10130", () => {
    expect(rowShowsNum("   1013 + 6 11/14 user43", 1013)).toBe(true);
    expect(rowShowsNum(">  1013 + 6", 1013)).toBe(true);
    expect(rowShowsNum("  11013 + 6", 1013)).toBe(false);
    expect(rowShowsNum("  10130 + 6", 1013)).toBe(false);
    expect(rowShowsNum("anything", null)).toBe(false);
  });
});

describe("進度卡", () => {
  test("快的時候不閃：PROGRESS_DELAY_MS 內結束就從頭到尾不出現", () => {
    const t = fakeTimers();
    const ui = new UnreadJumpProgress(t);
    ui.begin(true);
    t.advance(PROGRESS_DELAY_MS - 1);
    expect(card()).toBeNull();
    ui.end();
    t.advance(1000);
    expect(card()).toBeNull();
    expect(document.body.classList.contains(BUSY_BODY_CLASS)).toBe(false);
  });

  test("超過延遲才出現；之前的 update 也算數；dim ⇒ body 掛調暗 class；end 全收", () => {
    const t = fakeTimers();
    const ui = new UnreadJumpProgress(t);
    ui.begin(true);
    ui.update(0, 20);
    t.advance(PROGRESS_DELAY_MS);
    expect(card()).not.toBeNull();
    expect(card().textContent).toContain("正在找第一篇未讀…");
    expect(card().textContent).toContain("看過 20 篇");
    expect(document.body.classList.contains(BUSY_BODY_CLASS)).toBe(true);
    ui.update(2, 60);
    expect(card().querySelector(".unreadJumpDetail").textContent).toBe("已往上翻 2 頁・看過 60 篇");
    ui.end();
    expect(card()).toBeNull();
    expect(document.body.classList.contains(BUSY_BODY_CLASS)).toBe(false);
  });

  test("原生（dim=false）不調暗", () => {
    const t = fakeTimers();
    const ui = new UnreadJumpProgress(t);
    ui.begin(false);
    t.advance(PROGRESS_DELAY_MS);
    expect(card()).not.toBeNull();
    expect(document.body.classList.contains(BUSY_BODY_CLASS)).toBe(false);
  });

  test("取消鈕：點了叫 onCancel；按下不搶焦點（終端機的隱藏 input 要一直拿著鍵盤）", () => {
    const t = fakeTimers();
    const onCancel = vi.fn();
    const ui = new UnreadJumpProgress({ ...t, onCancel });
    const input = document.createElement("input");
    input.setAttribute("data-test-row", "");
    document.body.appendChild(input);
    input.focus();
    ui.begin(true);
    t.advance(PROGRESS_DELAY_MS);
    const btn = card().querySelector(".unreadJumpCancel");
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    btn.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    btn.click();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input);
  });

  test("取消中：字換成正在取消、取消鈕收起（出現前就按了 Esc 也一樣）", () => {
    const t = fakeTimers();
    const ui = new UnreadJumpProgress(t);
    ui.begin(true);
    ui.cancelling();
    ui.update(1, 40);
    t.advance(PROGRESS_DELAY_MS);
    expect(card().querySelector(".unreadJumpTitle").textContent).toBe("正在取消…");
    expect(card().querySelector(".unreadJumpDetail").textContent).toBe("回到原本的位置");
    expect(card().querySelector(".unreadJumpCancel").hidden).toBe(true);
  });

  test("跳號中（committing）收起取消鈕", () => {
    const t = fakeTimers();
    const ui = new UnreadJumpProgress(t);
    ui.begin(true);
    t.advance(PROGRESS_DELAY_MS);
    ui.committing();
    expect(card().querySelector(".unreadJumpCancel").hidden).toBe(true);
  });
});

describe("落地分界", () => {
  function row(top, height = 40) {
    const el = document.createElement("div");
    el.setAttribute("data-test-row", "");
    Object.assign(el.style, { position: "fixed", top: top + "px", left: "10px", width: "300px", height: height + "px" });
    document.body.appendChild(el);
    return el;
  }
  const layer = () => document.querySelector(".unreadJumpDividerLayer");
  const lineTop = () => layer().querySelector(".unreadJumpDivider").style.top;

  test("分界線貼在那一列的上緣、寬度同列；標籤寫未讀篇數；亮底過一陣子淡掉", () => {
    const t = fakeTimers();
    const ui = new UnreadJumpProgress(t);
    const el = row(100);
    expect(ui.showDivider(() => el, 8)).toBe(true);
    const line = layer().querySelector(".unreadJumpDivider");
    expect(line.style.top).toBe("99px");
    expect(line.style.left).toBe("10px");
    expect(line.style.width).toBe("300px");
    expect(line.textContent).toBe("以下未讀 8 篇");
    const flash = layer().querySelector(".unreadJumpRowFlash");
    expect(flash.style.height).toBe("40px");
    expect(flash.classList.contains("faded")).toBe(false);
    t.advance(DIVIDER_FLASH_MS);
    expect(flash.classList.contains("faded")).toBe(true);
    expect(ui.dividerShown()).toBe(true);
  });

  // 列表好讀接管後還會自己補頁、捲動錨定：那不是使用者在動，分界要跟著那一列走。
  test("列表自己捲動 ⇒ 重新量、跟著那一列；那一列不見或捲出畫面才收", () => {
    const ui = new UnreadJumpProgress(fakeTimers());
    const el = row(100);
    let current = el;
    ui.showDivider(() => current, 3);
    el.style.top = "160px";
    window.dispatchEvent(new Event("scroll"));
    expect(lineTop()).toBe("159px");
    // 換了節點（重建）也照樣找得到。
    const el2 = row(220);
    current = el2;
    window.dispatchEvent(new Event("scroll"));
    expect(lineTop()).toBe("219px");
    el2.style.top = window.innerHeight + 30 + "px";
    window.dispatchEvent(new Event("scroll"));
    expect(ui.dividerShown()).toBe(false);
    ui.showDivider(() => el, 3);
    current = null;
    ui.showDivider(() => current, 3);
    expect(ui.dividerShown()).toBe(false);
  });

  test("使用者一動手（按鍵、點、觸控、滾輪）就收掉", () => {
    for (const fire of [
      () => document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "j" })),
      () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
      () => document.body.dispatchEvent(new Event("touchstart", { bubbles: true })),
      () => document.body.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 10 })),
    ]) {
      const ui = new UnreadJumpProgress(fakeTimers());
      const el = row(100);
      ui.showDivider(() => el, 3);
      expect(ui.dividerShown()).toBe(true);
      fire();
      expect(ui.dividerShown()).toBe(false);
      expect(layer()).toBeNull();
    }
  });

  test("認不出就不畫：列沒有大小、在視窗外、找不到", () => {
    const ui = new UnreadJumpProgress(fakeTimers());
    const flat = row(100, 0);
    const below = row(window.innerHeight + 50);
    expect(ui.showDivider(() => flat, 3)).toBe(false);
    expect(ui.showDivider(() => below, 3)).toBe(false);
    expect(ui.showDivider(() => null, 3)).toBe(false);
    expect(ui.showDivider(null, 3)).toBe(false);
    expect(layer()).toBeNull();
  });

  test("下一次開始找就先收掉上一次的分界", () => {
    const t = fakeTimers();
    const ui = new UnreadJumpProgress(t);
    const el = row(100);
    ui.showDivider(() => el, 3);
    ui.begin(false);
    expect(layer()).toBeNull();
  });
});
