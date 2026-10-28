// 「登出並關閉 App」的原生端（docs/android-app.md bridge 'quitApp'）。網頁只在 APK 於
// window.__PTT_ANDROID__ 宣告 quitApp 時才給這個選項（android_bridge.js#androidCanQuit），
// 宣告了卻沒接 op ⇒ 按下去 App 不關、也沒有任何回饋。原生沒有 JVM 可跑的測試，靜態掃描守住：
//   1. config 宣告與 WebMessageListener 的 "quitApp" 分支同時存在；
//   2. 通知的「中斷連線並關閉」與 bridge 走同一個 ConnectionService.quit()（不要長出兩套收尾）。
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../android/app/src/main/java/io/github/abccbaandy/pttchrome");
const activity = readFileSync(join(dir, "MainActivity.kt"), "utf8");
const service = readFileSync(join(dir, "ConnectionService.kt"), "utf8");

// 取出 `fun quit() { ... }` 的本體（以括號配對）。
function funBody(text, sig) {
  const i = text.indexOf(sig);
  if (i < 0) return "";
  let j = text.indexOf("{", i);
  let depth = 0;
  const start = j;
  for (; j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}" && --depth === 0) break;
  }
  return text.slice(start, j + 1);
}

test("config 宣告 quitApp，WebMessageListener 也接了 quitApp", () => {
  expect(activity).toMatch(/\.put\("quitApp",\s*true\)/);
  expect(activity).toMatch(/"quitApp"\s*->\s*\{[^}]*service\?\.quit\(\)/);
});

test("ConnectionService.quit() 收掉連線、畫面與前景服務；通知按鈕也走它", () => {
  const body = funBody(service, "fun quit()");
  expect(body).toMatch(/proxy\.disconnectAll\(\)/);
  expect(body).toMatch(/onQuitRequested\?\.invoke\(\)/);
  expect(body).toMatch(/stopForeground\(/);
  expect(body).toMatch(/stopSelf\(\)/);
  const quitBranch = funBody(service, "if (intent?.action == ACTION_QUIT)");
  expect(quitBranch).toMatch(/\bquit\(\)/);
  expect(quitBranch).not.toMatch(/disconnectAll/);
});
