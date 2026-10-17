// 開站資源 preload 的靜態守護（index.html ↔ main.jsx／main.css）。
//
// main.jsx#loadResources 要等主 JS 下載、執行完才開始抓兩張 Big5 轉碼表與終端機字型，
// 而 connect() 要等這三樣都到 ⇒ 冷啟動（快取沒命中：清快取、Pages 新部署換 hash）時
// 是「主 JS → 轉碼表」兩段串行（docs/android-app.md「冷啟動黑畫面數秒」）。index.html
// 用 <link rel=preload> 讓它們跟主 JS 同時下載。
//
// 這幾行最容易靜默失效：
//   - 檔名／路徑改了，preload 抓的是另一個檔 ⇒ 多下載一份、原本的照樣串行。
//   - 轉碼表的 preload 少了 `as="fetch"` 或 `crossorigin` ⇒ 跟 fetch() 的請求模式對不上，
//     瀏覽器不拿 preload 的結果、再抓一次（字型同理：font preload 一律要 crossorigin）。
//   - loadTable 的 fetch() 加了 credentials 等選項 ⇒ 同上，對不上 preload。
// 真瀏覽器上「每張表只抓一次、由 preload 發起」由 tests/e2e/offline/boot_preload.offline.spec.js 守。
import indexHtml from "../../index.html?raw";
import mainJsx from "../../src/js/main.jsx?raw";
import fs from "node:fs";
import path from "node:path";

// CSS 的 ?raw 在 node project 會被 vitest 的 CSS 處理換成空字串 ⇒ 直接讀檔。
const mainCss = fs.readFileSync(path.join(__dirname, "..", "..", "src", "css", "main.css"), "utf8");

const preloads = [...indexHtml.matchAll(/<link\s+rel="preload"[^>]*>/g)].map((m) => m[0]);
// 屬性值；只寫名字（`crossorigin`）＝""；沒有這個屬性＝undefined。
function attr(tag, name) {
  const m = new RegExp(`\\s${name}(?:="([^"]*)")?(?=[\\s>/])`).exec(tag);
  return m ? (m[1] ?? "") : undefined;
}
const preloadFor = (href) => preloads.find((tag) => attr(tag, "href") === href);

test("main.jsx 抓的每張轉碼表都有 preload（as=fetch＋crossorigin）", () => {
  const tables = [...mainJsx.matchAll(/from\s+'\.\.\/conv\/([\w.-]+\.bin)\?url'/g)].map((m) => m[1]);
  expect(tables.sort()).toEqual(["b2u_table.bin", "u2b_table.bin"]);
  for (const file of tables) {
    const tag = preloadFor(`/src/conv/${file}`);
    expect(tag, file).toBeDefined();
    expect(attr(tag, "as"), file).toBe("fetch");
    expect(attr(tag, "crossorigin"), file).not.toBeUndefined();
  }
});

test("loadTable 用預設選項 fetch（才吃得到 preload）", () => {
  expect(mainJsx).toMatch(/return fetch\(url\)\.then/);
});

test("終端機字型有 preload（as=font、type 與 @font-face 一致、crossorigin）", () => {
  const face = /@font-face\s*\{[^}]*font-family:\s*SymMingLiu;[^}]*src:\s*url\('\.\.\/fonts\/([\w.-]+)'\)\s*format\("(\w+)"\)/.exec(mainCss);
  expect(face, "main.css 的 SymMingLiu @font-face").not.toBeNull();
  const [, file, format] = face;
  const tag = preloadFor(`/src/fonts/${file}`);
  expect(tag, file).toBeDefined();
  expect(attr(tag, "as")).toBe("font");
  expect(attr(tag, "type")).toBe(`font/${format}`);
  expect(attr(tag, "crossorigin")).not.toBeUndefined();
});

test("preload 排在主程式 script 之前（瀏覽器照文件順序發請求）", () => {
  const script = indexHtml.indexOf('<script type="module" src="/src/entry.js">');
  expect(script).toBeGreaterThan(0);
  for (const tag of preloads) expect(indexHtml.indexOf(tag), tag).toBeLessThan(script);
});
