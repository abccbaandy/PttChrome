// 好讀「連續同作者推文合併」純邏輯（src/js/comment_merge.js）。
// 規則（2026-07 使用者定案）：連續同 userid 的推文列合併為一段（跨型別照合，
// PTT 連推自動降 →）；跨作者各自分開；黑名單 hidden 列透明（不斷 run、不入 run）；
// 非推文列斷 run；run ≥2 才合併。FloorCounter／黑名單判定不動（合併僅 render 層）。
//
// cell 假資料手法同 row_render.test.jsx：ASCII-only、marker（推/噓/→，實際是
// 2-col DBCS）用兩個佔位 ASCII cell 頂替 cols 0-1，欄位數學（id 從 col 3 起）不變。
import fs from "node:fs";
import path from "node:path";
import {
  groupSameAuthorRuns,
  commentContentCells,
  buildMergedCommentChars,
} from "../../src/js/comment_merge";
import { parseComment } from "../../src/js/comment_parse";

const cell = (c) => ({ ch: c });
const chars = (str) => str.split("").map(cell);
const textOf = (cells) => cells.map((c) => c.ch).join("");

// 仿 computeAnnotations 的 per-row annotation：推文列有 userid（黑名單列加 hidden），
// 非推文列可能是 null 或不含 userid 的物件（如只有 fixedUrls）。
const A = { userid: "aaa" };
const B = { userid: "bbb" };
const hiddenB = { userid: "bbb", hidden: true };

describe("groupSameAuthorRuns", () => {
  test("使用者範例 A A A B A A → [A×3][A×2]（B 單則不合併）", () => {
    const runs = groupSameAuthorRuns([A, A, A, B, A, A]);
    expect(runs).toEqual([
      { userid: "aaa", rows: [0, 1, 2] },
      { userid: "aaa", rows: [4, 5] },
    ]);
  });

  test("hidden（黑名單）列透明：不斷 run、不入 run", () => {
    const runs = groupSameAuthorRuns([A, hiddenB, A]);
    expect(runs).toEqual([{ userid: "aaa", rows: [0, 2] }]);
  });

  test("非推文列（null 或無 userid 的 annotation）斷 run", () => {
    expect(groupSameAuthorRuns([A, null, A])).toEqual([]);
    expect(groupSameAuthorRuns([A, { fixedUrls: [] }, A])).toEqual([]);
  });

  test("單則不成 run；不同作者交錯不合併", () => {
    expect(groupSameAuthorRuns([A, B, A, B])).toEqual([]);
  });

  test("結尾的 run 也要收（run 收在陣列末端）", () => {
    const runs = groupSameAuthorRuns([B, A, A]);
    expect(runs).toEqual([{ userid: "aaa", rows: [1, 2] }]);
  });
});

describe("commentContentCells", () => {
  test("標準列：content 邊界＋時間戳", () => {
    //           0123456789...
    const row = "PU tonypong: hello world      07/20 14:23  ";
    const r = commentContentCells(chars(row));
    expect(r).not.toBeNull();
    expect(row.substring(r.start, r.end)).toBe("hello world");
    expect(r.time).toBe("07/20 14:23");
  });

  test("id 補空格板（Stock「diefishfish :」）", () => {
    const row = "PU diefishfish : text here   07/20 14:23";
    const r = commentContentCells(chars(row));
    expect(row.substring(r.start, r.end)).toBe("text here");
  });

  test("IP 板（BRD_IPLOGRECMD）：IP 不入 content", () => {
    // 對照 fixtures/IpComment_M.1621089154.txt 列型
    const row = "PU ericf129: good stuff ><         1.200.29.12 05/16 22:57";
    const r = commentContentCells(chars(row));
    expect(row.substring(r.start, r.end)).toBe("good stuff ><");
    expect(r.time).toBe("05/16 22:57");
  });

  test("一位數月份（6/05）也解析", () => {
    const row = "PU abc12: hi                  6/05 16:38";
    const r = commentContentCells(chars(row));
    expect(row.substring(r.start, r.end)).toBe("hi");
    expect(r.time).toBe("6/05 16:38");
  });

  test("DBCS 內容不干擾（tail 掃描只走 ASCII 區）", () => {
    // 內容含 isLeadByte 假 DBCS cell（ch 為單一位元組）
    const cells = chars("PU aaa: ").concat(
      [
        { ch: "\xb1", isLeadByte: true },
        { ch: "\xc0" },
      ],
      chars("x   07/20 14:23"),
    );
    const r = commentContentCells(cells);
    expect(r).not.toBeNull();
    expect(textOf(cells.slice(r.start, r.end))).toBe("\xb1\xc0x");
  });

  test("無時間戳（正文假形狀）→ null（fail-safe 不合併）", () => {
    expect(commentContentCells(chars("PU aaa: no time here"))).toBeNull();
  });
});

