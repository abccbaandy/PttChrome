// 在**列表好读**上关设定页，不可以被踢到原生镜像（离线重放，真浏览器／真渲染）。
//
// REGRESSION 2026-09-20，与「进文章第一个 PageDown 卡 620ms」同一个根因：78c276a
// 把**使用者按键**的 cursor-sync 守门（adoptUserBytes）挂在 term_view._send 上，理由
// 写的是「全专案唯一的使用者 byte 出口」—— 但走那个出口的还有一票**机器**送出，其中
// `switchToEasyReadingMode` 末尾那个 ^L 整页重绘是**无条件**的（pref_save.js 每次关框
// 都呼它）。
//
// 于是在列表好读（renderMode 'buffer'、state 'active'）下：
//   ^L → decideUserBytes 回 ADOPT（它刻意不看 byte 内容）
//      → list_session._beginPassthroughBytes('\x0c')
//      → _enterFunctionMode()（native excursion，连 cache 一起丢，不变量 15）
//      → 闪「已切至原生操作」
// ⇒ **开个设定页再关掉，好读列表就没了**。
//
// 修法是把那两个机器送出移到 App.sendMachineBytes（机器出口，不经守门）。推导见
// src/js/pttchrome.jsx#sendMachineBytes 与 docs/easy-reading-list.md §12e。
//
// 姊妹档：pref_close_in_prompt.offline.spec.js 守的是**文章**好读停在 prompt 上关设定
// 页那一组（2026-08 的全黑 bug），只涵盖文章侧 —— 列表侧在这次之前完全没有测试。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const {
  loadCassette,
  bootOffline,
  replayListCassette,
} = require('../helpers/replay');

const nav = loadCassette('cchat-list-nav');

const dump = (page) =>
  page.evaluate(() => ({
    state: window.__app.listSession.state,
    renderMode: window.__app.buf.listRenderMode,
    listLen: (window.__app.buf.listLines || []).length,
    // 列表好读自己画的第二层卷动视口：切原生镜像会把它收掉（→ -1）。
    viewportPx: (() => {
      const v = document.querySelector('#mainContainer .listBodyView');
      return v ? v.clientHeight : -1;
    })(),
  }));

test.describe('列表好读：关设定页（离线）', () => {
  test('REGRESSION：关设定页不得把好读列表踢成原生镜像', async ({ page }) => {
    test.setTimeout(90000);
    const logs = ptt.attachConsole(page);
    try {
      await bootOffline(page, ptt);
      await replayListCassette(page, nav);
      await page.waitForFunction(() => window.__app.buf.pageState === 2);
      await ptt.applyPrefs(page, { enableEasyReadingList: true });
      await page.waitForFunction(
        () => {
          const app = window.__app;
          return (
            app.listSession.state === 'active' &&
            app.buf.listRenderMode === 'buffer' &&
            (app.buf.listLines || []).length > 30 &&
            app.commandQueue.idle
          );
        },
        null,
        { timeout: 20000 }
      );
      const before = await dump(page);
      expect(before.viewportPx).toBeGreaterThan(0); // 好读列表真的在画面上

      // 记下关框会送出哪些 byte，以及有没有 enqueue cursor-sync 腿。
      await page.evaluate(() => {
        window.__probe = { sent: [], kinds: [], hints: [] };
        const app = window.__app;
        const origStub = window.__stubWSSent;
        window.__stubWSSent = (s) => {
          window.__probe.sent.push(s);
          if (origStub) origStub(s);
        };
        const q = app.commandQueue;
        const origEnqueue = q.enqueue.bind(q);
        q.enqueue = (cmd) => {
          window.__probe.kinds.push(cmd && cmd.kind);
          return origEnqueue(cmd);
        };
        const origHint = app.view.flashListHint.bind(app.view);
        app.view.flashListHint = (msg, ms) => {
          window.__probe.hints.push(msg);
          return origHint(msg, ms);
        };
      });

      // 关设定页：PrefModal 的 X／点外／Esc 全部汇流到这里（同 pref_save.js）。
      await page.evaluate(() =>
        window.__app.switchToEasyReadingMode(window.__app.view.useEasyReadingMode)
      );
      await page.waitForTimeout(400);

      const after = await dump(page);
      const probe = await page.evaluate(() => window.__probe);

      // ---- 本 bug 的判准 ----
      // 修前：ADOPT → _beginPassthroughBytes → _enterFunctionMode ⇒ 这三条全变。
      expect(after.state).toBe('active');
      expect(after.renderMode).toBe('buffer');
      expect(after.viewportPx).toBeGreaterThan(0);
      // 缓冲不该被丢掉（native excursion 会清掉板名并逼下一次 settle 重建）
      expect(after.listLen).toBe(before.listLen);
      // 不该有 cursor-sync 腿 / 代送：机器重绘不是使用者按键
      expect(probe.kinds.filter((k) => k && k !== 'prefetch')).toEqual([]);
      expect(probe.hints.filter((m) => m.includes('已切至原生'))).toEqual([]);
      // ^L 本身仍要真的上线（重绘请求不能被顺手吞掉）
      expect(probe.sent.join('')).toContain('\x0c');
    } catch (e) {
      console.log('--- console tail ---');
      for (const l of logs.slice(-25)) console.log(l);
      throw e;
    }
  });
});
