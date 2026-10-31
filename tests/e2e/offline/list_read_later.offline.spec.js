// 文章列表右鍵「稍後再讀」（P53，list_session.readLaterAt、docs/recent-articles.md）——
// 真瀏覽器＋完整 boot 鏈＋真右鍵。
//
// 素材：upstream pttbbs 原始碼產的畫面（tests/unit/fixtures/ptt_src_screens/post_info.json，
// tools/ptt-src-screens 的 post_info 場景：文章列表 → Q 資訊框 → 空白關框）。列表幀當 cassette
// 首幀，Q 與空白的回應由頁面裡的假 PTT 同一個 task 之後餵（凍結交易的窗口很短，從測試端等
// 送出再餵會量到自己的往返，同 list_landing_resume）。
//
// 守的是：①送的只有 Q 和關框的空白（Q 不可以尾附 \f，會被 pressanykey 吃掉）；②問到的 AID
// 收進稍後再讀、標題取列表那一列；③全程凍著，關框落地就回列表好讀、沒有一幀是原生鏡像。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, replayListCassette } = require('../helpers/replay');
const { rightClickElement } = require('../helpers/real_input');
const fx = require('../../unit/fixtures/ptt_src_screens/post_info.json');

const KEY = 'pttchrome.recentArticles.v1';
const b64 = (s) => Buffer.from(s, 'latin1').toString('base64');
const frame = (name) => fx.frames.find((f) => f.name === name).bytes;
const cassette = {
  meta: { mode: 'scenario', scenario: 'post-info', prefs: {} },
  cols: fx.cols,
  rows: fx.rows,
  steps: [{ on: 'start', recv: b64(frame('list')) }],
};

const listState = (page) =>
  page.evaluate(() => {
    const app = window.__app;
    return { state: app.listSession.state, renderMode: app.buf.listRenderMode, idle: app.commandQueue.idle };
  });

test('列表右鍵「稍後再讀」⇒ 只送 Q 與空白、收進那一篇、全程不切原生', async ({ page }) => {
  test.setTimeout(90000);
  await bootOffline(page, ptt);
  await replayListCassette(page, cassette);
  await page.waitForFunction(() => window.__app.buf.pageState === 2);
  await ptt.applyPrefs(page, {
    enableEasyReadingList: true,
    enableListNativeAutoResume: true,
    easyReadingListPrefetchCount: 0,
    enableRecentArticles: true,
  });
  await expect
    .poll(async () => {
      const s = await listState(page);
      return s.state === 'active' && s.renderMode === 'buffer' && s.idle;
    })
    .toBe(true);

  // 選取對到 server 真游標、並當作已經到頂（游標同步腿與往上補頁不是這條測的東西，假 PTT 也答
  // 不了跳號；補頁在線上時交易一律先同步，由 unit list_read_later 守）；標出那一列。
  const target = await page.evaluate(() => {
    const ls = window.__app.listSession;
    const server = ls._collectFacts(null).cursorRowNum;
    ls._selectedNum = server;
    ls._serverNum = server;
    ls._edgeUp = true;
    const row = Array.from(document.querySelectorAll('#mainContainer [data-list-title]')).find((el) =>
      Number(((el.textContent || '').match(/^\D*?(\d+)/) || [])[1]) === server
    );
    if (!row) return null;
    row.setAttribute('data-e2e-target', '1');
    return { num: server, title: row.getAttribute('data-list-title') };
  });
  expect(target).not.toBeNull();

  await page.evaluate(
    ({ info, dismissed }) => {
      const app = window.__app;
      const prev = window.__stubWSSent;
      window.__sent = [];
      window.__modes = [];
      const tick = () => {
        const m = app.buf.listRenderMode;
        if (window.__modes[window.__modes.length - 1] !== m) window.__modes.push(m);
        window.__modesRaf = requestAnimationFrame(tick);
      };
      tick();
      window.__stubWSSent = (d) => {
        if (prev) prev(d);
        window.__sent.push(d);
        if (d === 'Q') setTimeout(() => app.onData(info), 0);
        if (d === ' ' || d === ' \f') setTimeout(() => app.onData(dismissed), 0);
      };
    },
    { info: frame('info'), dismissed: frame('dismissed') }
  );

  await rightClickElement(page, '[data-e2e-target]');
  const label = await page.evaluate(() => window.__i18n('cmenu_readLater'));
  await page.locator('.DropdownMenu').first().getByRole('menuitem').filter({ hasText: label }).click();

  await expect
    .poll(async () =>
      page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{"later":[]}').later, KEY)
    )
    .toEqual([expect.objectContaining({ board: 'Test', aid: expect.stringMatching(/^[0-9A-Za-z_-]{8}$/), title: target.title })]);
  await expect(page.locator('.ListHint')).toContainText(await page.evaluate(() => window.__i18n('recent_added')));
  await expect
    .poll(async () => {
      const s = await listState(page);
      return s.state === 'active' && s.renderMode === 'buffer';
    })
    .toBe(true);
  const { sent, modes } = await page.evaluate(() => {
    cancelAnimationFrame(window.__modesRaf);
    return { sent: window.__sent, modes: window.__modes };
  });
  // 單獨的 \f 是指令佇列逾時的探針（command_queue._timedOut）：PTT 的 system_key_hook 吞掉 ^L 只重畫，
  // 不會關掉資訊框（aid_navigation 的 KEY_DISMISS 註解）⇒ 機器忙、畫面晚於 soft 逾時才定下來時會多一個，
  // 不是送鍵。斷言的是「真的按下去的鍵」只有 Q 與空白。
  expect(sent.filter((d) => d !== '\f').map((d) => d.replace(/\f$/, ''))).toEqual(['Q', ' ']);
  expect(sent[0]).toBe('Q');
  expect(modes).not.toContain('native');
  // 落地後選取仍在原本那一篇。
  expect(await page.evaluate(() => window.__app.listSession._selectedNum)).toBe(target.num);
});
