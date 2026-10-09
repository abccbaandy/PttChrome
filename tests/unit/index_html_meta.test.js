// index.html 的 viewport／theme-color 靜態守護（docs/mobile.md「系統整合」）。
//   - viewport-fit=cover：手機 App Bar／底部工具列以 safe-area 讓位（App._readSafeInsets）。
//   - **不准**加 interactive-widget=resizes-content：軟鍵盤開關會變成 layout resize ⇒
//     重算字級、改列數、重送 NAWS（docs/mobile.md「軟鍵盤蓋住底列」）。
//   - **不准**鎖 user-scalable／maximum-scale：雙指縮放是瀏覽器原生行為（CLAUDE.md）。
//   - theme-color 與 manifest 的 theme_color 一致（安裝成 App 後的狀態列色）。
import indexHtml from "../../index.html?raw";
import manifest from "../../public/manifest.webmanifest?raw";

const viewport = (/<meta\s+name="viewport"\s+content="([^"]*)"/.exec(indexHtml) || [])[1] || "";
const themeColor = (/<meta\s+name="theme-color"\s+content="([^"]*)"/.exec(indexHtml) || [])[1];

test("viewport：cover、可縮放、沒有 interactive-widget", () => {
  expect(viewport).toContain("width=device-width");
  expect(viewport).toContain("viewport-fit=cover");
  expect(viewport).not.toMatch(/interactive-widget/);
  expect(viewport).not.toMatch(/user-scalable|maximum-scale/);
});

test("theme-color 與 manifest 一致", () => {
  expect(themeColor).toMatch(/^#[0-9a-f]{6}$/i);
  expect(JSON.parse(manifest).theme_color.toLowerCase()).toBe(themeColor.toLowerCase());
});
