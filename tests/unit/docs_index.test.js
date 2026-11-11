// docs 索引（docs/README.md）與 CLAUDE.md 大小的靜態守護。
// CLAUDE.md 每個 session 都整份載入：指令檔越長越不會被照做，也每次都付 token。
// 主題文件清單因此放 docs/README.md（要用時才讀），CLAUDE.md 只留一行指標。
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DOCS = path.join(ROOT, "docs");
const INDEX = fs.readFileSync(path.join(DOCS, "README.md"), "utf8");
const CLAUDE = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");

const topLevelDocs = () =>
  fs
    .readdirSync(DOCS)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort();

const indexedDocs = () =>
  [...INDEX.matchAll(/^- \[`([^`]+\.md)`\]\(([^)]+)\)：\S/gm)].map((m) => {
    expect(m[2], `${m[1]} 的連結要指向同名檔`).toBe(m[1]);
    return m[1];
  });

test("docs/*.md 每一份都列在 docs/README.md 索引裡", () => {
  const listed = new Set(indexedDocs());
  const missing = topLevelDocs().filter((f) => !listed.has(f));
  expect(missing, "新增 docs/*.md 時在 docs/README.md 補一行「檔名：什麼時候先讀」").toEqual([]);
});

test("docs/README.md 索引沒有指向不存在的檔", () => {
  const existing = new Set(topLevelDocs());
  const dangling = indexedDocs().filter((f) => !existing.has(f));
  expect(dangling).toEqual([]);
});

test("索引每份文件只列一次", () => {
  const listed = indexedDocs();
  expect(listed.length).toBe(new Set(listed).size);
});

test("CLAUDE.md 不再內嵌 docs 清單，並指向索引", () => {
  expect(CLAUDE).toContain("docs/README.md");
  expect(CLAUDE).not.toMatch(/^- docs：/m);
});

test("CLAUDE.md 維持在 40KB 以內", () => {
  // 每個 session 都載入：只放每個 session 都會碰到的規則，主題細節寫進 docs/*.md。
  expect(Buffer.byteLength(CLAUDE, "utf8")).toBeLessThanOrEqual(40_000);
});
