// 反向讀取（End）的純函式：累積分支、兩段接合的重疊、交易決策、splice 形狀、run 斷點。
// 協定事實出自 pmore.c（見 docs/pttbbs-screen-protocol.md §13 P10/P11）。
import {
  decideReverseBranch,
  resolveJoinOverlap,
} from "../../src/js/comment_parse";
import {
  nextReverseReadDecision,
  nextPageDownDecision,
  inFlightGate,
  REVERSE_RESEEK_MAX,
  PAGE_DOWN_GRACE_MS,
} from "../../src/js/easy_reading";
import { spliceShape } from "../../src/js/screen_annotate_cache";
import { groupSameAuthorRuns } from "../../src/js/comment_merge";

describe("decideReverseBranch", () => {
  const base = { complete: true, headEndLine: 67 };
  const d = (x) => decideReverseBranch({ ...base, ...x });

  test("非完整幀／沒有狀態列 ⇒ skip", () => {
    expect(d({ complete: false, statusStart: 200, statusEnd: 222 })).toBe("skip");
    expect(d({ statusStart: null, statusEnd: null })).toBe("skip");
  });

  test("tail 未建立：舊 head 幀 ignore、落地頁接得上 head ⇒ joinForward、否則 seed", () => {
    expect(d({ statusStart: 45, statusEnd: 67 })).toBe("ignore");
    expect(d({ statusStart: 67, statusEnd: 89 })).toBe("joinForward");
    // 只相鄰（E_head+1）不算接得上：H_E 那一行在 head 可能只畫了前半段
    expect(d({ statusStart: 68, statusEnd: 90 })).toBe("seed");
    expect(d({ statusStart: 278, statusEnd: 300 })).toBe("seed");
  });

  test("tail 已建立", () => {
    const t = { tailStartLine: 200, tailEndLine: 222 };
    expect(d({ ...t, statusStart: 222, statusEnd: 244 })).toBe("extend");
    expect(d({ ...t, statusStart: 245, statusEnd: 267 })).toBe("ignore"); // 掉頁
    expect(d({ ...t, statusStart: 200, statusEnd: 222 })).toBe("ignore"); // 同一頁
    expect(d({ ...t, statusStart: 178, statusEnd: 200 })).toBe("prepend");
    // wrap 缺口：只到 S_t-1（該行可能只畫了前半段）⇒ 接不上
    expect(d({ ...t, statusStart: 178, statusEnd: 199 })).toBe("ignore");
    // 碰到 head（S ≤ H_E）⇒ 接合
    expect(d({ ...t, tailStartLine: 80, statusStart: 58, statusEnd: 80 })).toBe("stitch");
    expect(d({ ...t, tailStartLine: 90, statusStart: 68, statusEnd: 90 })).toBe("prepend");
  });
});

describe("resolveJoinOverlap", () => {
  const texts = (a, b) => {
    const out = [];
    for (let i = a; i <= b; ++i) out.push("line " + i);
    return out;
  };

  test("重疊一行（PgUp 的 E' == S_t）", () => {
    expect(
      resolveJoinOverlap({
        upperEndLine: 100,
        lowerStartLine: 100,
        upperTexts: texts(78, 100),
        lowerTexts: texts(100, 122),
      }),
    ).toBe(1);
  });

  test("重疊多行（接合：S ≤ H_E）", () => {
    expect(
      resolveJoinOverlap({
        upperEndLine: 67,
        lowerStartLine: 58,
        upperTexts: texts(1, 67),
        lowerTexts: texts(58, 300),
      }),
    ).toBe(10);
  });

  test("wrap：行號算出 1 行，但那一行在上面只畫了前半段 ⇒ 內容為下界", () => {
    const upper = texts(78, 99).concat(["line 100"]); // 第 100 行只畫到第一列
    const lower = ["line 100", "line 100 (wrap 2)"].concat(texts(101, 120));
    expect(
      resolveJoinOverlap({
        upperEndLine: 100,
        lowerStartLine: 100,
        upperTexts: upper,
        lowerTexts: lower,
      }),
    ).toBe(1);
  });

  test("空的一邊 ⇒ 0", () => {
    expect(
      resolveJoinOverlap({
        upperEndLine: 1,
        lowerStartLine: 1,
        upperTexts: [],
        lowerTexts: ["x"],
      }),
    ).toBe(0);
  });
});

