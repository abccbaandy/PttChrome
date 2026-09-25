// pmore 分頁的純模擬（無 bytes、無 DOM）：給「反向讀取（End）」的 unit harness 與
// offline e2e 共用。規則全部取自 3rd_script/pttbbs/mbbsd/pmore.c（協定整理見
// docs/pttbbs-screen-protocol.md §13），**不是**從畫面觀察反推的：
//
//   畫面      mf_display 從 lineno 開始畫 MFDISP_PAGE = t_lines-1 個顯示列；一行 wrap
//             成多列時 dispedlines 只在該行**開始**顯示時 +1（:1590），所以最後一列可能
//             只畫到某一行的前半段。狀態列 `第 S~E 行` ＝ lineno+1 ~ lineno+dispedlines
//             （:2229-2235）。
//   PageDown  PMORE_UINAV_FORWARDPAGE：viewedAll ⇒ 零回應；否則 mf_forward(dispedlines-1)
//             （:2287），被 maxdisps 夾住（P1）。
//   PgUp      pmore_cmd_pgup → mf_backward(MFNAV_PAGE = t_lines-2)（:2419）。PTT 沒有
//             PMORE_AUTONEXT_ON_PAGEFLIP（只在 M3_USE_PMORE 區塊定義），第 1 行按 PgUp
//             什麼都不動 ⇒ pfterm diff 後**零回應**。
//   End       pmore_cmd_end → mf_goBottom（:2500），線上一幀。PMORE_ACCURATE_WRAPEND 讓
//             落地**可能 <100%**（maxdisps 只延長 wraplines，:2083-2108）——用
//             `endShortfall` 模擬：落地頁的起點比真正的末頁早幾行。
//   :N        goto-line：`if (i-- > 0) mf_goto(i)`，同樣被 maxdisps 夾住；先畫一幀
//             「跳至第幾行:」提示（游標停在提示上，不是 park）再落地。
//   Home      mf_goTop；已在第 1 行 ⇒ 零回應。
//
// 用法：
//   const sim = createPmoreSim({ total: 120, wraps: { 50: 2 } });
//   sim.screen()          目前畫面（24 列文字，最後一列是狀態列）
//   sim.press(keys)       → null（零回應）或 { frames: [{ texts, cursor }] }
//   sim.allRows()         整篇依序的顯示列（forward 讀完應得到的內容）
'use strict';

// 顯示欄寬（Big5 全形字 2 欄）。
const colsOf = (s) => [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x7f ? 2 : 1), 0);

// 狀態列。pmore 的 footer 第三段（按鍵提示）只畫得下多少畫多少（協定 §13 P5：
// mf_display_footer 依剩餘欄寬截斷、甚至整段不印）⇒ 行號長到四、五位數時提示會被
// 截掉，**整列絕不超過 80 欄**。
// 超過的話真終端會自動換行、整個畫面往上捲 —— 那是模擬器的 bug，不是 PTT 的行為。
function statusText(S, E, pct) {
  const head = `  瀏覽 第 1/9 頁 (${String(pct).padStart(3)}%)  目前顯示: 第 ${S}~${E} 行`;
  for (const tail of ['  (y)回應(X%)推文(h)說明(←)離開 ', '  (h)說明(←)離開 ', ' (←)離開', '']) {
    if (colsOf(head + tail) <= 79) return head + tail;
  }
  return head;
}

function createPmoreSim({ total, wraps = {}, rows = 24, endShortfall = 0, lineText } = {}) {
  const pageDisp = rows - 1;  // MFDISP_PAGE
  const navPage = rows - 2;   // MFNAV_PAGE
  const textOf = lineText || ((n) => `article line ${n}`);
  const rowsOfLine = (n) => {
    const w = wraps[n] || 1;
    const out = [textOf(n)];
    for (let k = 2; k <= w; ++k) out.push(`${textOf(n)} (wrap ${k})`);
    return out;
  };
  // 從第 top 行開始的一頁：{ texts(23), S, E, full }
  const layout = (top) => {
    const texts = [];
    let n = top;
    let disped = 0;
    let lastComplete = true;
    while (texts.length < pageDisp && n <= total) {
      ++disped;
      const rs = rowsOfLine(n);
      for (let i = 0; i < rs.length; ++i) {
        if (texts.length < pageDisp) texts.push(rs[i]);
        else lastComplete = false;
      }
      ++n;
    }
    const full = n > total && lastComplete;
    while (texts.length < pageDisp) texts.push('');
    return { texts, S: top, E: top - 1 + disped, full };
  };
  // maxdisps：最早的、整頁能一路畫到文末的起點。
  let endStart = total;
  while (endStart > 1 && layout(endStart - 1).full) --endStart;

  let top = 1;
  const pct = (p) => (p.full ? 100 : Math.min(99, Math.floor((p.E * 100) / total)));
  const frameAt = (t) => {
    const p = layout(t);
    return {
      texts: p.texts.concat([statusText(p.S, p.E, pct(p))]),
      cursor: { y: rows - 1, x: 79 },   // P6：回應結尾 park 在 (rows-1, cols-1)
    };
  };
  const promptFrame = (typed) => {
    const p = layout(top);
    return {
      texts: p.texts.concat([`跳至第幾行: ${typed}`]),
      cursor: { y: rows - 1, x: 12 + typed.length },
    };
  };
  const moveTo = (t) => {
    top = t;
    return { frames: [frameAt(t)] };
  };
  const stats = { pgUpAtTop: 0, silent: 0, keys: [] };

  function press(keys) {
    stats.keys.push(keys);
    if (keys === '\x1b[6~') {
      const p = layout(top);
      if (p.full) { ++stats.silent; return null; }
      return moveTo(Math.min(top + Math.max(1, p.E - p.S), endStart));
    }
    if (keys === '\x1b[5~') {
      if (top === 1) { ++stats.pgUpAtTop; ++stats.silent; return null; }
      return moveTo(Math.max(1, top - navPage));
    }
    if (keys === '\x1b[4~') {
      return moveTo(Math.max(1, endStart - endShortfall));
    }
    if (keys === '\x1b[1~') {
      if (top === 1) { ++stats.silent; return null; }
      return moveTo(1);
    }
    const m = /^:(\d+)\r$/.exec(keys);
    if (m) {
      const n = Number(m[1]);
      const prompt = promptFrame(m[1]);
      const t = n > 0 ? Math.min(n, endStart) : top;
      top = t;
      return { frames: [prompt, frameAt(t)] };
    }
    throw new Error('pmore_sim: unsupported keys ' + JSON.stringify(keys));
  }

  function allRows() {
    const out = [];
    for (let n = 1; n <= total; ++n) out.push(...rowsOfLine(n));
    return out;
  }

  return {
    press,
    allRows,
    screen: () => frameAt(top),
    get top() { return top; },
    set top(t) { top = t; },
    endStart,
    stats,
    layout,
  };
}

module.exports = { createPmoreSim, statusText };
