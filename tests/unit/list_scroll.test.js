// 列表好讀原生捲動的數學（src/js/list_scroll.js）。
//
// 這一層是「瀏覽器負責捲、我們只負責換算」的全部邏輯：序列位置 ↔ scrollTop 的
// 換算、錨定還原、把某一列帶進視口、以及 behavior 政策。全部純函式 ⇒ 這裡測完，
// list_session 那邊只剩接線。
import {
  POS_EPS,
  VISIBLE_EPS,
  contentPx,
  maxScrollTopFor,
  topPosFromScrollTop,
  anchorScrollTop,
  isRowVisible,
  revealScrollTop,
  revealPlan,
  landingTopPos,
  listReservePx,
  shiftOnlyDelta,
  LIST_RESERVE_PAGES,
} from "../../src/js/list_scroll";

const ROW = 26; // chh
const BODY = 20; // bodyRows = rows - 4
const VP = ROW * BODY; // 視口高

describe("contentPx / maxScrollTopFor", () => {
  test("短板補 blank 到 bodyRows ⇒ 內容至少一個視口高、零可捲距離", () => {
    expect(contentPx({ len: 5, bodyRows: BODY, rowH: ROW })).toBe(VP);
    expect(maxScrollTopFor({ len: 5, bodyRows: BODY, rowH: ROW })).toBe(0);
  });

  test("序列比視口長 ⇒ 可捲距離＝多出來的列", () => {
    expect(maxScrollTopFor({ len: BODY + 7, bodyRows: BODY, rowH: ROW })).toBe(7 * ROW);
  });
});

describe("topPosFromScrollTop", () => {
  test("整列對齊", () => {
    expect(topPosFromScrollTop({ scrollTop: 3 * ROW, rowH: ROW })).toEqual({ pos: 3, frac: 0 });
  });

  test("停在半列：pos 是被捲到頂的那一列，frac 是它被吃掉的部分", () => {
    const r = topPosFromScrollTop({ scrollTop: 3 * ROW + 11, rowH: ROW });
    expect(r.pos).toBe(3);
    expect(r.frac).toBeCloseTo(11);
  });

  test("浮點殘渣不得少算一列（1e-6 容差）", () => {
    const r = topPosFromScrollTop({ scrollTop: 4 * ROW - POS_EPS * ROW * 0.5, rowH: ROW });
    expect(r.pos).toBe(4);
  });

  // REGRESSION（手機「列表 PgUp 會卡住」）：非整數 DPR（Pixel 7 = 2.625）下
  // fixedResize 給的列高是 26/2.625 = 9.9047… 這種小數。寫進 scrollTop 的 pos*rowH
  // 會被瀏覽器量化（裝置像素、Chrome LayoutUnit 1/64px），讀回來可能差零點零幾 px，
  // 以前的「列單位 1e-6」容差吃不下 ⇒ floor 少算一列 ⇒ PgUp 每次都被吃掉一列。
  test.each([
    ["DPR 2.625、fixed-term-size", 26 / 2.625, 2.625],
    ["DPR 2.625、fixed-font-size 20", 52 / 2.625, 2.625],
    ["DPR 1.25（Windows 125%）", 37 / 1.25, 1.25],
  ])("非整數 DPR 下 scrollTop 量化不得少算一列：%s", (_label, rowH, dpr) => {
    const quantizers = [
      (x) => Math.floor(x * 64) / 64, // LayoutUnit 向下
      (x) => Math.round(x * dpr) / dpr, // 對齊裝置像素
      (x) => Math.floor(x * dpr) / dpr,
    ];
    for (const q of quantizers) {
      for (let pos = 0; pos <= 400; pos++) {
        const st = q(pos * rowH);
        expect(topPosFromScrollTop({ scrollTop: st, rowH }).pos).toBe(pos);
      }
    }
  });

  test("負值／rowH 未知時退回原點，不得回 NaN", () => {
    expect(topPosFromScrollTop({ scrollTop: -50, rowH: ROW })).toEqual({ pos: 0, frac: 0 });
    expect(topPosFromScrollTop({ scrollTop: 100, rowH: 0 })).toEqual({ pos: 0, frac: 0 });
  });
});

