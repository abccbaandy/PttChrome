// 离线重放「机制本身」的 smoke test —— 不需要任何 cassette。
// 验证三件事，证明离线管线可用：
//   1) installReplay() 的 stub WebSocket 让 app 在「零网络」下成功 connect/onConnect；
//   2) 没有真实 PTT 数据时画面不崩；
//   3) 把任意 bytes 喂进 App.onData 会经 parser→termBuf→<Screen> 渲染到 #mainContainer。
// 这条永远不需要连真实 PTT，也不依赖任何录制素材。
const { test, expect } = require('@playwright/test');
const { installReplay, waitConnected, feedRaw } = require('../helpers/replay');
const { readScreen, dismissDeveloperModeAlert } = require('../helpers/ptt');

test.describe('离线重放 harness', () => {
  test('stub WebSocket 离线 boot + onData 喂入能渲染到 #mainContainer', async ({ page }) => {
    await installReplay(page); // 必须在 goto 之前覆写 window.WebSocket
    await page.goto('/');
    await dismissDeveloperModeAlert(page);

    // 零网络下仍能「连上」（onConnect → connectState=1）。
    await waitConnected(page);

    // 喂一段最小 ANSI：清屏 + home + 一行可辨识文字。
    await feedRaw(page, '\x1b[2J\x1b[H  HELLO OFFLINE REPLAY  ');
    await page.waitForTimeout(500);

    const screen = await readScreen(page);
    expect(screen).toContain('HELLO OFFLINE REPLAY');
  });
});
