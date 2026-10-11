// README 給一般使用者 3 分鐘內看完：功能特色每條只寫 1～2 句「它做什麼」，
// 細節（設定位置、限制、原理）留在設定頁說明或 docs/。規範見 CLAUDE.md「README 功能列表」。
// 2026-10 前的 README 單條動輒上千字，靠人眼自律守不住 ⇒ 靜態掃描。
import fs from "node:fs";
import path from "node:path";
import { ORIGIN_SETUP_URL } from "../../src/js/connection_probe";

const README = fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8");

// 功能特色區段：「## ✨ 功能特色」到下一條分隔線。
const featureSection = () => {
  const start = README.indexOf("## ✨ 功能特色");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = README.indexOf("\n---", start);
  return README.slice(start, end < 0 ? undefined : end);
};

// 連結只算顯示文字，不算網址。
const visibleLength = (line) =>
  [...line.replace(/\]\([^)]*\)/g, "]")].length;

const MAX_FEATURE_CHARS = 100;

test("功能特色每條不超過上限（1～2 句）", () => {
  const bullets = featureSection()
    .split("\n")
    .filter((l) => l.startsWith("- "));
  expect(bullets.length).toBeGreaterThan(0);
  const tooLong = bullets
    .filter((l) => visibleLength(l) > MAX_FEATURE_CHARS)
    .map((l) => `${visibleLength(l)}: ${l.slice(0, 40)}…`);
  expect(tooLong).toEqual([]);
});

test("功能特色每條是「- **名稱** — 說明」格式、說明不超過兩句", () => {
  featureSection()
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .forEach((l) => {
      expect(l).toMatch(/^- \*\*[^*]+\*\* — \S/);
      const desc = l.slice(l.indexOf(" — ") + 3);
      const sentences = desc.split(/[。！？]/).filter((s) => s.trim());
      expect(`${sentences.length} ${l.slice(0, 30)}`).toMatch(/^[12] /);
    });
});

// GitHub 標題錨點：小寫、去掉標點與 emoji（字母、數字、空白、-、_ 以外）、空白換成 -。
const githubSlug = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");

test("連線失敗提示框的設定教學連結，README 裡有對應標題", () => {
  const anchor = decodeURIComponent(ORIGIN_SETUP_URL.split("#")[1]);
  const slugs = README.split("\n")
    .filter((l) => /^#{1,6} /.test(l))
    .map((l) => githubSlug(l.replace(/^#+ /, "")));
  expect(slugs).toContain(anchor);
});