describe("buildMergedCommentChars", () => {
  // 打滿欄位被切斷的推文（gap 小）→ 直接相連、不插空格：被切斷的字（如
  // 「120」+「0」→「1200」）才能復原。使用者回報：原本加空格會出現「120 0」。
  test("打滿的列（gap 小）直接相連，不插空格", () => {
    const lines = [
      chars("PU aaa: price is 120 07/20 14:23"),
      chars("PU aaa: 0 ok         07/20 14:31"),
    ];
    const r = buildMergedCommentChars(lines, { userid: "aaa", rows: [0, 1] });
    expect(r).not.toBeNull();
    expect(textOf(r.chars)).toBe("PU aaa: price is 1200 ok");
    expect(r.timeLabel).toBe("07/20 14:23"); // 只顯示首則時間
  });

  // 內容遠短於欄寬（後面一大段空白）＝作者刻意斷句 → 保留換行（\n cell，
  // pre-wrap 渲染成換行）。使用者定案：「原本就有大量空白的就把他當成換行」。
  test("內容後大量空白（gap 大）→ 當成換行", () => {
    const lines = [
      chars("PU aaa: hello        07/20 14:23"),
      chars("PU aaa: world        07/20 14:31"),
    ];
    const r = buildMergedCommentChars(lines, { userid: "aaa", rows: [0, 1] });
    expect(textOf(r.chars)).toBe("PU aaa: hello\nworld");
  });

  test("空內容列跳過", () => {
    const lines = [
      chars("PU aaa: hello        07/20 14:23"),
      chars("PU aaa:              07/20 14:24"),
      chars("PU aaa: world        07/20 14:31"),
    ];
    const r = buildMergedCommentChars(lines, {
      userid: "aaa",
      rows: [0, 1, 2],
    });
    expect(textOf(r.chars)).toBe("PU aaa: hello\nworld");
  });

  test("run 中任一列切不出邊界 → null（整組 fail-safe 還原逐列）", () => {
    const lines = [
      chars("PU aaa: hello        07/20 14:23"),
      chars("PU aaa: broken no timestamp"),
    ];
    expect(
      buildMergedCommentChars(lines, { userid: "aaa", rows: [0, 1] }),
    ).toBeNull();
  });

  test("cell 沿用既有 TermChar 實例；換行 cell 保留原 prototype（不可 plain object）", () => {
    const lines = [
      chars("PU aaa: hi           07/20 14:23"),
      chars("PU aaa: yo           07/20 14:24"),
    ];
    const all = new Set(lines.flat());
    const r = buildMergedCommentChars(lines, { userid: "aaa", rows: [0, 1] });
    r.chars.forEach((c) => {
      if (c.ch === "\n") {
        // 合成換行 cell：必須繼承來源 cell 的 prototype（防方法剝離）且不污染原 buf
        expect(Object.getPrototypeOf(c)).toBe(
          Object.getPrototypeOf(lines[0][0]),
        );
        expect(all.has(c)).toBe(false);
      } else {
        expect(all.has(c)).toBe(true);
      }
    });
    // 原始 lines 的 cell 不得被改寫成 \n（clone 而非 mutate）
    lines.flat().forEach((c) => expect(c.ch).not.toBe("\n"));
  });
});

// 真實素材回歸（使用者回報排版案例）：Stock M.1784527065 wettland5566 連續 12 則。
// fixture 為 Big5 原始 bytes（1 byte = 1 cell/col，欄位數學與 buf 一致）。
// 校準（2026-07 使用者定案「換行條件設嚴」）：打滿 gap=3、被全形字擠 1 格 gap=4
// （「你又不是」「很強勢的股」「遇到」）皆須相連；唯獨刻意斷句
// 「甚至有可能是跌的」（gap=8）換行 → 全段恰好一個換行。
describe("真實素材（wettland5566 十二連推，斷行校準）", () => {
  const fx = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "fixtures/comment_merge_wettland.json"),
      "utf8",
    ),
  );
  const lines = fx.rows.map((b64) =>
    Array.from(Buffer.from(b64, "base64").toString("latin1")).map(cell),
  );

  test("全段恰好一個換行，落在「甚至有可能是跌的」之後", () => {
    const run = { userid: "wettland5566", rows: lines.map((_, i) => i) };
    const r = buildMergedCommentChars(lines, run);
    expect(r).not.toBeNull();
    const parts = textOf(r.chars).split("\n");
    expect(parts.length).toBe(2); // 只此一個換行
    // 斷點正確：前段以「甚至有可能是跌的」（fixture 第 6 列）的內容收尾
    const info = commentContentCells(lines[5]);
    const row6content = textOf(lines[5].slice(info.start, info.end));
    expect(parts[0].endsWith(row6content)).toBe(true);
  });
});

// 真實素材回歸：stock-end 卷 golden 推文含 rz2x 連續 7 則（文字層驗 grouping）。
describe("真實素材（stock-end golden）", () => {
  const fixturePath = path.join(
    __dirname,
    "fixtures/replay/stock-end.page.json",
  );
  const hasFixture = fs.existsSync(fixturePath);
  (hasFixture ? test : test.skip)("rz2x×7 併成單一 run", () => {
    const golden = JSON.parse(fs.readFileSync(fixturePath, "utf8")).golden;
    const anns = golden.comments.map((t) => {
      const c = parseComment(t);
      return c ? { userid: c.userid } : null;
    });
    const runs = groupSameAuthorRuns(anns);
    const rz = runs.find((r) => r.userid === "rz2x");
    expect(rz).toBeDefined();
    expect(rz.rows.length).toBe(7);
  });
});
