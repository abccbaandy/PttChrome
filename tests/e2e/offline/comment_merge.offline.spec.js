// 好讀「連續同作者推文合併」（預設開）—— 離線重放守門。
// 核心不變量：渲染後相鄰的推文列不得同 pusher（同作者連續列必已合併）。
// 指名素材 stock-end（rz2x 連續 7 則）：七則合成一塊、首則樓號徽章、內容零遺失、
// 關開關即還原逐列。pusher 一律讀 data-pusher 屬性（樓號徽章數字會混進 textContent，
// 正則解析會誤判）。
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const {
  findCassettes,
  bootOffline,
  replayCassette,
  mountLazyPreviewsAt,
} = require('../helpers/replay');
// 量座標前一律先等版面停（helpers/layout.js 是判準的單一來源）。
const { waitPreviewsSettled } = require('../helpers/layout');

const articles = findCassettes('article');

// DOM 順序的 bbsrow 快照：data-pusher（推文列才有）+ 是否在合併塊內。
const readRows = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('#mainContainer span[type="bbsrow"]')).map((el) => ({
      pusher: el.getAttribute('data-pusher'),
      merged: !!el.closest('.mergedCommentBlock'),
      text: el.textContent,
    }))
  );

test.describe('推文合併 · 相鄰不同 pusher 不變量（逐卷）', () => {
  if (!articles.length) {
    test.skip('尚無 article cassette；先 yarn record:cassette', () => {});
  }

  for (const article of articles) {
    test(`相鄰推文列不得同 pusher [${article.__file}]`, async ({ page }) => {
      test.setTimeout(90000);
      await bootOffline(page, ptt);
      // 不顯式傳 mergeSameAuthorComments —— 驗「預設即開」。
      await ptt.applyPrefs(page, { enableEasyReading: true, showFloorNumbers: true });
      await replayCassette(page, article, { easyReading: true });

      const rows = await readRows(page);
      expect(rows.length).toBeGreaterThan(0);
      for (let i = 1; i < rows.length; i++) {
        if (rows[i].pusher && rows[i - 1].pusher) {
          expect(rows[i].pusher).not.toBe(rows[i - 1].pusher);
        }
      }
    });
  }
});

