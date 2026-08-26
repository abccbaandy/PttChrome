// 离线重放「机制本身」的 smoke test —— 不需要任何 cassette。
// 验证三件事，证明离线管线可用：
//   1) installReplay() 的 stub WebSocket 让 app 在「零网络」下成功 connect/onConnect；
//   2) 没有真实 PTT 数据时画面不崩；
//   3) 把任意 bytes 喂进 App.onData 会经 parser→termBuf→<Screen> 渲染到 #mainContainer。
// 这条永远不需要连真实 PTT，也不依赖任何录制素材。
const { test, expect } = require('@playwright/test');
const { installReplay, waitConnected, feedRaw } = require('../helpers/replay');
const { readScreen } = require('../helpers/ptt');

test.describe('离线重放 harness', () => {
  test('stub WebSocket 离线 boot + onData 喂入能渲染到 #mainContainer', async ({ page }) => {
    await installReplay(page); // 必须在 goto 之前覆写 window.WebSocket
    await page.goto('/');

    // 零网络下仍能「连上」（onConnect → connectState=1）。
    await waitConnected(page);

    // 喂一段最小 ANSI：清屏 + home + 一行可辨识文字。
    await feedRaw(page, '\x1b[2J\x1b[H  HELLO OFFLINE REPLAY  ');
    await page.waitForTimeout(500);

    const screen = await readScreen(page);
    expect(screen).toContain('HELLO OFFLINE REPLAY');
  });

  // REGRESSION：stub 覆写的是**全域** window.WebSocket，一度连 Vite dev server 的
  // HMR socket 也接管 ⇒ HMR client 送出的 `vite:forward-console` JSON 被记进
  // __stubWSSent，混进「app 送给 PTT 的 bytes」。症状是偶发红：
  //   long_push.offline「送出期间键盘不会漏到 PTT」期望 sentText === 'X'，
  //   实际拿到 'X{"type":"custom","event":"vite:forward-console",...}'。
  // 触发条件＝页面里冒出 console error / unhandled rejection，所以这里主动制造一个。
  test('送出纪录只收 BBS 那条连线的 bytes，不混进 Vite HMR 流量', async ({ page }) => {
    await installReplay(page);
    await page.goto('/');
    await waitConnected(page);

    // stub 只该接管 /bbs；__stubWS 不可被后建立的 HMR socket 盖掉。
    expect(await page.evaluate(() => window.__stubWS.url)).toContain('/bbs');

    await page.evaluate(() => {
      window.__sent = [];
      window.__stubWSSent = (s) => window.__sent.push(s);
      // Vite 的 client 会把 unhandled rejection 转发回 dev server（走 HMR socket）。
      Promise.reject(new Error('offline harness: forced console forward'));
      console.error('offline harness: forced console forward');
    });
    await page.waitForTimeout(500);

    expect(await page.evaluate(() => (window.__sent || []).join(''))).toBe('');
  });
});
