// APK 的雙指縮放（文章圖片放大的後援，docs/mobile.md「viewport 不鎖 user-scalable」）。
// Android WebView 預設 builtInZoomControls=false：網頁 viewport 沒鎖縮放，pinch 照樣被吞掉，
// 只會變成 #mainContainer 的小幅捲動（實機錄製：兩指 touchstart 後只有 main.scroll 0→9）。
// 同一頁在 Chrome 能放大、在 APK 不行。原生 WebView 設定沒有 JVM 可跑的測試，靜態掃描守住。
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(__dirname, "../../android/app/src/main/java/io/github/abccbaandy/pttchrome/MainActivity.kt"),
  "utf8",
);

function webViewSettingsBlock(text) {
  const start = text.indexOf("wv.settings.apply {");
  expect(start).toBeGreaterThanOrEqual(0); // 掃描本身有效
  let depth = 0;
  let j = text.indexOf("{", start);
  for (; j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}" && --depth === 0) break;
  }
  return text.slice(start, j + 1);
}

test("WebView 開內建雙指縮放（否則 pinch 被吞掉）", () => {
  const block = webViewSettingsBlock(src);
  expect(block).toMatch(/^\s*builtInZoomControls = true\b/m);
  expect(block).not.toMatch(/setSupportZoom\(false\)/);
});

test("縮放的 +/- 浮動按鈕要藏起來（會蓋在終端機上）", () => {
  expect(webViewSettingsBlock(src)).toMatch(/^\s*displayZoomControls = false\b/m);
});
