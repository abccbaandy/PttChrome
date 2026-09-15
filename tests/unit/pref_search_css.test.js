// 設定搜尋高亮的 CSS 契約（src/components/ContextMenu/PrefModal.css）。
//
// 手法照抄 tests/unit/comment_spacing_css.test.js：讀檔、剝註解、正則取規則體。
// 這裡鎖三件「後人順手改一下就靜默壞掉」的事：
//  (1) 底色必須是半透明的 `-light` 變數 —— 錨點可能是整個 fieldset（分區命中），
//      換成實色的 yellow-2/yellow-9 會把區塊裡的說明文字與橘色警告字壓到讀不出
//      來（2026-09 實際截圖確認過才改掉的）；
//  (2) 顏色一律走 Mantine 變數，不得硬編 #hex/rgb() —— 硬編的那一刻暗色主題就毀了；
//  (3) 必須保留 prefers-reduced-motion 分支 —— 系統層關掉動畫的人仍要看得出
//      「跳到的是哪一項」，所以那裡改用靜態描邊而不是整個不標示。
import fs from "node:fs";
import path from "node:path";

const CSS = fs.readFileSync(
  path.join(
    __dirname,
    "..",
    "..",
    "src",
    "components",
    "ContextMenu",
    "PrefModal.css",
  ),
  "utf8",
);
const STRIPPED = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

const FLASH = "PrefModal__Anchor--flash";

const keyframes = () => {
  const m = STRIPPED.match(/@keyframes\s+PrefModalAnchorFlash\s*\{([\s\S]*?)\n\}/);
  return m ? m[1] : "";
};

// prefers-reduced-motion 這個 media query 的內容。
const reducedMotionBlock = () => {
  const m = STRIPPED.match(
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/,
  );
  return m ? m[1] : "";
};

describe("設定搜尋高亮的 CSS 契約", () => {
  test("flash class 與它的 keyframes 都在", () => {
    expect(STRIPPED).toContain("." + FLASH);
    expect(STRIPPED).toMatch(/@keyframes\s+PrefModalAnchorFlash/);
    expect(keyframes()).toBeTruthy();
  });

  test("底色用半透明的 -light 變數，不用實色階", () => {
    const kf = keyframes();
    expect(kf).toContain("var(--mantine-color-yellow-light)");
    // 實色階會蓋掉 fieldset 內的文字。
    expect(kf).not.toMatch(/--mantine-color-yellow-(?:[0-9])\b/);
  });

  test("不硬編顏色（暗色主題靠 Mantine 變數自己處理）", () => {
    const suspects = [...STRIPPED.matchAll(/[^{}]*PrefModal__(?:Anchor|Search)[^{}]*\{([^}]*)\}/g)]
      .map((m) => m[1])
      .concat(keyframes(), reducedMotionBlock())
      .join("\n");
    expect(suspects).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(suspects).not.toMatch(/\brgba?\(/);
  });

  test("保留 prefers-reduced-motion 分支，且仍標示得出來", () => {
    const block = reducedMotionBlock();
    expect(block).toContain(FLASH);
    expect(block).toMatch(/animation:\s*none/);
    // 不閃就得有別的視覺訊號，否則等於沒標示。
    expect(block).toMatch(/outline:/);
  });
});
