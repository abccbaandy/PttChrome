'use strict';

// 每輪 `playwright test` 開跑前跑一次。
//
// 目前唯一的職責：清掉 DDoS/BOT 封鎖閂鎖（tests/e2e/helpers/bot_block.js）。
// 那個閂鎖是寫檔的（要跨 worker 重啟才有效），所以必須有人負責讓它「只在同一輪內
// 有效」——否則一次被鎖之後，之後每一輪都會直接略過，看起來像測試壞掉。
const { clearBotBlock } = require('./helpers/bot_block');

module.exports = async () => {
  clearBotBlock();
};
