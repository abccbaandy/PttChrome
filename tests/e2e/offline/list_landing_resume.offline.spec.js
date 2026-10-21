// 列表好讀 · 重新整理（F5）「落地即回好讀」—— 離線重放版（stub WebSocket + cassette，
// 真瀏覽器／真渲染／真 F5 鍵）。
//
// 守的是體感延遲（同右鍵「前已讀後未讀」那條優化，錄製檔 ptt-debug-20261020-161646）：
// 舊流程是「切原生鏡像（PTT 的 CompleteBoard prompt 畫給使用者看）→ 板名⏎ → 空等
// 靜置探針 250ms → rebuild 切回好讀」，畫面翻面兩次。現在整段是凍結交易：
//   1) 送出板名那一刻畫面仍凍著，prompt 沒畫進 #mainContainer；
//   2) 列表一落地就回好讀，全程沒有任何一幀是原生鏡像。
// cassette 不回應 `s` 與板名（真 server 才會），兩個回應由測試自己餵：prompt 幀照
// pttbbs CompleteBoard 的版型手繪，落地幀＝按 F5 之前的同一張列表（重新整理本來就
// 游標原地、內容同一頁）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayListCassette, waitScreenSettled } = require('../helpers/replay');

const mark = loadCassette('cchat-list-mark');

async function listState(page) {
  return page.evaluate(() => {
    const app = window.__app;
    return {
      state: app.listSession.state,
      renderMode: app.buf.listRenderMode,
      queueIdle: app.commandQueue.idle
    };
  });
}

async function engage(page) {
  await bootOffline(page, ptt);
  await replayListCassette(page, mark);
  await page.waitForFunction(() => window.__app.buf.pageState === 2);
  await ptt.applyPrefs(page, {
    enableEasyReadingList: true,
    enableListNativeAutoResume: true,
    easyReadingListPrefetchCount: 0
  });
  await expect
    .poll(async () => {
      const s = await listState(page);
      return s.state === 'active' && s.renderMode === 'buffer' && s.queueIdle;
    })
    .toBe(true);
}

// 把一段 Unicode 文字轉成 Big5 bytes（latin1 字串）送進 App.onData。
async function feedText(page, parts) {
  await page.evaluate((ps) => {
    const u2b = (str) => {
      let out = '';
      for (const ch of str) {
        const c = ch.charCodeAt(0);
        if (c < 0x80) {
          out += ch;
          continue;
        }
        out += String.fromCharCode(window.lib.u2bArray[2 * c]) + String.fromCharCode(window.lib.u2bArray[2 * c + 1]);
      }
      return out;
    };
    window.__app.onData(ps.map((p) => (p.raw ? p.raw : u2b(p.text))).join(''));
  }, parts);
}

test.describe('列表好讀 · 重新整理落地即回好讀（離線重放）', () => {
  test.skip(!mark, '缺 cchat-list-mark cassette（先 yarn record:cassette）');

  test('F5：s → 板名⏎ 全程凍著、prompt 不畫給使用者看；落地即回好讀，沒有一幀是原生', async ({ page }) => {
    test.setTimeout(90000);
    const logs = ptt.attachConsole(page);
    try {
      await engage(page);

      // 按 F5 之前的列表（落地幀照它重畫）與看板名。
      const snap = await page.evaluate(() => {
        const buf = window.__app.buf;
        const rows = [];
        for (let r = 0; r < buf.rows; ++r) rows.push(buf.getRowText(r, 0, buf.cols));
        return { rows, curX: buf.cur_x, curY: buf.cur_y };
      });
      const board = (snap.rows[0].match(/看板《([^》]+)》/) || [])[1];
      expect(board).toBeTruthy();

      // 每一幀記下列表的 render 模式：舊流程的原生鏡像至少停 250ms（靜置探針），
      // rAF 一定取得到樣本。
      await page.evaluate(() => {
        window.__modes = [];
        const tick = () => {
          const m = window.__app.buf.listRenderMode;
          if (window.__modes[window.__modes.length - 1] !== m) window.__modes.push(m);
          window.__modesRaf = requestAnimationFrame(tick);
        };
        tick();
        window.__app.setInputAreaFocus();
      });

      const before = await page.evaluate(() => window.__replay.sent.length);
      await page.keyboard.press('F5');
      await page.waitForFunction(
        (from) => window.__replay.sent.slice(from).includes('s\f'),
        before,
        { timeout: 10000 }
      );

      // PTT 的 CompleteBoard prompt（bbs.c#do_select → namecomplete，輸入在第 2 列）。
      await feedText(page, [
        { raw: '\x1b[2;1H\x1b[K' },
        { text: '請輸入看板名稱(按空白鍵自動搜尋): ' }
      ]);

      // 板名⏎ 送出的那一刻：仍是凍結畫面，prompt 沒畫給使用者看。
      const atSubmit = await (
        await page.waitForFunction(
          ({ k, i }) => {
            if (!window.__replay.sent.slice(i).includes(k)) return false;
            const lines = Array.from(
              document.querySelectorAll('#mainContainer [data-type="bbsline"]')
            ).map((el) => el.textContent || '');
            return {
              renderMode: window.__app.buf.listRenderMode,
              promptPainted: lines.some((t) => t.includes('請輸入看板名稱'))
            };
          },
          { k: board + '\r\f', i: before },
          { timeout: 10000, polling: 'raf' }
        )
      ).jsonValue();
      expect(atSubmit).toEqual({ renderMode: 'frozen', promptPainted: false });

      // 落地：PTT 重畫同一張列表、游標原地（getkeep）。標題列與表頭是反白整列
      // （列表指紋的一部分，list_session.classifyListScreen）。
      const parts = [{ raw: '\x1b[2J' }];
      snap.rows.forEach((t, r) => {
        const reversed = r === 0 || r === 2;
        parts.push({ raw: '\x1b[' + (r + 1) + ';1H' + (reversed ? '\x1b[7m' : '') });
        parts.push({ text: reversed ? t : t.replace(/\s+$/, '') });
        if (reversed) parts.push({ raw: '\x1b[0m' });
      });
      parts.push({ raw: '\x1b[' + (snap.curY + 1) + ';' + (snap.curX + 1) + 'H' });
      await feedText(page, parts);
      await waitScreenSettled(page, { 0: board });

      await expect
        .poll(async () => {
          const s = await listState(page);
          return s.state === 'active' && s.renderMode === 'buffer';
        })
        .toBe(true);
      const modes = await page.evaluate(() => {
        cancelAnimationFrame(window.__modesRaf);
        return window.__modes;
      });
      expect(modes).not.toContain('native');
      expect(modes).toContain('frozen');
      await expect(page.locator('.ListHint')).toContainText('已重新整理');
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });
});
