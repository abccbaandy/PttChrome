'use strict';

// PTT 的 DDoS/BOT 保護：偵測 + 一次就好的「別再連了」閂鎖。
//
// 為什麼需要這個檔（2026-08-25 實錄）：整輪 live e2e 以前會登入十幾次，短時間內再跑
// 一輪就被 PTT 擋住帳號，接著**每一條都卡在登入閘門**，而 Playwright 預設在 test 失敗
// 後會重啟 worker → 共用 session 的 fixture 重建 → 又登入一次。於是「被鎖」自己會
// 放大成「一直重試」，而每次重試都在延長封鎖。
//
// 這個訊息**不在 pttbbs 開源碼裡**（`3rd_script/pttbbs` 全樹查無「DDoS」「不當連續登入」
// 「暫停連線」），屬 PTT 站方自有的防濫用層 ⇒ 門檻與封鎖時長都無從得知，唯一能做的是
// 「少登入」＋「一偵測到就整輪停手」。開源碼裡真正有的三種擋人機制見
// docs/pttbbs-screen-protocol.md §12。
//
// 閂鎖為什麼要寫檔而不是模組變數：worker 重啟＝新 process，模組變數會歸零。檔案由
// globalSetup 在每輪開跑前刪掉，所以它只在「同一輪」內有效。

const fs = require('fs');
const path = require('path');

// 放 test-results/ 底下：那是 Playwright 自己的輸出目錄，不會進 git。
const MARKER = path.join(process.cwd(), 'test-results', '.ptt-bot-blocked');

// 純函式（unit 守護）：畫面是不是 PTT 的 DDoS/BOT 封鎖頁？
// 實錄兩種句型：
//   [PTT DDoS/BOT 偵測系統] 偵測到連線異常/不當連續登入行為！
//   帳號 xxx 已被暫時禁止登入。
//   [PTT DDoS/BOT 偵測系統] 帳號 xxx 有疑似不當連續登入行為所以暫停連線。
function isBotBlockScreen(text) {
  const s = text || '';
  return (
    s.includes('DDoS') ||
    s.includes('不當連續登入') ||
    s.includes('已被暫時禁止登入') ||
    s.includes('疑似不當')
  );
}

// 給人看的結論。重點是**明講不要重跑**——這是唯一會讓情況變糟的失敗模式。
// 下面三句不是推測，是封鎖畫面自己寫的（2026-08-25 實錄，全文見
// docs/pttbbs-screen-protocol.md §11.2）：
//   「無法申請手動解除鎖定，也不會告知暫停時限」
//   「無任何登入行為之後最多 12 小時後會恢復」
//   「在暫停期間若持續嘗試登入會被視為機器人，將無限期延長暫停時間」
function describeBotBlock(screen) {
  return (
    '結論：**帳號被 PTT 的 DDoS/BOT 防護暫時封鎖**，非本專案 code 問題。\n' +
    '觸發條件＝短時間內大量登入（整輪 live e2e 連跑兩次就會踩到）。\n' +
    '**不要重跑**：畫面明寫「在暫停期間若持續嘗試登入會被視為機器人，將無限期延長暫停時間」。\n' +
    '解除條件是「**無任何登入行為**之後最多 12 小時」，而且無法申請手動解除。\n' +
    '⇒ 停掉所有 live e2e，也**關掉平常瀏覽用的自動登入**（畫面點名「部份App需要關閉自動登入」）。\n' +
    '期間改跑 `yarn test:unit` 與 `yarn test:e2e:offline`（真瀏覽器＋真渲染，不碰 PTT）。\n' +
    '細節見 tests/e2e/README.md。\n' +
    (screen ? `--- 當前畫面 ---\n${screen}\n----------------` : '')
  );
}

// 這一輪已經被判定封鎖了嗎？回結論字串，沒有就 null。
function readBotBlock() {
  try {
    return fs.readFileSync(MARKER, 'utf8');
  } catch (e) {
    return null;
  }
}

// 立閂鎖：之後任何一條 spec 的 login() 都會在**送出任何連線之前**直接失敗。
function markBotBlocked(message) {
  try {
    fs.mkdirSync(path.dirname(MARKER), { recursive: true });
    fs.writeFileSync(MARKER, message);
  } catch (e) {
    // 寫不進去就算了：頂多退回舊行為（會多試幾次），不該因此讓測試爆在別的地方。
  }
}

// globalSetup 用：每輪開跑前清掉，閂鎖只在同一輪內有效。
function clearBotBlock() {
  try {
    fs.unlinkSync(MARKER);
  } catch (e) {
    // 本來就沒有
  }
}

// login()（與兩條自己開 page 的自動登入 spec）在動手前先呼叫：已被鎖就直接丟，
// 一個 byte 都不要再送給 PTT。
function assertNotBotBlocked() {
  const msg = readBotBlock();
  if (msg) throw new Error('略過：這一輪稍早已判定帳號被 PTT 封鎖。\n' + msg);
}

module.exports = {
  MARKER,
  isBotBlockScreen,
  describeBotBlock,
  readBotBlock,
  markBotBlocked,
  clearBotBlock,
  assertNotBotBlocked,
};