describe("anchorScrollTop（不變量 6 的原生捲動版）", () => {
  const max = maxScrollTopFor({ len: 300, bodyRows: BODY, rowH: ROW });

  test("往回算得到同一個 scrollTop（round-trip）", () => {
    const st = 37 * ROW + 9;
    const a = topPosFromScrollTop({ scrollTop: st, rowH: ROW });
    expect(anchorScrollTop({ pos: a.pos, frac: a.frac, rowH: ROW, maxScrollTop: max })).toBeCloseTo(st);
  });

  test("prepend 20 列：同一個內容錨的位置 +20 ⇒ scrollTop 恰好 +20 列", () => {
    const before = anchorScrollTop({ pos: 10, frac: 5, rowH: ROW, maxScrollTop: max });
    const after = anchorScrollTop({ pos: 30, frac: 5, rowH: ROW, maxScrollTop: max });
    expect(after - before).toBeCloseTo(20 * ROW);
  });

  test("evict 掉上方 30 列：位置 -30 ⇒ scrollTop 恰好 -30 列", () => {
    const before = anchorScrollTop({ pos: 50, frac: 0, rowH: ROW, maxScrollTop: max });
    const after = anchorScrollTop({ pos: 20, frac: 0, rowH: ROW, maxScrollTop: max });
    expect(before - after).toBeCloseTo(30 * ROW);
  });

  test("夾在 [0, maxScrollTop]：序列縮短後舊錨不得捲出空白", () => {
    const shortMax = maxScrollTopFor({ len: 25, bodyRows: BODY, rowH: ROW });
    expect(anchorScrollTop({ pos: 200, frac: 0, rowH: ROW, maxScrollTop: shortMax })).toBe(shortMax);
    expect(anchorScrollTop({ pos: -3, frac: 0, rowH: ROW, maxScrollTop: shortMax })).toBe(0);
  });
});

// 採用原生落點時的視口頂端（手機卡片一屏放不下原生一頁）。
describe("landingTopPos", () => {
  test("原生頁塞得進一屏（桌機）⇒ 原錨不動", () => {
    expect(landingTopPos({ topPos: 40, cursorPos: 59, lastPos: 59, pageRows: 20 })).toBe(40);
  });
  test("卡片一屏 8 筆、游標在頁底 ⇒ 頁底貼齊視口底，游標看得到", () => {
    expect(landingTopPos({ topPos: 40, cursorPos: 59, lastPos: 59, pageRows: 8 })).toBe(52);
  });
  test("游標下方還有置底列 ⇒ 露出頁底，但游標不得被捲出頂端", () => {
    expect(landingTopPos({ topPos: 40, cursorPos: 50, lastPos: 59, pageRows: 8 })).toBe(50);
    expect(landingTopPos({ topPos: 40, cursorPos: 55, lastPos: 59, pageRows: 8 })).toBe(52);
  });
  test("不得高於原生頁頂；任一位置未知 ⇒ 原錨", () => {
    expect(landingTopPos({ topPos: 40, cursorPos: 40, lastPos: 44, pageRows: 8 })).toBe(40);
    expect(landingTopPos({ topPos: 40, cursorPos: -1, lastPos: 59, pageRows: 8 })).toBe(40);
    expect(landingTopPos({ topPos: 40, cursorPos: 59, lastPos: -1, pageRows: 8 })).toBe(40);
  });
});

describe("isRowVisible", () => {
  const base = { scrollTop: 10 * ROW, rowH: ROW, viewportPx: VP };

  test("視口內／外", () => {
    expect(isRowVisible(Object.assign({ pos: 10 }, base))).toBe(true);
    expect(isRowVisible(Object.assign({ pos: 29 }, base))).toBe(true);
    expect(isRowVisible(Object.assign({ pos: 9 }, base))).toBe(false);
    expect(isRowVisible(Object.assign({ pos: 30 }, base))).toBe(false);
  });

  test("子像素 scrollTop 不得把貼邊那列判成看不見", () => {
    const st = 10 * ROW + VISIBLE_EPS * 0.8;
    expect(isRowVisible({ pos: 10, scrollTop: st, rowH: ROW, viewportPx: VP })).toBe(true);
  });
});

describe("revealScrollTop", () => {
  const max = maxScrollTopFor({ len: 300, bodyRows: BODY, rowH: ROW });
  const base = { scrollTop: 10 * ROW, rowH: ROW, viewportPx: VP, maxScrollTop: max };

  test("nearest：看得到就不動", () => {
    expect(revealScrollTop(Object.assign({ pos: 15, block: "nearest" }, base))).toBe(10 * ROW);
  });

  test("nearest：在上方 ⇒ 貼齊視口頂；在下方 ⇒ 貼齊視口底（都是最少的移動）", () => {
    expect(revealScrollTop(Object.assign({ pos: 7, block: "nearest" }, base))).toBe(7 * ROW);
    expect(revealScrollTop(Object.assign({ pos: 30, block: "nearest" }, base))).toBe(31 * ROW - VP);
  });

  test("start：那一列變成新的第一列（PgUp/PgDn/Home）", () => {
    expect(revealScrollTop(Object.assign({ pos: 42, block: "start" }, base))).toBe(42 * ROW);
    expect(revealScrollTop(Object.assign({ pos: 0, block: "start" }, base))).toBe(0);
  });

  test("end：貼齊視口底（End）", () => {
    expect(revealScrollTop(Object.assign({ pos: 299, block: "end" }, base))).toBe(max);
  });

  test("center：置中，且不得捲出邊界", () => {
    const mid = revealScrollTop(Object.assign({ pos: 100, block: "center" }, base));
    expect(mid).toBeCloseTo(100 * ROW - (VP - ROW) / 2);
    expect(revealScrollTop(Object.assign({ pos: 1, block: "center" }, base))).toBe(0);
    expect(revealScrollTop(Object.assign({ pos: 299, block: "center" }, base))).toBe(max);
  });
});