describe("inFlightGate（與 nextPageDownDecision 共用）", () => {
  test("沒有在途 / 簽章已變 ⇒ null（可以送）", () => {
    expect(inFlightGate({ sig: "1~23", inFlightSig: null, retries: 0 })).toBeNull();
    expect(inFlightGate({ sig: "23~45", inFlightSig: "1~23", retries: 0 })).toBeNull();
  });
  test("同簽章：非 recovery 或未過 grace ⇒ wait；過了 ⇒ retry 一次再 giveup", () => {
    const g = (x) => inFlightGate({ sig: "1~23", inFlightSig: "1~23", ...x });
    expect(g({ retries: 0, recovery: false, sinceSentMs: 9999 }).action).toBe("wait");
    expect(g({ retries: 0, recovery: true, sinceSentMs: 10 }).action).toBe("wait");
    expect(g({ retries: 0, recovery: true, sinceSentMs: PAGE_DOWN_GRACE_MS })).toEqual({
      action: "retry",
      retries: 1,
    });
    expect(g({ retries: 1, recovery: true, sinceSentMs: PAGE_DOWN_GRACE_MS }).action).toBe(
      "giveup",
    );
  });
  test("nextPageDownDecision 的行為不變（抽出閘門之後）", () => {
    const base = {
      enabled: true, functionMode: false, complete: true, isStatusRow: true,
      pagePercent: 40, sig: "1~23", inFlightSig: "1~23", retries: 0,
      recovery: true, sinceSentMs: 700, graceMs: 600,
    };
    expect(nextPageDownDecision(base)).toEqual({
      action: "retry", inFlightSig: "1~23", retries: 1, reachedPageEnd: false,
    });
    expect(nextPageDownDecision({ ...base, sig: "23~45" })).toEqual({
      action: "send", inFlightSig: "23~45", retries: 0, reachedPageEnd: false,
    });
  });
});

