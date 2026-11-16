// App 建構子裡「順序有意義」的 settle 監聽者（架構 review A6 第一步：先把隱含的先後寫成會紅的測試，
// 之後改成功能註冊表時才搬得動）。同一個 screenSettled 裡誰先跑，決定了：
//   1. easyReading → listSession：好讀先對這一幀做完判斷，列表 session 才推動指令佇列的 onDone
//      （aid_navigation 落地時 easy_reading.ensureEnabledOnArticle 才能相信 _enabled 已定）。
//   2. listSession → boardListSession：離開看板列表進板那一幀，文章列表先 engage、看板列表後收攤，
//      收攤的 flushKind 才不會殺掉對方剛排的 prefetch。
//   3. 列表兩支 → boardNoteSkip／helpMenu：同一個 settle 裡開板／補頁命令先完成，代按的鍵才排得上線。
//   4. deepLinkController → reconnectResume → homeDashboard：登入後主功能表那一幀，使用者剛給的連結優先、
//      斷線回原處其次，儀表板最後。
//   5. commentBar → articleNav：導覽軸的下緣要扣掉推文列，推文列要先更新。
// 監聽者沒有名字（多半是 .bind(this)），所以註冊時帶 owner 標籤（event.js#listenerOwners），
// 這裡在真的 boot 起來的 App 上讀派發順序。new App() 在 unit 起不來，只能在這裡驗。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline } = require('../helpers/replay');

const BEFORE = [
  ['easyReading', 'listSession'],
  ['listSession', 'boardListSession'],
  ['listSession', 'boardNoteSkip'],
  ['boardListSession', 'boardNoteSkip'],
  ['listSession', 'helpMenu'],
  ['boardListSession', 'helpMenu'],
  ['deepLinkController', 'reconnectResume'],
  ['deepLinkController', 'homeDashboard'],
  ['reconnectResume', 'homeDashboard'],
  ['commentBar', 'articleNav'],
];

test('screenSettled 的派發順序照 App 建構子的約定', async ({ page }) => {
  await bootOffline(page, ptt);
  const owners = await page.evaluate(() => window.__app.buf.listenerOwners('screenSettled'));
  const names = new Set(BEFORE.flat());
  // 每個都要掛著、而且只掛一次（標籤漏了或重複註冊時，下面的先後比較會靜默失效）。
  for (const n of names) expect(owners.filter((o) => o === n), n).toHaveLength(1);
  for (const [a, b] of BEFORE) expect(owners.indexOf(a), `${a} 要排在 ${b} 前面`).toBeLessThan(owners.indexOf(b));
});
