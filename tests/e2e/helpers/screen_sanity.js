// 「畫面不跑版、不亂碼」的結構檢查（live 核心 e2e 與 offline screen_sanity spec 共用）。
//
// **刻意不比對任何畫面內容**（PTT 近期改版頻繁，寫死字串＝每次改版假紅）。檢查的全是
// 渲染不變量，畫面長什麼樣都成立：
//   1. text   每列 DOM 文字 ＝ buf 的同一列（buf 是真相源；渲染漏字／多字／錯列＝紅）
//   2. grid   每列最後一個非空白字的右緣 ＝ 該字在終端機格線上的欄位 × chw
//             （全形字寬度沒被撐成 2 格、字型 fallback 撐寬…＝格線位移＝跑版）
//   3. decode Big5 每一對 lead/trail 都查得到 Unicode（查不到＝亂碼）；列內落單的高位元組
//   4. overflow #mainContainer 沒有水平捲動
//
// 欄位一律由 buf 的 TermChar 推（`isLeadByte` 配對），不用 Unicode 寬度猜：Big5 的
// 「×」（A1D1）解成 U+00D7 是窄字，但在終端機上佔 2 欄。
//
// screenSanity 回傳**報告**（失敗訊息直接帶出哪一列、差多少），門檻在 expectScreenSane。
const { expect } = require('@playwright/test');

async function screenSanity(page, opts = {}) {
  return page.evaluate(
    ({ maxRows, gridTolerance }) => {
      const app = window.__app;
      const buf = app.buf;
      const view = app.view;
      const chw = view.chw;
      const cols = buf.cols;
      const er = !!(view.useEasyReadingMode && buf.pageLines && buf.pageLines.length);
      // 渲染來源三種：文章好讀長頁（data-row＝pageLines index）、列表好讀／看板列表捲動
      // 視窗（data-row＝_listWindowLines 的渲染列號）、其餘＝原生 buf.lines。
      const listWindow =
        !er && buf.listRenderMode === 'buffer' && view._listWindowLines ? view._listWindowLines : null;
      const source = er ? buf.pageLines : listWindow || buf.lines;
      const sourceArg = source === buf.lines ? undefined : source;
      const b2u = (window.lib && window.lib.b2uArray) || null;

      // 一列 TermChar → 輸出字元陣列，每個字帶起始欄位與欄寬（與 getRowText 同一套配對）。
      const cellsOf = (line) => {
        const out = [];
        const decodeFail = [];
        const orphans = [];
        for (let c = 0; c < line.length; c++) {
          const ch = line[c];
          if (ch.isLeadByte && c + 1 < line.length) {
            const lead = ch.ch.charCodeAt(0);
            const trail = line[c + 1].ch.charCodeAt(0);
            if (b2u) {
              const pos = (lead << 8) | trail;
              const code = (b2u[2 * pos] << 8) | b2u[2 * pos + 1];
              if (!code) decodeFail.push(c);
            }
            out.push({ col: c, width: 2 });
            c++;
          } else {
            const code = ch.ch.length === 1 ? ch.ch.charCodeAt(0) : 0;
            if (code >= 0x81 && code <= 0xfe) orphans.push(c);
            out.push({ col: c, width: 1 });
          }
        }
        return { out, decodeFail, orphans };
      };

      const norm = (s) => s.replace(/ /g, ' ').replace(/\s+$/, '');
      // 終端機文字節點：排除樓層徽章（零寬盒，數字不屬於格線）與行內預覽等非終端機子樹。
      const SKIP = '.floorBadge, .inlinePreviewSlot, .previewLoading, .previewError';
      const termTextNodes = (lineEl) => {
        const nodes = [];
        const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT, {
          acceptNode: (n) =>
            n.parentElement && n.parentElement.closest(SKIP)
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_ACCEPT,
        });
        for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
        return nodes;
      };

      const container = document.getElementById('mainContainer');
      const lineEls = Array.from(container.querySelectorAll('[data-type="bbsline"]'));
      const report = {
        er,
        listWindow: !!listWindow,
        pageState: buf.pageState,
        rowsInBuf: source.length,
        domRows: lineEls.length,
        checked: 0,
        textMismatch: [],
        gridMisaligned: [],
        decodeFail: [],
        orphanHighBytes: [],
        horizontalOverflow: container.scrollWidth - container.clientWidth,
        chw,
        // 轉碼表沒載入時 decode 檢查等於沒做 ⇒ 呼叫端要斷言它為 true，不能默默放行。
        decoderReady: !!b2u,
      };

      for (const el of lineEls.slice(0, maxRows)) {
        const row = Number(el.getAttribute('data-row'));
        const line = source[row];
        if (!line) continue;
        report.checked++;
        const want = norm(buf.getRowText(row, 0, cols, sourceArg));
        // 解碼檢查只看 buf，與 DOM 無關 ⇒ 先做（DOM 對不上時照樣要報）。
        const { out, decodeFail, orphans } = cellsOf(line);
        if (decodeFail.length) report.decodeFail.push({ row, cols: decodeFail, text: want });
        if (orphans.length) report.orphanHighBytes.push({ row, cols: orphans, text: want });

        const nodes = termTextNodes(el);
        const domText = nodes.map((n) => n.data).join('');
        if (norm(domText) !== want) {
          report.textMismatch.push({ row, dom: norm(domText), buf: want });
          continue; // 文字對不上時格線比對沒有意義
        }

        // 最後一個非空白字（DOM 字串 index 與 out 一一對應，因為文字已確認相同）。
        const flat = domText.replace(/ /g, ' ');
        let k = flat.length - 1;
        while (k >= 0 && /\s/.test(flat[k])) k--;
        if (k < 0 || k >= out.length) continue;
        let idx = k;
        let node = null;
        for (const n of nodes) {
          if (idx < n.data.length) {
            node = n;
            break;
          }
          idx -= n.data.length;
        }
        if (!node) continue;
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + 1);
        const rects = range.getClientRects();
        if (!rects.length) continue;
        const right = rects[rects.length - 1].right - el.getBoundingClientRect().left;
        const expected = (out[k].col + out[k].width) * chw;
        if (Math.abs(right - expected) > gridTolerance) {
          report.gridMisaligned.push({
            row,
            char: flat[k],
            col: out[k].col,
            right: Math.round(right * 10) / 10,
            expected,
          });
        }
      }
      return report;
    },
    { maxRows: opts.maxRows || 400, gridTolerance: opts.gridTolerance || 1.5 }
  );
}

