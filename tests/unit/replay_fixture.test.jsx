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
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  findPageOverlap,
  resolvePageOverlap,
  decideAccumulateBranch,
  classifyPageTransition,
  annotateComment,
  FloorCounter,
  parseComment
} from "../../src/js/comment_parse";
import { parseStatusRow } from "../../src/js/string_util";

const FIX_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "replay"
);
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
function reconstruct(pageScreens, transitions) {
  let acc = [];
  let accEndRow = null; // pageLines 末列对应的文章行号（上一页 rowIndexEnd）
  for (let p = 0; p < pageScreens.length; p++) {
    const statusRow = pageScreens[p][pageScreens[p].length - 1];
    const status = parseStatusRow(statusRow);
    const newRows = pageScreens[p].slice(0, -1); // 去掉最后的状态列（accumulatePageLines 同）
    if (transitions && p > 0) {
      transitions.push({
        page: p,
        accEndRow,
        statusStart: status ? status.rowIndexStart : null,
        statusEnd: status ? status.rowIndexEnd : null,
        kind: classifyPageTransition({
          accEndRow,
          statusStart: status ? status.rowIndexStart : null,
          statusEnd: status ? status.rowIndexEnd : null
        })
      });
    }
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

// 完整镜像新版 accumulatePageLines（含 decideAccumulateBranch 三路分流 + sticky
// pendingReset）。frames = [{screen, prevPageState, pendingReset?}]：pendingReset=true
// 模拟 leaveCurrentPost 设 sticky 旗标；prevPageState 由呼叫端指定以重现 race
//（redraw 每帧覆写 prevPageState=pageState 的时序）。
function reconstructBranching(frames) {
  let acc = [];
  let accEndRow = null;
  let pendingReset = false;
  for (const f of frames) {
    if (f.pendingReset) pendingReset = true;
    const statusRow = f.screen[f.screen.length - 1];
    const status = parseStatusRow(statusRow);
    const newRows = f.screen.slice(0, -1);
    let accTail = null, kContent = 0, headerChanged = false;
    if (f.prevPageState === 3 && status && acc.length) {
      accTail = acc.slice(-newRows.length);
      kContent = findPageOverlap(accTail, newRows);
      const accHead = (acc[0] || "").replace(/\s+$/, "");
      const newHead = (newRows[0] || "").replace(/\s+$/, "");
      headerChanged = accHead !== "" && newHead !== "" && accHead !== newHead;
    }
    const branch = decideAccumulateBranch({
      prevPageState: f.prevPageState,
      pendingReset,
      statusStart: status ? status.rowIndexStart : null,
      kContent,
      hasAcc: acc.length > 0,
      headerChanged
    });
    if (branch === "append") {
      const begin = resolvePageOverlap({
        accEndRow,
        statusStart: status.rowIndexStart,
        kContent,
        maxK: Math.min((accTail || []).length, newRows.length),
        accTail: accTail || [],
        newTexts: newRows
      });
      acc = acc.concat(newRows.slice(begin));
      accEndRow = status.rowIndexEnd;
    } else if (branch === "rebuild") {
      if (status && status.rowIndexStart === 1) pendingReset = false;
      acc = newRows.slice();
      accEndRow = status ? status.rowIndexEnd : null;
    }
  }
  return acc;
}

// 合成两篇文章画面（22 内容列 + 状态列），行号连续、内容互不重叠。
function makeScreen(tag, startLine, rows = 22) {
  const s = [];
  for (let i = 0; i < rows; i++) s.push(`${tag} 第${startLine + i}行 內文內文`);
  s.push(
    `  瀏覽 第 1/9 頁 ( 12%)  目前顯示: 第 ${startLine}~${startLine + rows - 1} 行  (y)回應(X%)推文(h)說明(←)離開 `
  );
  return s;
}

describe("[ ] 跳同标题：新文章不得叠加在旧文章后（race 回归）", () => {
  // race 时序：文1 两页 → leaveCurrentPost（sticky）→ 夹一帧文1 旧画面
  //（prevPageState 已被 redraw 覆写回 3）→ 文2 第一页（prevPageState 仍 3）。
  // 旧逻辑：旧帧吃掉一次性旗标 → 文2 走续接 → 文1+文2 叠加。
  test("夹旧帧后文2第一页 → acc 只含文2", () => {
    const a1p1 = makeScreen("文一", 1);
    const a1p2 = makeScreen("文一", 23);
    const a2p1 = makeScreen("文二", 1);
    const acc = reconstructBranching([
      { screen: a1p1, prevPageState: 0 },
      { screen: a1p2, prevPageState: 3 },
      // [ ] 按下：leaveCurrentPost 设 sticky；随后旧画面又重绘一帧
      { screen: a1p2, prevPageState: 3, pendingReset: true },
      { screen: a2p1, prevPageState: 3 }
    ]);
    expect(acc.every(t => t.startsWith("文二"))).toBe(true);
    expect(acc.length).toBe(22);
  });

  test("正常翻页不受影响（sticky 未设）", () => {
    const acc = reconstructBranching([
      { screen: makeScreen("文一", 1), prevPageState: 0 },
      { screen: makeScreen("文一", 23), prevPageState: 3 },
      { screen: makeScreen("文一", 45), prevPageState: 3 }
    ]);
    expect(acc.length).toBe(66);
    expect(acc[0]).toContain("第1行");
    expect(acc[65]).toContain("第66行");
  });

  // P1 掉页合成回归：第 2 页与第 3 页之间少收一页（typeahead 跳绘，P4）。
  // 旧逻辑 resolvePageOverlap 把负重叠夹成 0 → 照常 append → 中间那段永久消失且
  // 无人察觉（＝「※ 发信站/※ 文章网址 那段不见」的形状）。现在必须被判成 gap。
  test("掉页（第 2→4 页）被 classifyPageTransition 判成 gap", () => {
    const p2 = makeScreen("文一", 23); // 第 23~44 行
    const p4 = makeScreen("文一", 67); // 第 67~88 行（第 45~66 行整页没收到）
    const s2 = parseStatusRow(p2[p2.length - 1]);
    const s4 = parseStatusRow(p4[p4.length - 1]);
    expect(
      classifyPageTransition({
        accEndRow: s2.rowIndexEnd,
        statusStart: s4.rowIndexStart,
        statusEnd: s4.rowIndexEnd
      })
    ).toBe("gap");
  });

  test("正常翻页（S' == E）不会被误判成 gap", () => {
    const p2 = makeScreen("文一", 23);
    const p3 = makeScreen("文一", 44); // S' 44 == 上一页 E 44
    const s2 = parseStatusRow(p2[p2.length - 1]);
    const s3 = parseStatusRow(p3[p3.length - 1]);
    expect(
      classifyPageTransition({
        accEndRow: s2.rowIndexEnd,
        statusStart: s3.rowIndexStart,
        statusEnd: s3.rowIndexEnd
      })
    ).toBe("continuation");
  });

  test("同画面强制重绘（pref/pusher toggle）仍是 no-op append", () => {
    const p2 = makeScreen("文一", 23);
    const acc = reconstructBranching([
      { screen: makeScreen("文一", 1), prevPageState: 0 },
      { screen: p2, prevPageState: 3 },
      { screen: p2, prevPageState: 3 }
    ]);
    expect(acc.length).toBe(44);
  });
});

const fixtures = loadArticleFixtures();

describe("好读跨页累积重建（离线 fixture）", () => {
  if (!fixtures.length) {
    // 还没录过任何 article fixture：保留一个 skip 占位（vitest 要求每个 suite ≥1 test）。
    test.skip("尚无 article fixture；先 yarn record:cassette（guest）", () => {});
    return;
  }
  for (const fx of fixtures) {
    describe(`${fx.meta.board} (${fx.pageScreens.length}页)`, () => {
      const transitions = [];
      const acc = reconstruct(fx.pageScreens, transitions);
      const comments = acc.filter(t => COMMENT_RE.test(t));

      // pmore 不变量 P1（docs/pttbbs-screen-protocol.md §13）：PageDown ＝
      // mf_forward(mf.dispedlines - 1)，所以下一页的起始行号恰等于上一页的结束行号；
      // 末页被 mf_determinemaxdisps 的 maxdisps 夹住时只会更小。**绝不可能更大**。
      // 更大 ⇒ 中间整页被 typeahead 跳绘吞掉（P4），文字永久掉了。
      // 这条守护实录素材本身：一旦录到掉页，测试直接红，而不是默默 append 出破洞。
      test("P1：相邻页 S' <= 上一页 E（不得掉页）", () => {
        for (const t of transitions) {
          if (t.kind === null) continue; // 无状态列（不该发生在 pageScreens，但不硬失败）
          expect({ page: t.page, kind: t.kind }).toEqual({
            page: t.page,
            kind: expect.stringMatching(/^(continuation|restart|backward)$/)
          });
        }
      });

      // 累积页是**显示列**，文章行号是**档案行**（P2：dispedlines 不含 wrap 续列，
      // 也不含 EOF 后的空列），所以显示列数必 >= 末页 rowIndexEnd。少于它 ⇒ 去重
      // 吃掉了不该吃的列。
      test("P2：累积显示列数 >= 末页文章行号（去重没吃掉内容）", () => {
        const last = fx.pageScreens[fx.pageScreens.length - 1];
        const status = parseStatusRow(last[last.length - 1]);
        if (!status) return;
        expect(acc.length).toBeGreaterThanOrEqual(status.rowIndexEnd);
      });

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