test.describe('推文合併 · stock-end 指名斷言（rz2x×7）', () => {
  const cassette = articles.find((a) => a.__file === 'stock-end.json');
  const fixturePath = path.join(__dirname, '../../unit/fixtures/replay/stock-end.page.json');
  test.skip(!cassette || !fs.existsSync(fixturePath), '缺 stock-end cassette/fixture');

  test('七則合成一塊：首則樓號徽章、內容零遺失、末則時間', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true, showFloorNumbers: true });
    await replayCassette(page, cassette, { easyReading: true });

    // rz2x 只剩一列（7 → 1），且在合併塊內。
    const rows = await readRows(page);
    const rz = rows.filter((r) => r.pusher === 'rz2x');
    expect(rz.length).toBe(1);
    expect(rz[0].merged).toBe(true);

    // 首則樓號徽章＋首則時間標籤。
    const block = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('.mergedCommentBlock')).find((b) => {
        const row = b.querySelector('span[type="bbsrow"]');
        return row && row.getAttribute('data-pusher') === 'rz2x';
      });
      if (!el) return null;
      const floor = el.querySelector('[data-floor]');
      // 一則一行＝一個 bbsline span（自動開圖掛在各自那行下面）→ 逐行讀文字。
      const rowLines = Array.from(el.querySelectorAll('[data-type="bbsline"]')).map(
        (n) => n.textContent
      );
      return {
        text: el.textContent,
        rowLines,
        floor: floor ? floor.textContent : null,
        floorWidth: floor ? floor.offsetWidth : null,
      };
    });
    expect(block).not.toBeNull();
    expect(block.floor).toMatch(/^\d+$/);
    // 徽章 width:0 疊字（不佔水平空間）→ 作者 id 與相鄰單則推文同起始欄、不被往右推。
    // 若覆寫成 width:auto（舊範圍徽章作法）此值會 >0，作者歪掉。
    expect(block.floorWidth).toBe(0);
    // 一則一行（2026-08 使用者定案，取代舊的 gap 猜續行）：七則＝七個 bbsline。
    const lines = block.rowLines;
    expect(lines).toHaveLength(7);
    // 作者在第一則行首、時間在**最後一則**行尾（使用者 2026-08 定案），各只一次。
    expect(lines[0]).toContain('rz2x');
    expect(lines.slice(1).some((l) => l.includes('rz2x'))).toBe(false);
    expect(lines.join('\n').match(/\d{1,2}\/\d{2} \d{2}:\d{2}/g)).toHaveLength(1);
    expect(lines[lines.length - 1]).toMatch(/\d{1,2}\/\d{2} \d{2}:\d{2}$/);

    // 內容零遺失：golden 七則 rz2x 的內容子字串皆須在塊內。
    const golden = JSON.parse(fs.readFileSync(fixturePath, 'utf8')).golden;
    const contents = golden.comments
      .filter((s) => /^(推|噓|→)\s+rz2x\s*:/i.test(s))
      .map((s) =>
        s
          .replace(/^(推|噓|→)\s+[0-9A-Za-z]+\s*:\s*/, '')
          .replace(/\s*\d{1,2}\/\d{2}\s+\d{2}:\d{2}\s*$/, '')
          .trim()
      )
      .filter(Boolean);
    expect(contents.length).toBe(7);
    for (const c of contents) {
      expect(block.text).toContain(c);
    }

    // 時間戳必須可複製：^C 走 window.getSelection().toString()（term_view.js），
    // 而 user-select:none 的節點會被排除在選取字串外（舊 .mergedCommentTime 即是）。
    const selected = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('.mergedCommentBlock')).find((b) => {
        const row = b.querySelector('span[type="bbsrow"]');
        return row && row.getAttribute('data-pusher') === 'rz2x';
      });
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return sel.toString();
    });
    expect(selected).toMatch(/\d{1,2}\/\d{2} \d{2}:\d{2}/);
  });

  // 使用者 2026-08 回報症狀 2：合併後的第 2 則回到第 0 欄。懸掛縮排是純 CSS
  // （bbsrow padding-left + 首則 bbsline 的負 margin），jsdom 無 layout 量不到
  // → 只能在真瀏覽器守。
  test('懸掛縮排：第 2 行起與第一則內容同一起始 x', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true, showFloorNumbers: true });
    await replayCassette(page, cassette, { easyReading: true });
    await waitPreviewsSettled(page);

    const geo = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('.mergedCommentBlock')).find((b) => {
        const row = b.querySelector('span[type="bbsrow"]');
        return row && row.getAttribute('data-pusher') === 'rz2x';
      });
      if (!el) return null;
      // 一則一行＝一個 bbsline span，各自量左緣。
      const lefts = Array.from(el.querySelectorAll('[data-type="bbsline"]')).map(
        (n) => n.getBoundingClientRect().left
      );
      const indent = parseFloat(
        getComputedStyle(el.querySelector('span[type="bbsrow"]')).paddingLeft
      );
      return { lefts, boxLeft: el.getBoundingClientRect().left, indent };
    });
    expect(geo).not.toBeNull();
    expect(geo.indent).toBeGreaterThan(0);
    expect(geo.lefts.length).toBe(7);
    // 第一行被負 margin 拉回塊左緣；其餘行落在 padding 邊 ＝ 首則內容起始欄。
    expect(Math.abs(geo.lefts[0] - geo.boxLeft)).toBeLessThan(1.5);
    for (const left of geo.lefts.slice(1)) {
      expect(Math.abs(left - (geo.boxLeft + geo.indent))).toBeLessThan(1.5);
    }
  });

  // 使用者 2026-08 要求：時間「比照原生置右」，不是跟著最後一則內容的結束位置。
  // 對齊靠的是「末行原樣帶走原列的 padding」（comment_merge.js），純資料無 CSS，
  // 但欄→像素的換算只有真瀏覽器算得出來 → 直接跟同頁的原生推文列比時間戳 x 座標。
  test('時間置右：與同頁原生推文列的時間戳同一 x 位置', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true, showFloorNumbers: true });
    await replayCassette(page, cassette, { easyReading: true });
    await waitPreviewsSettled(page);

    const geo = await page.evaluate(() => {
      const TIME_RE = /\d{1,2}\/\d{2} \d{2}:\d{2}/;
      // 跨多個色段 span 取子字串的 rect：走 text node 攤平後建 Range。
      const rectOfLastMatch = (el) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const nodes = [];
        let acc = '';
        while (walker.nextNode()) {
          nodes.push([walker.currentNode, acc.length]);
          acc += walker.currentNode.data;
        }
        const m = acc.match(new RegExp(TIME_RE.source + '(?![\\s\\S]*' + TIME_RE.source + ')'));
        if (!m) return null;
        const at = (pos) => {
          for (let i = nodes.length - 1; i >= 0; --i) {
            if (pos >= nodes[i][1]) return [nodes[i][0], pos - nodes[i][1]];
          }
          return null;
        };
        const [sn, so] = at(m.index);
        const [en, eo] = at(m.index + m[0].length - 1);
        const r = document.createRange();
        r.setStart(sn, so);
        r.setEnd(en, eo + 1);
        const box = r.getBoundingClientRect();
        return { left: box.left, right: box.right };
      };
      const rows = Array.from(document.querySelectorAll('#mainContainer span[type="bbsrow"]'));
      const merged = rows.find(
        (r) => r.getAttribute('data-pusher') === 'rz2x' && r.closest('.mergedCommentBlock')
      );
      const native = rows.find(
        (r) => r.getAttribute('data-pusher') && !r.closest('.mergedCommentBlock')
      );
      if (!merged || !native) return null;
      return {
        merged: rectOfLastMatch(merged),
        native: rectOfLastMatch(native),
      };
    });
    expect(geo).not.toBeNull();
    expect(geo.merged).not.toBeNull();
    expect(geo.native).not.toBeNull();
    // 同一欄起訖（±1.5px 容次像素誤差）。舊做法「接在內容尾端」會差好幾十 px。
    expect(Math.abs(geo.merged.left - geo.native.left)).toBeLessThan(1.5);
    expect(Math.abs(geo.merged.right - geo.native.right)).toBeLessThan(1.5);
  });

  // 使用者 2026-08 回報：合併塊的自動開圖全部堆在整塊最下面，應該像文章內文一樣
  // 跟在「含該連結的那一行」下面。
  test('自動開圖跟在含連結的那一則下面，不是整塊最後', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true, showFloorNumbers: true });
    await replayCassette(page, cassette, { easyReading: true });

    // 自動開圖是延遲載入的（LazyInlinePreview）：先把該合併塊捲進視野等預覽掛上，
    // 否則量到的永遠是空的佔位盒。標記出目標塊供 helper 用 selector 指到它。
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('.mergedCommentBlock')).find((b) => {
        const row = b.querySelector('span[type="bbsrow"]');
        return row && row.getAttribute('data-pusher') === 'rz2x';
      });
      if (el) el.setAttribute('data-e2e-target', '1');
    });
    const mounted = await mountLazyPreviewsAt(page, '[data-e2e-target]');
    console.log(`[merge/lazy] previews mounted in rz2x block: ${mounted}`);

    const groups = await page.evaluate(() => {
      const PREVIEW = '.previewLoading, .previewError, .easyReadingImg, .easyReadingVideo';
      const el = document.querySelector('[data-e2e-target]');
      if (!el) return null;
      // 攤平成 DOM 順序的事件流：每遇到一個 bbsline 開一個新群組，預覽記到當前群組。
      const out = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (child.matches('[data-type="bbsline"]')) {
            out.push({ text: child.textContent, previews: 0 });
            continue;
          }
          if (child.matches(PREVIEW)) {
            if (out.length) out[out.length - 1].previews++;
            continue;
          }
          walk(child);
        }
      };
      walk(el);
      return out;
    });
    expect(groups).not.toBeNull();
    // 七則各自成行。
    expect(groups.length).toBe(7);
    // 有預覽的行必定自己就含連結（＝預覽跟對行了）。反向不成立：非圖片連結
    // （如 x.com）本來就不開圖。
    for (const g of groups) {
      if (g.previews > 0) expect(g.text).toMatch(/https?:\/\//);
    }
    // 真的分散到多行，而不是全部堆在某一行。
    expect(groups.filter((g) => g.previews > 0).length).toBeGreaterThan(1);
    // 舊症狀的直接反例：最後一則（「沒斷!」無連結）下面不得有任何預覽。
    expect(groups[groups.length - 1].text).not.toMatch(/https?:\/\//);
    expect(groups[groups.length - 1].previews).toBe(0);
  });

  test('關開關（runtime applyPrefs）→ 還原逐列', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true, showFloorNumbers: false });
    await replayCassette(page, cassette, { easyReading: true });

    expect((await readRows(page)).filter((r) => r.pusher === 'rz2x').length).toBe(1);

    await ptt.applyPrefs(page, { mergeSameAuthorComments: false }); // onPrefChange → redraw
    // 全量重建會把每個佔位盒 disposeNode 掉重做（新 slot 的 minHeight 從 memo 接手，
    // 但圖要重新掛載）⇒ 固定 800ms 在圖回得慢時只量到中間態。
    await waitPreviewsSettled(page);

    const rows = await readRows(page);
    expect(rows.filter((r) => r.pusher === 'rz2x').length).toBe(7);
    expect(rows.some((r) => r.merged)).toBe(false);
  });
});
