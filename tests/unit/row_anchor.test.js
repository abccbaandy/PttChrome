// 注音組字框 `#t` 與 `#cursor` 的錨點守門。
//
// 症狀（2026-08）：在**列表好讀模式**切中文輸入法打字，組字框整個看不見，OS 的
// 候選字清單也跟著跑掉，使用者讀成「畫面卡住」。
//
// 根因：_rowAnchor 用 `[type="bbsrow"][srow=<buf.cur_y>]` 找「該列真正被畫出來的
// 節點」，守門只有 _gridRender。但列表好讀分支 _gridRender 是 true，那一幀畫的卻是
// 「header 3 列＋整段累積序列（≤300 列）＋footer」——srow 是序列 index，與 buf.cur_y
// 語意毫無關係。於是錨到 .listBodyView 深處、通常已捲出視野的一列，
// getBoundingClientRect().top 是大負數，而 updateInputBufferPos 只 clamp「下方塞不下
// 翻上方／右方塞不下往左靠」，沒有負值 clamp ⇒ #t 被寫到視窗外。
//
// 修法在源頭：_renderScreenLines 依 cursor_anchor.paintedRowsAreBufRows 記下這一幀
// 的 srow 是不是 buf 列號，_rowAnchor 一併檢查。**不在 updateInputBufferPos 加負值
// clamp**——既有 offline 測試「.main 已捲動時 #t 仍貼齊該格」驗的就是「錨在那一列、
// 被捲走也跟著走」，全域 clamp 會與那條契約打架，還會把錨點錯誤遮成「看起來還行」。
import { TermView } from "../../src/js/term_view";

const CHH = 24;

function fakeRect(r) {
  return () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, ...r });
}

// srow=5 的列節點：模擬列表好讀下被捲到視窗上方外的那一列。
function makeContainer(rowRect) {
  const cont = document.createElement("div");
  const el = document.createElement("span");
  el.setAttribute("type", "bbsrow");
  el.setAttribute("srow", "5");
  Object.defineProperty(el, "offsetTop", { value: 999 });
  Object.defineProperty(el, "offsetLeft", { value: 0 });
  el.getBoundingClientRect = fakeRect(rowRect);
  cont.appendChild(el);
  return cont;
}

function makeCtx({ srowIsBufRow, rowRect }) {
  const input = document.createElement("input");
  input.setAttribute("bshow", "1");
  input.style.width = "40px";
  const mainDisplay = document.createElement("div");
  // `.main` 可視區：整個終端機（24 列 × 24px）
  mainDisplay.getBoundingClientRect = fakeRect({
    left: 8, top: 0, bottom: 24 * CHH, height: 24 * CHH,
  });
  return {
    // 這三支互相呼叫（updateInputBufferPos → _cellClientRect → _rowAnchor），
    // 假 ctx 必須帶著它們，否則測到的是 TypeError 而不是落點。
    _rowAnchor: TermView.prototype._rowAnchor,
    _cellClientRect: TermView.prototype._cellClientRect,
    _gridRender: true,
    _srowIsBufRow: srowIsBufRow,
    mainContainer: makeContainer(rowRect),
    mainDisplay,
    input,
    buf: { cur_x: 3, cur_y: 5, rows: 24, cols: 80 },
    chw: 12,
    chh: CHH,
    scaleX: 1,
    scaleY: 1,
    innerBounds: { width: 960, height: 24 * CHH },
  };
}

const rowAnchor = (ctx, row) => TermView.prototype._rowAnchor.call(ctx, row);
const cellRect = (ctx, a) => TermView.prototype._cellClientRect.call(ctx, a);
const updatePos = (ctx, a) => TermView.prototype.updateInputBufferPos.call(ctx, a);

// 捲出視窗上方的那一列（列表好讀下 buf.cur_y 對應到的序列列幾乎總是這樣）
const OFFSCREEN = { left: 12, top: -4200, bottom: -4176, height: 24 };

describe("_rowAnchor 的守門", () => {
  test("REGRESSION：這一幀的 srow 不是 buf 列號（列表好讀視窗）→ 不得錨，回 null", () => {
    const ctx = makeCtx({ srowIsBufRow: false, rowRect: OFFSCREEN });
    // 前提：節點真的在（舊碼就是撈到它才出事），不是「查不到所以回 null」
    expect(ctx.mainContainer.querySelector('[srow="5"]')).not.toBeNull();
    expect(rowAnchor(ctx, 5)).toBeNull();
  });

  test("srow 就是 buf 列號（原生／鏡像）→ 照常錨在該列節點", () => {
    const ctx = makeCtx({ srowIsBufRow: true, rowRect: { left: 12, top: 120, bottom: 144, height: 24 } });
    const a = rowAnchor(ctx, 5);
    expect(a).not.toBeNull();
    expect(a.offsetTop).toBe(999);
  });

  test("非格線幀（好讀累積長頁）仍然回 null", () => {
    const ctx = makeCtx({ srowIsBufRow: true, rowRect: OFFSCREEN });
    ctx._gridRender = false;
    expect(rowAnchor(ctx, 5)).toBeNull();
  });
});

describe("#t 的落點", () => {
  test("REGRESSION：列表好讀下開始組字，#t 必須落在視窗內", () => {
    const ctx = makeCtx({ srowIsBufRow: false, rowRect: OFFSCREEN });
    updatePos(ctx); // onCompositionStart 就是這樣呼叫的（不帶 anchor）
    const top = parseFloat(ctx.input.style.top);
    const left = parseFloat(ctx.input.style.left);
    // 舊碼：top = -4176（錨到捲出視野那一列的下緣）⇒ 框在視窗外
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThanOrEqual(ctx.innerBounds.height);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThanOrEqual(ctx.innerBounds.width);
    expect(ctx.input.style.opacity).toBe("1");
  });

  test("沒有可錨的列時退回 `.main` 可視區左下角（＝原生輸入列將出現的位置）", () => {
    const ctx = makeCtx({ srowIsBufRow: false, rowRect: OFFSCREEN });
    const cell = cellRect(ctx, null);
    expect(cell.left).toBe(8); // `.main` 左緣，不加 cur_x 偏移
    expect(cell.top).toBe(24 * CHH - CHH); // 最後一列
  });

  test("srow 是 buf 列號時照舊貼齊該格（不得過度拒絕）", () => {
    const ctx = makeCtx({ srowIsBufRow: true, rowRect: { left: 12, top: 120, bottom: 144, height: 24 } });
    const cell = cellRect(ctx);
    expect(cell.left).toBe(12 + 3 * 12); // 列左緣 + cur_x * chw
    expect(cell.top).toBe(120);
  });

  test("bshow 非 1（沒在組字）→ 什麼都不寫", () => {
    const ctx = makeCtx({ srowIsBufRow: true, rowRect: { left: 12, top: 120, bottom: 144, height: 24 } });
    ctx.input.setAttribute("bshow", "0");
    ctx.input.style.top = "-100000px";
    updatePos(ctx);
    expect(ctx.input.style.top).toBe("-100000px");
  });
});