describe("revealPlan（behavior 政策）", () => {
  test("↑↓ 且游標本來就看得到 ⇒ nearest + instant（按住方向鍵時 smooth 會互相取消）", () => {
    expect(revealPlan("up", { wasVisible: true })).toEqual({ block: "nearest", behavior: "auto" });
    expect(revealPlan("down", { wasVisible: true })).toEqual({ block: "nearest", behavior: "auto" });
  });

  test("↑↓ 但游標已被捲出視野 ⇒ 平滑地拉回畫面中央", () => {
    expect(revealPlan("up", { wasVisible: false })).toEqual({ block: "center", behavior: "smooth" });
  });

  test("翻頁／頭 ⇒ start + smooth；尾 ⇒ end + smooth", () => {
    expect(revealPlan("pgup", {})).toEqual({ block: "start", behavior: "smooth" });
    expect(revealPlan("pgdn", {})).toEqual({ block: "start", behavior: "smooth" });
    expect(revealPlan("home", {})).toEqual({ block: "start", behavior: "smooth" });
    expect(revealPlan("end", {})).toEqual({ block: "end", behavior: "smooth" });
  });

  test("prefers-reduced-motion ⇒ 一律 instant", () => {
    expect(revealPlan("pgdn", { reducedMotion: true }).behavior).toBe("auto");
    expect(revealPlan("up", { wasVisible: false, reducedMotion: true }).behavior).toBe("auto");
  });

  test("非導覽入口（開文定位／re-seed／點擊）⇒ 最少移動、不做動畫", () => {
    expect(revealPlan("seed", {})).toEqual({ block: "nearest", behavior: "auto" });
  });

  // 按住 PgUp/PgDn 的回歸（2026-08-30）：programmatic 平滑捲動不保留速度，每次
  // scrollTo 都從曲線起點重跑 ⇒ 按著只會慢慢爬、放開才快速補捲 1~2 頁。
  test("連發（按住／連續滾輪）⇒ block 不變、behavior 一律 instant", () => {
    expect(revealPlan("pgup", { repeat: true })).toEqual({ block: "start", behavior: "auto" });
    expect(revealPlan("pgdn", { repeat: true })).toEqual({ block: "start", behavior: "auto" });
    expect(revealPlan("home", { repeat: true })).toEqual({ block: "start", behavior: "auto" });
    expect(revealPlan("end", { repeat: true })).toEqual({ block: "end", behavior: "auto" });
    expect(revealPlan("up", { wasVisible: false, repeat: true })).toEqual({
      block: "center",
      behavior: "auto",
    });
  });

  test("單發（沒有 repeat）維持 smooth —— 第一下的平滑捲動不能被這條規則吃掉", () => {
    expect(revealPlan("pgdn", { repeat: false }).behavior).toBe("smooth");
  });
});

describe("shiftOnlyDelta（純位移才交給頂端保留區吸收）", () => {
  const H = 20;
  test("錨上方多 10 列、差距恰好 10 列高 → 回傳差距", () => {
    expect(shiftOnlyDelta({ capturedPos: 5, pos: 15, rowH: H, top: 15 * H + 3, cur: 5 * H + 3 })).toBe(10 * H);
  });
  test("頂端 evict（上方少列）→ 負的差距", () => {
    expect(shiftOnlyDelta({ capturedPos: 30, pos: 20, rowH: H, top: 20 * H, cur: 30 * H })).toBe(-10 * H);
  });
  test("錨不是擷取來的（action 指定落點）→ null，照舊寫入", () => {
    expect(shiftOnlyDelta({ capturedPos: null, pos: 15, rowH: H, top: 15 * H, cur: 5 * H })).toBeNull();
  });
  test("差距不等於列位移（clamp、視口在保留區裡）→ null", () => {
    expect(shiftOnlyDelta({ capturedPos: 5, pos: 15, rowH: H, top: 12 * H, cur: 5 * H })).toBeNull();
    // 視口停在保留區（內容座標為負）：擷取時 clamp 成 0，差距大於位移。
    expect(shiftOnlyDelta({ capturedPos: 0, pos: 10, rowH: H, top: 10 * H, cur: -300 })).toBeNull();
  });
  test("沒位移 → null（不吸收也不寫）", () => {
    expect(shiftOnlyDelta({ capturedPos: 5, pos: 5, rowH: H, top: 5 * H, cur: 5 * H })).toBeNull();
  });
});

describe("listReservePx", () => {
  test("往上還有東西＝固定頁數；到頂＝0", () => {
    expect(listReservePx({ edgeUp: false, bodyRows: 20, rowH: 10 })).toBe(LIST_RESERVE_PAGES * 200);
    expect(listReservePx({ edgeUp: true, bodyRows: 20, rowH: 10 })).toBe(0);
  });
});
