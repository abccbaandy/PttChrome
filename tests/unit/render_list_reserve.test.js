// @unit-env browser
// real-input: tests/e2e/offline/easy-reading-list.offline.spec.js
// 列表好讀視口的頂端保留區（screen.js#absorbListShift）。
//
// 為什麼有它：觸控捲動／慣性甩動進行中，JS 寫進捲動容器的 scrollTop 會被 compositor
// 蓋回去（真 Android Chrome 實測），往上補頁的「寫 scrollTop 補償」因此遺失 ⇒ 補頁
// 停不下來（ptt-debug-20261008-003701）。保留區讓補頁在**不寫 scrollTop** 的前提下
// 維持畫面不動。甩動本身 unit 做不出來；這裡鎖的是「沒有寫入、畫面照樣不動」這個
// 不變量，以及保留區不能把視口撐高（border-box 下 padding 超過高度會撐開，踩過）。
// session 端的對應守護在 tests/unit/list_session.test.js「甩動中補頁」。
import "../../src/css/main.css";
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { row, seg, listRow } from "./helpers/screen_fixtures";
import { setDiagSink } from "../../src/js/diag";

afterEach(() => {
  setDiagSink(null);
  unmountAll();
});

const VIEWPORT_PX = 400;

const lines = (from, to) => {
  const out = [row(seg("看板《Test》")), row(seg("  編號")), row(seg(""))];
  for (let i = from; i < to; ++i) out.push(listRow("someone", "□ [心得] 第 " + i + " 篇"));
  out.push(row(seg(" 文章選讀  (y)回應(X)推文")));
  return out;
};

const props = (from, to) => ({
  lines: lines(from, to),
  enableLinkInlinePreview: false,
  enableLinkHoverPreview: false,
  enhance: {
    pageState: 2,
    listEasyReading: true,
    easyReading: true,
    listScroll: { bodyStart: 3, viewportPx: VIEWPORT_PX, scrollable: true },
  },
});

const view = (m) => m.container.querySelector(".listBodyView");

// 內容為「第 n 篇」那一列在畫面上的 y（以視口頂為 0）。
const rowY = (m, n) => {
  const v = view(m);
  const needle = "第 " + n + " 篇";
  const r = Array.from(v.children).find((c) => c.textContent.includes(needle));
  return r.getBoundingClientRect().top - v.getBoundingClientRect().top;
};

const rowH = (m) => view(m).children[0].getBoundingClientRect().height;

// 捲動靜止判準（LIST_RESERVE_IDLE_MS）之後。
const afterIdle = () => new Promise((r) => setTimeout(r, 400));