describe("nextReverseReadDecision", () => {
  const base = {
    enabled: true,
    functionMode: false,
    complete: true,
    isStatusRow: true,
    accumulated: true,
    pageRows: 22,
    phase: "running",
    result: null,
    headEndLine: 67,
    tailStartLine: 278,
    tailEndLine: 300,
    tailComplete: true,
    inFlightSig: null,
    retries: 0,
    recovery: false,
    sinceSentMs: null,
    graceMs: 600,
    reseeks: 0,
  };
  const d = (x) => nextReverseReadDecision({ ...base, ...x });

  test("不能動的情況 ⇒ none", () => {
    expect(d({ enabled: false, sig: "278~300" }).action).toBe("none");
    expect(d({ functionMode: true, sig: "278~300" }).action).toBe("none");
    expect(d({ complete: false, sig: "278~300" }).action).toBe("none");
    expect(d({ accumulated: false, sig: "278~300", statusStart: 278 }).action).toBe("none");
  });

  test("在途 ⇒ wait（P4：不疊送）", () => {
    expect(
      d({ sig: "278~300", inFlightSig: "278~300", statusStart: 278, statusEnd: 300 }).action,
    ).toBe("wait");
  });

  test("requested：在途的 PageDown 回來後送 End；剛好讀完 ⇒ cancel", () => {
    const r = { phase: "requested", sig: "45~67", statusStart: 45, statusEnd: 67 };
    expect(d({ ...r, pagePercent: 22 })).toMatchObject({
      action: "send", keys: "\x1b[4~", begin: true, inFlightSig: "45~67",
    });
    expect(d({ ...r, pagePercent: 100 }).action).toBe("cancel");
  });

  test("指標停在 tail 第一頁 ⇒ PgUp；第 1 行絕不送 PgUp", () => {
    expect(d({ sig: "278~300", statusStart: 278, statusEnd: 300 })).toMatchObject({
      action: "send", keys: "\x1b[5~",
    });
    expect(
      d({ sig: "1~23", statusStart: 1, statusEnd: 23, tailStartLine: 1 }).action,
    ).toBe("abort");
  });

  test("tail 還沒補完（End 落地 <100%）⇒ 在尾端送 PageDown，不在就 goto 回尾端", () => {
    const t = { tailComplete: false, tailStartLine: 250, tailEndLine: 272 };
    expect(d({ ...t, sig: "250~272", statusStart: 250, statusEnd: 272 })).toMatchObject({
      action: "send", keys: "\x1b[6~",
    });
    expect(d({ ...t, sig: "100~122", statusStart: 100, statusEnd: 122 })).toMatchObject({
      action: "goto", line: 272,
    });
  });

  test("指標在別處（補完 tail 停在文末）⇒ goto 到 tail 上面那一頁的起點", () => {
    expect(
      d({ tailStartLine: 250, sig: "278~300", statusStart: 278, statusEnd: 300 }),
    ).toMatchObject({ action: "goto", line: 228, reseek: false });
  });

  test("wrap 缺口 ⇒ 往下挪差了的行數重新對準，最多到 S_t-1；額度用完 ⇒ abort", () => {
    const gap = { sig: "256~275", statusStart: 256, statusEnd: 275 };
    expect(d(gap)).toMatchObject({ action: "goto", line: 259, reseek: true });
    // 差很多時夾在 S_t-1
    expect(
      d({ sig: "200~210", statusStart: 200, statusEnd: 210 }),
    ).toMatchObject({ action: "goto", line: 268 });
    expect(d({ ...gap, reseeks: REVERSE_RESEEK_MAX }).action).toBe("abort");
  });

  test("接合完成：指標不在文末 ⇒ 送 End 停回去；到了 ⇒ done", () => {
    const s = { result: "stitched", sig: "45~67", statusStart: 45, statusEnd: 67 };
    expect(d({ ...s, pagePercent: 20 })).toMatchObject({ action: "send", keys: "\x1b[4~" });
    expect(d({ ...s, pagePercent: 100 }).action).toBe("done");
  });

  test("被別的路徑收掉（joined／dropped）⇒ cancel", () => {
    const x = { sig: "45~67", statusStart: 45, statusEnd: 67 };
    expect(d({ ...x, result: "joined" }).action).toBe("cancel");
    expect(d({ ...x, result: "dropped" }).action).toBe("cancel");
  });

  test("goto 的落地簽章不會變 ⇒ abort（否則交易永遠等不到 ack）", () => {
    expect(
      d({ tailStartLine: 300, sig: "278~300", statusStart: 278, statusEnd: 300 }).action,
    ).toBe("abort");
  });
});

describe("spliceShape", () => {
  const a = {}, b = {}, c = {}, x = {}, y = {};
  test("純 append", () => {
    expect(spliceShape([a, b], [a, b, c])).toEqual({ prefix: 2, suffix: 0, inserted: 1, removed: 0 });
  });
  test("中段插入（反向讀取）", () => {
    expect(spliceShape([a, c], [a, x, y, c])).toEqual({ prefix: 1, suffix: 1, inserted: 2, removed: 0 });
  });
  test("有列被拿掉 ⇒ removed > 0", () => {
    expect(spliceShape([a, b, c], [a, c])).toEqual({ prefix: 1, suffix: 1, inserted: 0, removed: 1 });
    expect(spliceShape([a, b], [x, y])).toMatchObject({ removed: 2 });
  });
  test("同一份 ⇒ 全前綴", () => {
    expect(spliceShape([a, b], [a, b])).toEqual({ prefix: 2, suffix: 0, inserted: 0, removed: 0 });
  });
});

describe("groupSameAuthorRuns 的 breakAt", () => {
  const c = (userid) => ({ userid });
  test("在 breakAt 強制斷 run", () => {
    const anns = [c("a"), c("a"), c("a"), c("a")];
    expect(groupSameAuthorRuns(anns)).toEqual([{ userid: "a", rows: [0, 1, 2, 3] }]);
    expect(groupSameAuthorRuns(anns, 2)).toEqual([
      { userid: "a", rows: [0, 1] },
      { userid: "a", rows: [2, 3] },
    ]);
  });
});
