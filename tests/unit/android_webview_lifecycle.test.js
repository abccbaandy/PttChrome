// APK 的 WebView 會被換掉（App 設定切換頁面來源、renderer 被回收 ⇒ recreateWebView），
// 延遲回呼若還拿舊的 WebView 呼叫，會打到已 destroy 的物件（實機 logcat：
// "Application attempted to call on a destroyed WebView"）。onPageFinished 又會被網頁的
// history sentinel 反覆觸發，不設閂鎖就每次都排一個 10 秒後的 Resource Timing。
// 原生 WebView 生命週期沒有 JVM 可跑的測試，這裡用靜態掃描守住這兩個寫法。
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(__dirname, "../../android/app/src/main/java/io/github/abccbaandy/pttchrome/MainActivity.kt"),
  "utf8",
);

// 取出 `postDelayed({ ... }, ms)` 的回呼本體（以括號配對，不靠縮排）。
function postDelayedBodies(text) {
  const bodies = [];
  let i = 0;
  while ((i = text.indexOf("postDelayed({", i)) !== -1) {
    let depth = 0;
    let j = i + "postDelayed(".length;
    for (; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}" && --depth === 0) break;
    }
    bodies.push(text.slice(i, j + 1));
    i = j;
  }
  return bodies;
}

test("延遲回呼呼叫 WebView 前先確認它仍是現役的 WebView", () => {
  const touching = postDelayedBodies(src).filter(b => /\bview\.evaluateJavascript/.test(b));
  expect(touching.length).toBeGreaterThanOrEqual(1); // 掃描本身有效
  for (const body of touching) expect(body).toMatch(/webView !== view/);
});

test("onPageFinished 的 Resource Timing 每個 WebView 只排一次", () => {
  const m = src.match(/override fun onPageFinished[\s\S]*?\n {12}\}/);
  expect(m).not.toBeNull();
  expect(m[0]).toMatch(/if \(timingScheduled\) return/);
  expect(m[0]).toMatch(/timingScheduled = true/);
});