// 把報告濃縮成一行人看得懂的摘要（失敗訊息用）。
function describeSanity(r, label) {
  const head = (a) => JSON.stringify(a.slice(0, 3));
  return (
    `[${label}] pageState=${r.pageState} er=${r.er} listWindow=${r.listWindow} decoder=${r.decoderReady} ` +
    `checked=${r.checked}/${r.domRows} ` +
    `overflowX=${r.horizontalOverflow} | textMismatch=${r.textMismatch.length} ${head(r.textMismatch)} ` +
    `| grid=${r.gridMisaligned.length} ${head(r.gridMisaligned)} ` +
    `| decodeFail=${r.decodeFail.length} ${head(r.decodeFail)} ` +
    `| orphan=${r.orphanHighBytes.length} ${head(r.orphanHighBytes)}`
  );
}

// live 與 offline 共用的門檻：全部為零。落單高位元組（orphanHighBytes）只記錄不判紅——
// PTT 端本身就可能把全形字切在畫面右緣（pfterm 同樣受限，見 term_buf.updateCharAttr 註解）。
function expectScreenSane(r, label) {
  const msg = describeSanity(r, label);
  expect(r.decoderReady, msg).toBe(true);
  expect(r.checked, msg).toBeGreaterThan(0);
  expect(r.textMismatch, msg).toEqual([]);
  expect(r.gridMisaligned, msg).toEqual([]);
  expect(r.decodeFail, msg).toEqual([]);
  expect(r.horizontalOverflow, msg).toBeLessThanOrEqual(0);
}

module.exports = { screenSanity, describeSanity, expectScreenSane };
