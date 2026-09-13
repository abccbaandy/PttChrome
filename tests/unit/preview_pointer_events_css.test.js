// 內嵌預覽「命中範圍＝媒體盒本身」的 CSS 契約（src/css/main.css）。
//
// 背景：.inlinePreviewSlot 是整列寬的區塊（無 width 宣告，逐層繼承 .main 的
// chw*80+10px），圖片卻是 max-width:39em + margin:auto 置中 ⇒ 直式圖／小圖左右
// 各留下數十欄空白。那片空白若算「點在預覽上」，會同時弄壞兩件事：
//   1. 灰階鈕的 hover 觸發擴散到整列寬（捲到圖就常駐，見 image_gray_css.test.js）；
//   2. App.mouse_click 第 5 條 isPreviewTarget 直接 return ⇒ 文章模式左 0-6 欄的
//      退出手勢在圖片那幾列整段失效。而 hover 路徑純看格子座標、不看 DOM ⇒
//      #exitHintBand 照亮、指標照樣是 back，點下去 0 byte。
//
// 這裡守的全是「改壞了也不會有任何其他測試紅」的宣告：pointer-events 不影響 layout，
// 所以 golden 快照、佔位高度、scroll anchoring 都察覺不到它被拿掉。真幾何（留白處
// elementFromPoint 回的是誰）只能在真瀏覽器量，見 tests/e2e/offline/mouse.offline.spec.js。
//
// 手法照抄 image_gray_css.test.js：讀檔、剝註解、正則取規則體。
import fs from "node:fs";
import path from "node:path";

const CSS = fs.readFileSync(
  path.join(__dirname, "..", "..", "src", "css", "main.css"),
  "utf8",
);
const STRIPPED = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

const rules = [...STRIPPED.matchAll(/([^{}]*)\{([^}]*)\}/g)].map((m) => ({
  selector: m[1].trim(),
  body: m[2],
}));

const rulesWith = (...fragments) =>
  rules.filter((r) => fragments.every((f) => r.selector.includes(f)));

const decl = (body, prop) => {
  const m = body && body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
  return m ? m[1].trim() : null;
};

// 選擇器恰好是這一串（避免把 `.inlinePreviewSlot > .previewGrayBtn` 之類也算進來）
const exactRule = (sel) => rules.find((r) => r.selector === sel) || null;

describe("main.css：內嵌預覽的命中範圍", () => {
  test("slot 本身不吃 hit-test（整列寬的留白要讓給左側退出帶）", () => {
    const rule = exactRule(".inlinePreviewSlot");
    expect(rule, "找不到 .inlinePreviewSlot 的規則").not.toBeNull();
    expect(
      decl(rule.body, "pointer-events"),
      "拿掉這條 ⇒ 圖片左右留白又變成「點在預覽上」，退出手勢在整段圖片高度失效",
    ).toBe("none");
  });

  // pointer-events 是**繼承屬性**：slot 設 none 之後，子孫不逐一取回就連圖片自己
  // 都點不到（放大切換、載入失敗重試、灰階鈕全部靜默失效）。
  test("可互動的子孫各自取回 pointer-events:auto", () => {
    const restored = rules.filter(
      (r) =>
        r.selector.includes(".inlinePreviewSlot") &&
        decl(r.body, "pointer-events") === "auto",
    );
    expect(restored.length, "少了這條 ⇒ 圖片連自己都點不到").toBeGreaterThan(0);
    const selector = restored.map((r) => r.selector).join(",");
    // 清單與 js/preview_targets.js 的 PREVIEW_CLICK_SELECTOR 對齊。
    for (const need of [
      "img.easyReadingImg",
      "video.easyReadingVideo",
      "iframe",
      ".previewLoading",
      ".previewError",
      ".previewGrayBtn",
    ]) {
      expect(selector, `${need} 沒有取回 pointer-events`).toContain(need);
    }
  });

  // 替身盒（.inlinePreviewGhost）住在 .inlinePreviewSpacer 裡，本來就不該吃點擊。
  test("替身盒所在的 spacer 維持 pointer-events:none", () => {
    const rule = exactRule(".inlinePreviewSpacer");
    expect(rule).not.toBeNull();
    expect(decl(rule.body, "pointer-events")).toBe("none");
  });

  // inline-level 元素的 `margin: auto` 解析成 0 ⇒ 指示器其實整片貼在第 0 欄，
  // 載入中／載入失敗的期間左側退出帶同樣點不到。
  test.each([".previewLoading", ".previewError"])(
    "%s 是置中的 flex，不得退回 inline-flex（margin:auto 會變 no-op）",
    (sel) => {
      const rule = exactRule(sel);
      expect(rule).not.toBeNull();
      expect(decl(rule.body, "display")).toBe("flex");
      expect(decl(rule.body, "width")).toBe("fit-content");
      expect(decl(rule.body, "margin")).toMatch(/\bauto\b/);
    },
  );

  test("不得動用 !important（比照專案慣例：不堆疊硬調）", () => {
    for (const r of rulesWith(".inlinePreviewSlot"))
      expect(r.body).not.toMatch(/!important/);
  });
});
