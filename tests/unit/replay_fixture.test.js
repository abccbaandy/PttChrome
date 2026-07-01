// Layer 2（纯逻辑 / node / 无浏览器）：从录制的「每页文字快照」用 *真实* findPageOverlap
// 重建好读跨页累积，守护 comment_parse.findPageOverlap 的去重（第一则推文被吃 / 楼号错位
// 那个 off-by-one bug）+ FloorCounter 楼层 + blacklist，全部不连网、秒级。
//
// 镜像 src/js/term_view.js#accumulatePageLines：第一页 = screen.slice(0,-1)（去状态列）；
// 后续去重以状态列行号（parseStatusRow）为主、findPageOverlap 内文比对为辅
// （resolvePageOverlap），= acc.concat(newRows.slice(begin))。
//
// fixture 由 `yarn record:cassette` 产出 tests/unit/fixtures/replay/<name>.page.json。
// 每页最后一列是原始状态列文字（"目前显示: 第 S~E 行"），可解析出绝对行号。
// 还没录过 → skip（非失败）。
const fs = require("fs");
const path = require("path");
const {
  findPageOverlap,
  resolvePageOverlap,
  annotateComment,
  FloorCounter,
  parseComment
} = require("../../src/js/comment_parse");
const { parseStatusRow } = require("../../src/js/string_util");

const FIX_DIR = path.join(__dirname, "fixtures", "replay");
const COMMENT_RE = /^(推|噓|→)\s+([0-9A-Za-z]+)\s*:/;

function loadArticleFixtures() {
  if (!fs.existsSync(FIX_DIR)) return [];
  return fs
    .readdirSync(FIX_DIR)
    .filter(n => n.endsWith(".page.json"))
    .map(n => JSON.parse(fs.readFileSync(path.join(FIX_DIR, n), "utf8")))
    .filter(f => f.meta && f.meta.mode === "article" && Array.isArray(f.pageScreens))
    .map((f, i, arr) => Object.assign(f, { __name: f.meta && f.meta.board }));
}

// 重建好读累积页（text 行阵列），镜像 accumulatePageLines：状态列行号为主、
// findPageOverlap 内文比对为辅（resolvePageOverlap）。
function reconstruct(pageScreens) {
  let acc = [];
  let accEndRow = null; // pageLines 末列对应的文章行号（上一页 rowIndexEnd）
  for (let p = 0; p < pageScreens.length; p++) {
    const statusRow = pageScreens[p][pageScreens[p].length - 1];
    const status = parseStatusRow(statusRow);
    const newRows = pageScreens[p].slice(0, -1); // 去掉最后的状态列（accumulatePageLines 同）
    if (p === 0) {
      acc = newRows.slice();
      accEndRow = status ? status.rowIndexEnd : null;
    } else {
      const accTail = acc.slice(-newRows.length);
      const kContent = findPageOverlap(accTail, newRows);
      const begin = resolvePageOverlap({
        accEndRow,
        statusStart: status ? status.rowIndexStart : null,
        kContent,
        maxK: Math.min(accTail.length, newRows.length),
        accTail,
        newTexts: newRows
      });
      acc = acc.concat(newRows.slice(begin));
      if (status) accEndRow = status.rowIndexEnd;
    }
  }
  return acc;
}

const fixtures = loadArticleFixtures();

describe("好读跨页累积重建（离线 fixture）", () => {
  if (!fixtures.length) {
    // 还没录过任何 article fixture：保留一个 skip 占位（jest 要求每个 suite ≥1 test）。
    test.skip("尚无 article fixture；先 yarn record:cassette（guest）", () => {});
    return;
  }
  for (const fx of fixtures) {
    describe(`${fx.meta.board} (${fx.pageScreens.length}页)`, () => {
      const acc = reconstruct(fx.pageScreens);
      const comments = acc.filter(t => COMMENT_RE.test(t));

      test("去重后推文数 == 录制 golden（吃列→变少 / 重复→变多）", () => {
        expect(comments.length).toBe(fx.golden.commentCount);
      });

      test("第一则推文作者 == golden（regression：曾整列消失）", () => {
        if (!fx.golden.firstCommentAuthor) return;
        const first = comments[0] && comments[0].match(COMMENT_RE)[2].toLowerCase();
        expect(first).toBe(fx.golden.firstCommentAuthor);
      });

      test("相邻非空白列不重复（跨页去重没多 append）", () => {
        for (let i = 1; i < acc.length; i++) {
          const a = acc[i - 1].replace(/\s+$/, "");
          const b = acc[i].replace(/\s+$/, "");
          if (a.trim() !== "") expect(b).not.toBe(a);
        }
      });

      test("FloorCounter：真推文从第 1 楼起、连续递增", () => {
        const ctx = { showFloorNumbers: true, floorCounter: new FloorCounter() };
        const floors = [];
        for (const t of acc) {
          const ann = annotateComment(t, ctx);
          if (ann && ann.floor) floors.push(ann.floor.seq);
        }
        // 真推文（meta-latch 后）应从 1 连续。注意 body 假推文会被 nonComment 归零，
        // 所以最终序列的「最后一段」是真推文：从 1 起、步进 1。
        const real = floors.slice(-fx.golden.commentCount);
        expect(real[0]).toBe(1);
        for (let i = 1; i < real.length; i++) expect(real[i]).toBe(real[i - 1] + 1);
      });

      test("blacklist：把 golden 首推作者列入 → 其列标记 hidden 且 userid 相符", () => {
        const target = fx.golden.firstCommentAuthor;
        if (!target) return;
        const ctx = {
          showFloorNumbers: false,
          blacklist: new Set([target]),
          floorCounter: new FloorCounter()
        };
        const hidden = acc
          .map(t => annotateComment(t, ctx))
          .filter(a => a && a.hidden);
        expect(hidden.length).toBeGreaterThan(0);
        expect(hidden.every(a => a.userid === target)).toBe(true);
      });
    });
  }
});
