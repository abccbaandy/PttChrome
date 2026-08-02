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
  // 核心不變量（2026-08 使用者定案，取代舊的 gap 猜續行規則）：一則推文＝一行。
  // 合併只做「去掉第 2 則起重複的作者前綴與時間戳」，不猜哪兩則原本是同一句被
  // 輸入欄截斷 —— 見 comment_merge.js 檔頭的 pttbbs 欄寬反查。
  // 作者在第一則行首、時間在**最後一則**行尾且**置右對齊**（使用者 2026-08 定案）。
  // 手法：把最後一則「內容尾 → 時間戳結束」整段（padding＋可選 IP＋時間）原樣帶過來。
  // 同一 run 必為同 userid ⇒ 各列內容起始欄相同 ⇒ 合併行的左緣偏移＝原列的，
  // 於是時間戳落在與原生逐列渲染**完全相同的欄**。全部沿用原 cell（ANSI 配色一致、
  // 可被 getSelection 選取複製），不是 React 節點。
  test("每則各自成行；末行帶原列的 padding＋時間戳（欄位同原生）", () => {
    const lines = [
      chars("PU aaa: hello        07/20 14:23"),
      chars("PU aaa: world        07/20 14:31"),
    ];
    const r = buildMergedCommentChars(lines, { userid: "aaa", rows: [0, 1] });
    expect(r).not.toBeNull();
    expect(textOf(r.chars)).toBe("PU aaa: hello\nworld        07/20 14:31");
  });

  test("末行時間戳與原生列同一欄（末行寬度＝原列到時間戳結束的寬度）", () => {
    const lastRow = "PU aaa: world        07/20 14:31";
    const lines = [chars("PU aaa: hello        07/20 14:23"), chars(lastRow)];
    const r = buildMergedCommentChars(lines, { userid: "aaa", rows: [0, 1] });
    const info = commentContentCells(lines[1]);
    const lastLine = textOf(r.chars).split("\n").pop();
    // 合併末行 = 原列從內容起始欄到時間戳結束，一字不差 → 欄位對齊必然相同。
    expect(lastLine).toBe(lastRow.slice(info.start));
    // 時間戳結束欄＝內容起始欄 + 末行長度，與原列一致。
    expect(info.start + lastLine.length).toBe(
      info.timeStart + info.time.length,
    );
  });

  // 使用者回報（AI_Art M.1785606011 三連推）：中間那則「剛好打滿到欄位最後一格」，
  // 舊的 gap 門檻因此把三則黏成一段。打滿與否不再影響斷行。
  test("打滿到欄位最後一格的列，仍與下一則分行", () => {
    const lines = [
      chars("PU aaa: i am changing termptt 07/20 14:26"),
      chars("PU aaa: filled to the very edge 07/20 14:27"),
      chars("PU aaa: short one            07/20 14:28"),
    ];
    const r = buildMergedCommentChars(lines, {
      userid: "aaa",
      rows: [0, 1, 2],
    });
    expect(textOf(r.chars).split("\n")).toEqual([
      "PU aaa: i am changing termptt",
      "filled to the very edge",
      "short one            07/20 14:28",
    ]);
  });

  test("contentStart＝首則內容起始欄（懸掛縮排寬度）", () => {
    const lines = [
      chars("PU aaa: hello        07/20 14:23"),
      chars("PU aaa: world        07/20 14:31"),
    ];
    const r = buildMergedCommentChars(lines, { userid: "aaa", rows: [0, 1] });
    expect(r.contentStart).toBe(8); // "PU aaa: ".length
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
    expect(textOf(r.chars)).toBe("PU aaa: hello\nworld        07/20 14:31");
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

  // 換行是唯一的合成 cell；連時間戳前的分隔空白也**重用**原列的空白 cell 實例
  // ——沿用實例才不會剝掉 TermChar prototype（isStartOfURL 等）。
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
// 舊版曾用 gap 門檻猜「哪幾則原本是同一句」，已於 2026-08 廢除（見 comment_merge.js
// 檔頭）：此素材現在的期望是十二則各自成行、內容零遺失且逐則連續。
describe("真實素材（wettland5566 十二連推）", () => {
  const fx = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "fixtures/comment_merge_wettland.json"),
      "utf8",
    ),
  );
  const lines = fx.rows.map((b64) =>
    Array.from(Buffer.from(b64, "base64").toString("latin1")).map(cell),
  );

  test("十二則各自成行，逐則內容完整且順序不變", () => {
    const run = { userid: "wettland5566", rows: lines.map((_, i) => i) };
    const r = buildMergedCommentChars(lines, run);
    expect(r).not.toBeNull();
    const parts = textOf(r.chars).split("\n");
    expect(parts.length).toBe(lines.length);
    const contents = lines.map((l) => {
      const info = commentContentCells(l);
      return textOf(l.slice(info.start, info.end));
    });
    // 第一段還帶著首則前綴「噓 wettland5566: 」，中段＝該則內容原樣，
    // 末段＝最後一則從內容起始欄到時間戳結束（padding 原樣帶著 → 時間置右對齊）。
    expect(parts[0].endsWith(contents[0])).toBe(true);
    expect(parts.slice(1, -1)).toEqual(contents.slice(1, -1));
    const last = lines[lines.length - 1];
    const li = commentContentCells(last);
    expect(parts[parts.length - 1]).toBe(
      textOf(last.slice(li.start, li.timeStart + li.time.length)),
    );
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
