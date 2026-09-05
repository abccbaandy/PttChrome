// offline e2e 的「走完整篇」前置動作必須覆蓋整篇 —— 靜態守護（2026-09-05）。
//
// 為什麼要有這條：`easy_reading_scroll_jump.offline.spec.js` 的 walkDown() 舊版只在
// **開頭量一次** `.main.scrollHeight` 就照那個值分段往下走。但圖片是邊走邊載、整篇
// 邊走邊長高（實測長了 2000px 以上）⇒ 走到舊高度就收工、再直接跳到底，**中間那一段
// 永遠沒被走過**。那段的圖從沒被量過高度（lazy_media 的 module 級 memo 裡 aspect／
// pinned 都是空的）⇒ 之後往回捲時才第一次掛載、各自撐開幾百 px，被下游「一次 PgUp
// 不得暴衝（≤1.2 倍）」誤判成捲動補償壞掉。
//
// 最惡劣的是這個破洞**會隨版面高度漂移**：沒被走過的區間落在哪，取決於列高。所以
// 症狀是「改了任何會影響列高的 CSS 就莫名紅一條」，看起來像被測 code 壞了（實錄：
// 加「推文區塊行距」時紅在 press 2 的 gained=2460；同樣的 margin 改加在非推文列上
// 卻全綠 —— 因為那組數值剛好沒把有圖的推文區推進破洞裡）。
//
// 純靜態掃描，不連網、不開瀏覽器 ⇒ 放 unit（比照 tests/unit/e2e_layout_settle.test.js）。
import fs from "fs";
import path from "path";

const SPEC = path.join(
  __dirname,
  "..",
  "..",
  "tests",
  "e2e",
  "offline",
  "easy_reading_scroll_jump.offline.spec.js",
);

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

// walkDown 的函式本體（到下一個頂層 `}` 為止）。
function walkDownBody() {
  const src = stripComments(fs.readFileSync(SPEC, "utf8"));
  const start = src.indexOf("async function walkDown(");
  expect(start, "找不到 walkDown —— 改名了就把這支測試一起更新").toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("easy_reading_scroll_jump 的 walkDown 覆蓋率契約", () => {
  test("scrollHeight 在迴圈裡重讀，不是只在開頭量一次", () => {
    const body = walkDownBody();
    const reads = body.match(/scrollHeight/g) || [];
    // 至少三次：迴圈前的第一次、迴圈內的重讀、最後跳到底那次。
    expect(
      reads.length,
      "walkDown 只量了一次 scrollHeight ⇒ 圖片載入後長出來的那一段永遠沒被走過",
    ).toBeGreaterThanOrEqual(3);
  });

  test("迴圈的結束條件取自「當下」的 scrollHeight，不是開頭那個快照", () => {
    const body = walkDownBody();
    // 舊版的形狀：for (let y = 0; y <= geom.scrollHeight; y += step)
    // ——把開頭量到的物件直接當上界。
    expect(
      /for\s*\([^)]*<=\s*\w+\.scrollHeight/.test(body),
      "迴圈上界不可以是開頭量到的 scrollHeight 快照",
    ).toBe(false);
  });

  test("每走一步都要等版面終局（否則量到的是中間態）", () => {
    const body = walkDownBody();
    expect((body.match(/waitPreviewsSettled/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});
