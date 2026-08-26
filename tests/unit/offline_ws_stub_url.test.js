// 離線重放 stub WebSocket 的「攔哪一條連線」判準（helpers/replay.js#isBbsSocketUrl）。
//
// 背景（偶發紅的根因）：installReplay 覆寫的是**全域** window.WebSocket，於是
// Vite dev server 的 HMR socket 也一起被接管 —— HMR client 送出的
// `vite:forward-console` JSON 被記進 window.__sent / __replay.sent，混進
// 「app 送給 PTT 的 bytes」裡。症狀：long_push.offline 的
//   expect(await sentText(page)).toBe('X')
// 拿到 'X{"type":"custom","event":"vite:forward-console",...}'。頁面裡冒出任何
// console error / unhandled rejection 才會觸發轉發 ⇒ 偶發而非必現。
// 連帶：window.__stubWS 也會被後建立的 HMR socket 覆蓋掉。
import { isBbsSocketUrl } from "../../tests/e2e/helpers/replay.js";

describe("離線重放：只攔 BBS 那條 WebSocket", () => {
  test("app 的 BBS 連線要攔（dev 走本機 proxy，prod 走 ws.ptt.cc）", () => {
    for (const u of [
      "ws://localhost:8080/bbs",
      "ws://127.0.0.1:8080/bbs",
      "ws://[::1]:8080/bbs",
      "wss://ws.ptt.cc/bbs",
      "wss://ptt-proxy.example.workers.dev/bbs",
    ]) {
      expect(isBbsSocketUrl(u)).toBe(true);
    }
  });

  test("Vite HMR socket 不攔（REGRESSION：曾被記進送出紀錄）", () => {
    for (const u of [
      "ws://localhost:8080/?token=abc123",
      "ws://localhost:8080/",
      "ws://127.0.0.1:5173/?token=x",
      "ws://localhost:8080/__vite_hmr",
    ]) {
      expect(isBbsSocketUrl(u)).toBe(false);
    }
  });

  test("不合法 URL 不攔（寧可放行給原生 WebSocket，也不要誤吞別人的連線）", () => {
    expect(isBbsSocketUrl("not a url")).toBe(false);
    expect(isBbsSocketUrl(undefined)).toBe(false);
  });
});
