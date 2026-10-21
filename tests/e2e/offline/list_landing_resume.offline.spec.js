// 列表好讀 · 重新整理（F5）「落地即回好讀」—— 離線重放版（stub WebSocket + cassette，
// 真瀏覽器／真渲染／真 F5 鍵）。
//
// 守的是體感延遲（同右鍵「前已讀後未讀」那條優化）：
// 舊流程是「切原生鏡像（PTT 的 CompleteBoard prompt 畫給使用者看）→ 板名⏎ → 空等
// 靜置探針 250ms → rebuild 切回好讀」，畫面翻面兩次。現在整段是凍結交易：
//   1) 送出板名那一刻畫面仍凍著，prompt 沒畫進 #mainContainer；
//   2) 列表一落地就回好讀，全程沒有任何一幀是原生鏡像。
// cassette 不回應 `s` 與板名（真 server 才會），兩個回應由頁面裡的假 PTT 餵（見
// installFakePtt）：prompt 幀照 pttbbs CompleteBoard 的版型手繪，落地幀＝按 F5 之前的
// 同一張列表（重新整理本來就游標原地、內容同一頁）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { loadCassette, bootOffline, replayListCassette } = require('../helpers/replay');

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

// 頁面裡的假 PTT：送出的 bytes 一到（stub WebSocket 的 __stubWSSent，同步呼叫）就在
// 同一個 task 之後餵回應，**不經過 Playwright 往返**。凍結交易第一步的窗口只有
// 250ms＋600ms 探針：從測試端等送出再餵，機器一忙往返就超過窗口，序列自己失敗
// （＝測試在量自己的延遲，不是產品）。送出板名⏎ 的那一刻順手量畫面狀態。
async function installFakePtt(page, snap, board) {
  await page.evaluate(
    ({ snap, board }) => {
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
      // PTT 的 CompleteBoard prompt（bbs.c#do_select → namecomplete，輸入在第 2 列）。
      const prompt = '\x1b[2;1H\x1b[K' + u2b('請輸入看板名稱(按空白鍵自動搜尋): ');
      // 落地：PTT 重畫同一張列表、游標原地（getkeep）。標題列與表頭是反白整列
      // （列表指紋的一部分，list_session.classifyListScreen）。底列一定是 footer：
      // NEWDIRECT 是 FULLUPDATE（read.c#i_read 的 vs_footer）；當下畫面的底列可能是空的
      // （接管後的補頁跳號，舊 server 跳號後底列留空，協定 §4✚），不能照抄。
      const rows = snap.rows.slice();
      rows[rows.length - 1] =
        ' 文章選讀  (y)回應(X)推文(^X)轉錄 (=[]<>)相關主題(/?a)找標題/作者 (b)進板畫面 ';
      let landing = '\x1b[2J';
      rows.forEach((t, r) => {
        const reversed = r === 0 || r === 2;
        landing += '\x1b[' + (r + 1) + ';1H';
        landing += reversed ? '\x1b[7m' + u2b(t) + '\x1b[0m' : u2b(t.replace(/\s+$/, ''));
      });
      landing += '\x1b[' + (snap.curY + 1) + ';' + (snap.curX + 1) + 'H';
      const app = window.__app;
      const prev = window.__stubWSSent;
      window.__atSubmit = null;
      window.__stubWSSent = (d) => {
        if (prev) prev(d);
        if (d === 's\f') setTimeout(() => app.onData(prompt), 0);
        if (d === board + '\r\f') {
          const lines = Array.from(
            document.querySelectorAll('#mainContainer [data-type="bbsline"]')
          ).map((el) => el.textContent || '');
          window.__atSubmit = {
            renderMode: app.buf.listRenderMode,
            promptPainted: lines.some((t) => t.includes('請輸入看板名稱'))
          };
          setTimeout(() => app.onData(landing), 0);
        }
      };
    },
    { snap, board }
  );
}

test.describe('列表好讀 · 重新整理落地即回好讀（離線重放）', () => {
  test.skip(!mark, '缺 cchat-list-mark cassette（先 yarn record:cassette）');

  test('F5：s → 板名⏎ 全程凍著、prompt 不畫給使用者看；落地即回好讀，沒有一幀是原生', async ({ page }) => {
    test.setTimeout(90000);
    const logs = ptt.attachConsole(page);
    try {
      await engage(page);

      // 起點固定在「選取＝server 真游標、線路閒置」：接管後的背景補頁會把真游標移走，
      // 那時 F5 先走游標同步腿（`<編號>⏎`），cassette 答不了任意跳號 ⇒ 同步腿逾時、
      // 照設計降級原生。同步腿不是這條測的東西，所以先等補頁停、再把選取對到真游標。
      await expect
        .poll(() => page.evaluate(() => window.__app.commandQueue.idle), { timeout: 15000 })
        .toBe(true);
      // 按 F5 之前的列表（落地幀照它重畫）與看板名。
      const snap = await page.evaluate(() => {
        const ls = window.__app.listSession;
        const server = ls._collectFacts(null).cursorRowNum;
        if (server != null && ls._selectedNum !== server) {
          ls._selectedNum = server;
          ls._serverNum = server;
        }
        const buf = window.__app.buf;
        const rows = [];
        for (let r = 0; r < buf.rows; ++r) rows.push(buf.getRowText(r, 0, buf.cols));
        return { rows, curX: buf.cur_x, curY: buf.cur_y };
      });
      const board = (snap.rows[0].match(/看板《([^》]+)》/) || [])[1];
      expect(board).toBeTruthy();
      await installFakePtt(page, snap, board);

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

      await page.keyboard.press('F5');

      // 板名⏎ 只在 CompleteBoard prompt 落地後才送；送出那一刻仍是凍結畫面，prompt
      // 沒畫給使用者看。
      await page.waitForFunction(() => window.__atSubmit, null, { timeout: 10000 });
      expect(await page.evaluate(() => window.__atSubmit)).toEqual({
        renderMode: 'frozen',
        promptPainted: false
      });

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
      console.log(
        '--- state ---',
        JSON.stringify(
          await page.evaluate(() => ({
            sent: window.__replay.sent.slice(-12),
            state: window.__app.listSession.state,
            mode: window.__app.buf.listRenderMode,
            inFlight: window.__app.commandQueue.inFlightKind,
            row1: window.__app.buf.getRowText(1, 0, 80),
            cur: [window.__app.buf.cur_x, window.__app.buf.cur_y],
            facts: (() => {
              const f = window.__app.listSession._collectFacts(null);
              return {
                kind: f.kind,
                board: f.boardName,
                cursorRowNum: f.cursorRowNum,
                rev: [f.row0Reversed, f.row2Reversed],
                rows: f.rowTexts
              };
            })()
          }))
        )
      );
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });
});
