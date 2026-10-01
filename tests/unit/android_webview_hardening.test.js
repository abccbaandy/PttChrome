// APK 裡每個 WebView（含 onCreateWindow 只拿網址用的暫時 WebView）都要關掉 content:// 與
// file:// 存取（CodeQL java/android/websettings-allow-content-access）。預設是開的，
// 新增 WebView 時最容易漏 —— 實例：開新視窗轉外部瀏覽器的 popup。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../android/app/src/main/java/io/github/abccbaandy/pttchrome");
const sources = readdirSync(dir)
  .filter(f => f.endsWith(".kt"))
  .map(f => ({ f, text: readFileSync(join(dir, f), "utf8") }));

const count = (text, re) => (text.match(re) || []).length;

test("每個 new WebView 都關掉 content／file 存取", () => {
  for (const { f, text } of sources) {
    const created = count(text, /\bWebView\(this/g);
    expect({ f, contentOff: count(text, /allowContentAccess = false/g) }).toEqual({ f, contentOff: created });
    expect({ f, fileOff: count(text, /allowFileAccess = false/g) }).toEqual({ f, fileOff: created });
  }
});

test("掃描本身有掃到 WebView（防路徑或 regex 失效變成恆綠）", () => {
  const total = sources.reduce((n, { text }) => n + count(text, /\bWebView\(this/g), 0);
  expect(total).toBeGreaterThanOrEqual(2);
});