describe("列表視口頂端保留區", () => {
  test("保留區比視口還高也不撐高視口；內容座標不含保留區", () => {
    const m = mountScreen(props(100, 140));
    m.controller.setListReserveTarget(3000);
    const v = view(m);
    expect(v.clientHeight).toBe(VIEWPORT_PX);
    expect(v.getBoundingClientRect().height).toBe(VIEWPORT_PX);
    // 內容第一列貼在保留區下方，畫面停在內容頂端（不是一片空白）。
    expect(m.controller.getListScrollTop()).toBe(0);
    expect(v.scrollTop).toBe(3000);
    expect(rowY(m, 100)).toBe(0);
  });

  test("往上補頁：吸收位移，**不寫 scrollTop**，看著的那一列原地不動", () => {
    const m = mountScreen(props(100, 140));
    m.controller.setListReserveTarget(3000);
    const h = rowH(m);
    m.controller.setListScrollTop(5 * h); // 視口頂＝第 105 篇
    const v = view(m);
    const domTop = v.scrollTop;
    const y = rowY(m, 105);

    // 一幀：上方多 10 列（補頁）→ session 判定為純位移 → 交給保留區。
    const writes = [];
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    Object.defineProperty(v, "scrollTop", {
      configurable: true,
      get() { return desc.get.call(this); },
      set(x) { writes.push(x); desc.set.call(this, x); },
    });
    m.update(props(90, 140));
    expect(m.controller.absorbListShift(10 * h)).toBe(true);

    expect(writes).toEqual([]);
    expect(v.scrollTop).toBe(domTop);
    expect(rowY(m, 105)).toBeCloseTo(y, 0);
    // 內容座標跟著平移（session 的錨以它換算）。
    expect(m.controller.getListScrollTop()).toBeCloseTo(15 * h, 0);
  });

  test("頂端 evict（往下捲）：反向吸收，保留區變大，畫面不動", () => {
    const m = mountScreen(props(100, 140));
    m.controller.setListReserveTarget(1000);
    const h = rowH(m);
    m.controller.setListScrollTop(20 * h);
    const v = view(m);
    const domTop = v.scrollTop;
    const y = rowY(m, 125);
    m.update(props(110, 140));
    expect(m.controller.absorbListShift(-10 * h)).toBe(true);
    expect(v.scrollTop).toBe(domTop);
    expect(rowY(m, 125)).toBeCloseTo(y, 0);
  });

  test("保留區不夠吸收 ⇒ 回 false（呼叫端退回寫 scrollTop）", () => {
    const m = mountScreen(props(100, 140));
    m.controller.setListReserveTarget(50);
    expect(m.controller.absorbListShift(10 * rowH(m))).toBe(false);
  });

  test("回補到目標大小只在捲動靜止後做，而且畫面不動", async () => {
    const m = mountScreen(props(100, 140));
    m.controller.setListReserveTarget(3000);
    const h = rowH(m);
    m.controller.setListScrollTop(5 * h);
    m.update(props(90, 140));
    m.controller.absorbListShift(10 * h);
    const v = view(m);
    const y = rowY(m, 105);
    const shrunk = v.scrollTop;
    // 有捲動事件 ⇒ 還在捲 ⇒ 不回補（甩動中寫入會被蓋掉）。
    v.dispatchEvent(new Event("scroll"));
    m.controller.setListReserveTarget(3001);
    expect(v.scrollTop).toBe(shrunk);
    await afterIdle();
    expect(v.scrollTop).toBeCloseTo(shrunk + 10 * h + 1, 0);
    expect(rowY(m, 105)).toBeCloseTo(y, 0);
  });

  test("到頂（目標 0）：靜止後收掉保留區，看著的那一列仍原地", async () => {
    const m = mountScreen(props(100, 140));
    m.controller.setListReserveTarget(3000);
    const h = rowH(m);
    m.controller.setListScrollTop(5 * h);
    const y = rowY(m, 105);
    m.controller.setListReserveTarget(0);
    await afterIdle();
    expect(view(m).scrollTop).toBeCloseTo(5 * h, 0);
    expect(view(m).style.getPropertyValue("--list-reserve")).toBe("");
    expect(rowY(m, 105)).toBeCloseTo(y, 0);
  });

  test("錄製期間：寫入／吸收／保留區回補（含延後）都寫進 diag", async () => {
    const logs = [];
    setDiagSink((tag, info) => logs.push([tag, info]));
    const m = mountScreen(props(100, 140));
    m.controller.setListReserveTarget(3000);
    const h = rowH(m);
    m.controller.setListScrollTop(5 * h);
    m.update(props(90, 140));
    m.controller.absorbListShift(10 * h);
    view(m).dispatchEvent(new Event("scroll"));
    m.controller.setListReserveTarget(3001);
    await afterIdle();
    // 建立視口時的 overflow 初值（"" → auto）也會記一筆，這裡只看捲動位置相關的三類。
    const pos = logs.filter(([t]) => t !== "listView.overflow");
    const tags = pos.map(([t, i]) => t + (i.action ? ":" + i.action : ""));
    expect(tags).toEqual([
      "listView.reserve:applied",
      "listView.write",
      "listView.absorb",
      "listView.reserve:deferred",
      "listView.reserve:applied",
    ]);
    expect(pos[1][1]).toMatchObject({ kind: "set", px: Math.round(5 * h), res: 3000, busy: false });
    expect(pos[2][1]).toMatchObject({ d: Math.round(10 * h), res: 3000, ok: true });
  });

  // 錄製檔 ptt-debug-20261008-014654 t=1106..2111：按下的那一列在觸控中被重畫換掉，
  // touchend 發到脫離 DOM 的舊節點、傳不到視口 ⇒ 舊版的觸控計數卡在 1，保留區一路
  // deferred、永遠不回補。
  test("按下的那一列被重畫換掉（touchend 收不到）：保留區照樣在靜止後回補", async () => {
    const m = mountScreen(props(100, 140));
    m.controller.setListReserveTarget(3000);
    const v = view(m);
    const target = v.children[0];
    const t = new Touch({ identifier: 1, target, clientX: 10, clientY: 10 });
    target.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [t], changedTouches: [t] }));
    m.update(props(200, 240)); // 整批換列：按下的那個節點離開 DOM
    target.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [], changedTouches: [t] }));
    m.controller.setListReserveTarget(1000);
    await afterIdle();
    expect(v.style.getPropertyValue("--list-reserve")).toBe("1000px");
  });
});
