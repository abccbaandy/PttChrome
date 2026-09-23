// scripts/debug-screens.mjs（`yarn debug:screens`）：把 debug 錄製檔解回畫面／時間軸。
//
// 為什麼要守：這是分析使用者回報的主要工具，它錯了會**看起來像 PTT 送了那些東西**
// （2026-09-24 臨時手寫的迷你 VT 把 `351661` 解成 `2026661`、多出 `116;18H…` 殘渣）。
// 所以兩件事一定要成立：
//   1. 錄製檔格式跟 recorder 同源 —— 測試素材一律由 app 自己的 serializeRecording
//      產生，recorder 改格式時這裡會紅，而不是工具默默解出空畫面。
//   2. 畫面走 app 自己的 TermBuf/AnsiParser（Big5 → Unicode 與 getRowText 同一條路）。
import { TermBuf } from "../../src/js/term_buf";
import { AnsiParser } from "../../src/js/ansi_parser";
import { serializeRecording } from "../../src/js/debug_recorder_logic";
import {
  decodeRecording,
  escapeBytes,
  formatScreen,
  formatTimeline,
  parseArgs,
  replayScreens,
} from "../../scripts/debug-screens.mjs";
import { loadBig5Tables } from "./helpers/load_big5_tables";

loadBig5Tables();

// Unicode → Big5 位元組（latin1 字串），用 app 那份轉碼表。
function big5(str) {
  let out = "";
  for (const ch of str) {
    const c = ch.charCodeAt(0);
    if (c < 0x80) out += ch;
    else
      out +=
        String.fromCharCode(window.lib.u2bArray[2 * c]) +
        String.fromCharCode(window.lib.u2bArray[2 * c + 1]);
  }
  return out;
}

function recording(events, rows = 28) {
  return JSON.parse(serializeRecording({ events, rows, meta: { build: "test" } }));
}

const deps = { TermBuf, AnsiParser };

describe("decodeRecording", () => {
  test("列數取自 cassette.rows（28 列終端機），--rows 可覆寫", () => {
    const rec = recording([{ t: 0, dir: "recv", data: "x" }], 28);
    expect(decodeRecording(rec).rows).toBe(28);
    expect(decodeRecording(rec, { rows: 30 }).rows).toBe(30);
  });

  test("recv/send 解回原始位元組（一字元一位元組）", () => {
    const bytes = "\x1b[2J" + big5("看板");
    const rec = decodeRecording(recording([{ t: 5, dir: "recv", data: bytes }]));
    expect(rec.events[0].bytes).toBe(bytes);
  });
});

describe("replayScreens（真 TermBuf/AnsiParser）", () => {
  test("在指定時間點拍畫面：只餵到 t ≤ 該時間點的 recv，中文與游標正確", () => {
    const rec = decodeRecording(
      recording([
        { t: 10, dir: "recv", data: "\x1b[2J\x1b[1;1H" + big5("第一幀") },
        { t: 20, dir: "send", data: "v" },
        {
          t: 30,
          dir: "recv",
          data: "\x1b[2J\x1b[4;1H" + big5(">351746 ~   9/23 w790818      □ [死神] 聲優") + "\x1b[4;1H",
        },
      ])
    );
    const [a, b] = replayScreens(rec, [15, 30], deps);
    expect(a.rows[0].trimEnd()).toBe("第一幀");
    expect(a.lastRecvT).toBe(10);
    expect(b.lastRecvT).toBe(30);
    expect(b.rows[0].trim()).toBe("");
    expect(b.rows[3]).toContain("351746");
    expect(b.rows[3]).toContain("[死神] 聲優");
    expect(b.curY).toBe(3);
    expect(b.curX).toBe(0);
    expect(b.rows).toHaveLength(28);
  });

  test("時間點比所有事件都晚 ⇒ 拍的是最後的畫面；傳入順序不影響", () => {
    const rec = decodeRecording(
      recording([
        { t: 10, dir: "recv", data: "A" },
        { t: 20, dir: "recv", data: "B" },
      ])
    );
    const shots = replayScreens(rec, [99, 10], deps);
    expect(shots.map((s) => s.at)).toEqual([10, 99]);
    expect(shots[0].rows[0].trimEnd()).toBe("A");
    expect(shots[1].rows[0].trimEnd()).toBe("AB");
  });

  test("formatScreen 標出游標列與時間", () => {
    const rec = decodeRecording(recording([{ t: 1, dir: "recv", data: "\x1b[2;1Hhi" }]));
    const text = formatScreen(replayScreens(rec, [1], deps)[0]);
    expect(text).toContain("t=1");
    expect(text).toMatch(/^ 1>\|hi/m);
  });
});

describe("時間軸", () => {
  test("send 解成可讀字串、log 附 info、連續 recv 摺成一行", () => {
    const rec = decodeRecording(
      recording([
        { t: 1, dir: "recv", data: "aa" },
        { t: 2, dir: "recv", data: "bbb" },
        { t: 3, dir: "send", data: "351746\r\f" },
        { t: 4, dir: "log", tag: "queue.done", info: { kind: "x" } },
      ])
    );
    const out = formatTimeline(rec);
    expect(out).toContain("recv ×2（5 bytes）");
    expect(out).toContain("send 351746\\r\\f");
    expect(out).toContain('log  queue.done {"kind":"x"}');
  });

  test("--from/--to 只留該區間", () => {
    const rec = decodeRecording(
      recording([
        { t: 1, dir: "send", data: "a" },
        { t: 50, dir: "send", data: "b" },
        { t: 99, dir: "send", data: "c" },
      ])
    );
    const out = formatTimeline(rec, { from: 10, to: 60 });
    expect(out).toContain("send b");
    expect(out).not.toContain("send a");
    expect(out).not.toContain("send c");
  });

  test("escapeBytes：控制字元具名、高位元組 \\xNN", () => {
    expect(escapeBytes("\x1b[6~")).toBe("\\e[6~");
    expect(escapeBytes("\x15\x7f")).toBe("^U\\x7f");
    expect(escapeBytes("\xa4\xa4")).toBe("\\xa4\\xa4");
  });
});

describe("parseArgs", () => {
  test("檔名＋時間點＋選項", () => {
    expect(parseArgs(["f.json", "13417", "--rows", "30", "13891"])).toEqual({
      file: "f.json",
      times: [13417, 13891],
      rows: 30,
      from: null,
      to: null,
    });
  });

  test("看不懂的參數直接報錯（不可默默忽略成空結果）", () => {
    expect(() => parseArgs(["f.json", "abc"])).toThrow();
  });
});
