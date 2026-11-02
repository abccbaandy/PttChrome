// PTT 站方的登入封鎖畫面（src/js/login_block.js）。字樣取自實錄（docs/pttbbs-screen-protocol.md
// 「PTT 私有的」）；不在 pttbbs 開源碼裡，所以沒有 upstream 產的畫面可用。
import { isLoginBlockText, isLoginBlockScreen } from "../../src/js/login_block";

const BLOCK = [
  "[PTT DDoS/BOT 偵測系統] 偵測到連線異常/不當連續登入行為！",
  "帳號 xxx 已被暫時禁止登入。",
  "[PTT DDoS/BOT 偵測系統] 帳號 xxx 有疑似不當連續登入行為所以暫停連線。",
];

test("封鎖畫面的每一種字樣都認得", () => {
  for (const line of BLOCK) expect(isLoginBlockText(line)).toBe(true);
});

test("一般登入畫面、mbbsd 的登入太頻繁、密碼錯誤都不是封鎖畫面", () => {
  for (const line of [
    "請輸入代號，或以 guest 參觀，或以 new 註冊:",
    "請勿頻繁登入以免造成系統過度負荷",
    "密碼不對喔，請檢查帳號及密碼大小寫有無輸入錯誤。",
    "",
  ])
    expect(isLoginBlockText(line)).toBe(false);
});

test("isLoginBlockScreen 掃整個畫面", () => {
  const buf = (rows) => ({ rows: 24, cols: 80, getRowText: (y) => rows[y] || "" });
  expect(isLoginBlockScreen(buf({ 3: BLOCK[0] }))).toBe(true);
  expect(isLoginBlockScreen(buf({ 0: "請輸入代號" }))).toBe(false);
  expect(isLoginBlockScreen(null)).toBe(false);
});
