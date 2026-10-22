// 「文章列表的黑名單判準只有一份」的靜態守護（src/js/list_row_filter.js、docs/list-row-filter.md）。
//
// 病例：「下一篇」標題卡（next_article.js）自己從列表快照挑下一列，只跳刪除文、沒套黑名單 ⇒
// 列表好讀藏起來的文章，卡片又把它端出來（雙欄閱讀左欄、跳到第一篇未讀、agent 的列文章工具
// 同一類）。每個功能各寫一份比對，漏一個就是一個 bug。
//
// 規則：
//   1. 拿東西比對 blacklist／titleBlacklist（`*.has(`、`matchTitleBlacklist(`）只准在
//      list_row_filter.js（文章列表）與 comment_parse.js（定義處＋文章內推文的 id 黑名單）。
//   2. 從畫面解析出文章列表條目（parseListEntry／listEntriesFromScreen／listPageOf）的模組必須
//      import list_row_filter——除非列在 EXEMPT（附理由：只拿來認畫面、不挑文章給人看）。
import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "../../src");

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, "$1"))
    .join("\n");
}

const files = fs
  .readdirSync(SRC, { recursive: true })
  .filter((f) => /\.jsx?$/.test(f))
  .map((f) => f.split(path.sep).join("/"))
  .sort();
const code = (f) => stripComments(fs.readFileSync(path.join(SRC, f), "utf8"));

const MATCHERS_ALLOWED = new Set(["js/list_row_filter.js", "js/comment_parse.js"]);
const BLACKLIST_COMPARE = /\b(?:[bB]lacklist(?:Set)?|titleBlacklist)\.has\(|\bmatchTitleBlacklist\(/;

const ENTRY_SOURCES = /\b(?:parseListEntry|listEntriesFromScreen|listPageOf)\b/;
const EXEMPT = {
  // 定義處。
  "js/agent_parse.js": "parseListEntry／listEntriesFromScreen 的定義處",
  // 落地驗證：認「畫面上哪一列是置底文／游標停在哪篇」，送鍵前後比對用，不挑文章給人看。
  "js/aid_navigation.js": "只用來認畫面（置底文位置、落地那列），不挑文章給人看",
  // 首頁儀表板的「有新文章」＝PTT 的看板旗標（check_newpost 只看最新一篇讀了沒），與使用者的
  // 黑名單無關：讀最新一篇的已讀標記來鏡像 PTT，不挑文章給人看。
  "js/home_dashboard.js": "只讀最新一篇的已讀標記鏡像 PTT 的看板未讀旗標，不挑文章給人看",
  // 列表的「+N」：只是在列表那一列上加註，被黑名單擋的列在標註層（screen_annotations 的
  // 列表分支）先換成通知列／藏起來、continue，輪不到它。
  "js/new_comments.js": "只替列表上那一列加註 +N，黑名單列在標註層先處理掉，不挑文章給人看",
};

test("黑名單比對只在 list_row_filter／comment_parse", () => {
  const offenders = files.filter((f) => !MATCHERS_ALLOWED.has(f) && BLACKLIST_COMPARE.test(code(f)));
  expect(offenders).toEqual([]);
});

test("解析文章列表條目的模組都經過 list_row_filter（或列在豁免名單）", () => {
  const offenders = files.filter(
    (f) => ENTRY_SOURCES.test(code(f)) && !EXEMPT[f] && !/from\s+['"]\.\/list_row_filter['"]/.test(code(f))
  );
  expect(offenders).toEqual([]);
});

test("豁免名單裡的檔案都還存在、也真的用到條目解析（過期就刪）", () => {
  for (const f of Object.keys(EXEMPT)) {
    expect(files).toContain(f);
    expect(ENTRY_SOURCES.test(code(f))).toBe(true);
  }
});

test("守護自證：樣本會被抓到", () => {
  expect(BLACKLIST_COMPARE.test("if (view.blacklist.has(author)) skip();")).toBe(true);
  expect(BLACKLIST_COMPARE.test("matchTitleBlacklist(title, kw)")).toBe(true);
  expect(BLACKLIST_COMPARE.test("const s = new Set();")).toBe(false);
  expect(ENTRY_SOURCES.test("const page = listPageOf(rowTexts, y);")).toBe(true);
});
