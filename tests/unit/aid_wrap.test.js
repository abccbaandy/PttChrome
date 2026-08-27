// 跨行推文 AID 接合（src/js/aid_wrap.js）純邏輯守護。
//
// url_wrap.test.js 的姊妹檔，harness 手法完全照抄（直接搭出「合併塊」的
// chars + breaks，不經 buildMergedCommentChars，聚焦本模組）。
//
// 三個訊號缺一不可：
//   1. 左邊那則寫滿內容欄（breaks[].leftFull）
//   2. 兩則時間戳相差 ≤ 1 分鐘
//   3. 斷點兩側併起來**恰好** 8 個 AID 字元，且左片段前面是一個合法起頭的 '#'
import { detectWrappedAids } from "../../src/js/aid_wrap";

const cell = (c) => ({ ch: c });
const chars = (str) => str.split("").map(cell);

const TIME = "08/26 22:17";

const block = (left, right, opts = {}) => ({
  chars: chars(left + "\n" + right),
  breaks: [
    {
      index: left.length,
      leftFull: true,
      leftTime: TIME,
      rightTime: TIME,
      ...opts,
    },
  ],
});

describe("detectWrappedAids", () => {
  // 一次接合產出兩筆候選：左右殘段各自成錨（範圍型連結不可跨換行，見模組檔頭）。
  test("8 碼被切成 6+2 → 接回完整 AID，左右殘段各一筆候選", () => {
    const left = "PU pttuser: 這篇有講 #1gU3ww";
    const b = block(left, "NZ (Browsers) 可以看");
    expect(detectWrappedAids(b.chars, b.breaks)).toEqual([
      {
        // 左殘段：'#' 起，收在換行格（exclusive）
        startCol: left.indexOf("#"),
        endCol: left.length,
        aid: "1gU3wwNZ",
        board: "Browsers",
      },
      {
        // 右殘段：換行後第一格起
        startCol: left.length + 1,
        endCol: left.length + 1 + 2,
        aid: "1gU3wwNZ",
        board: "Browsers",
      },
    ]);
  });

  test("切成 1+7 也接（切在哪一碼不影響）", () => {
    const b = block("PU aaa: xx #1", "gU3wwNZ ok");
    expect(detectWrappedAids(b.chars, b.breaks)[0].aid).toBe("1gU3wwNZ");
  });

  test("看板後綴用 @Board 形式一樣取得", () => {
    const b = block("PU aaa: xx #1gU3ww", "NZ@Browsers 可以看");
    expect(detectWrappedAids(b.chars, b.breaks)[0].board).toBe("Browsers");
  });

  test("沒有看板後綴 → board 為 null（呼叫端退回目前看板）", () => {
    const b = block("PU aaa: xx #1gU3ww", "NZ 可以看");
    expect(detectWrappedAids(b.chars, b.breaks)[0].board).toBeNull();
  });

  test("後綴又被切到再下一則 → parseBoardSuffix 跨換行仍取得", () => {
    const c = chars("PU aaa: xx #1gU3ww" + "\n" + "NZ" + "\n" + "(Browsers) 看");
    const i1 = "PU aaa: xx #1gU3ww".length;
    const breaks = [
      { index: i1, leftFull: true, leftTime: TIME, rightTime: TIME },
      { index: i1 + 3, leftFull: false, leftTime: TIME, rightTime: TIME },
    ];
    expect(detectWrappedAids(c, breaks)[0].board).toBe("Browsers");
  });

  // ---- 三訊號逐條 ----
  test("上一則沒寫滿內容欄 → 不接（作者只是分兩則講話）", () => {
    const b = block("PU aaa: xx #1gU3ww", "NZ (Browsers)", { leftFull: false });
    expect(detectWrappedAids(b.chars, b.breaks)).toEqual([]);
  });

  test("兩則時間差 > 1 分鐘 → 不接", () => {
    const b = block("PU aaa: xx #1gU3ww", "NZ (Browsers)", {
      rightTime: "08/26 22:19",
    });
    expect(detectWrappedAids(b.chars, b.breaks)).toEqual([]);
  });

  test("跨分鐘（差 1 分）仍接", () => {
    const b = block("PU aaa: xx #1gU3ww", "NZ (Browsers)", {
      rightTime: "08/26 22:18",
    });
    expect(detectWrappedAids(b.chars, b.breaks)).toHaveLength(2);
  });

  // ---- AID 形狀 ----
  test("併起來只有 7 碼 → 不接", () => {
    const b = block("PU aaa: xx #1gU3w", "NZ (Browsers)");
    expect(detectWrappedAids(b.chars, b.breaks)).toEqual([]);
  });

  test("併起來 9 碼（第 9 格仍是 AID 字元）→ 不接，那是別的識別碼", () => {
    const b = block("PU aaa: xx #1gU3ww", "NZx (Browsers)");
    expect(detectWrappedAids(b.chars, b.breaks)).toEqual([]);
  });

  test("左片段自己就滿 8 碼 → 不接（逐列 detectAids 抓得到，不重複產生）", () => {
    const b = block("PU aaa: xx #1gU3wwNZ", "abc");
    expect(detectWrappedAids(b.chars, b.breaks)).toEqual([]);
  });

  test("左片段沒有 '#' 開頭 → 不接（只是普通字被切斷）", () => {
    const b = block("PU aaa: xxxxxx1gU3ww", "NZ (Browsers)");
    expect(detectWrappedAids(b.chars, b.breaks)).toEqual([]);
  });

  test("'#' 前一格是 AID 字元 → 不接（同 detectAids 的 a#... 規則）", () => {
    const b = block("PU aaa: xx a#1gU3ww", "NZ (Browsers)");
    expect(detectWrappedAids(b.chars, b.breaks)).toEqual([]);
  });

  test("'#' 前一格是 '#' → 不接", () => {
    const b = block("PU aaa: xx ##1gU3ww", "NZ (Browsers)");
    expect(detectWrappedAids(b.chars, b.breaks)).toEqual([]);
  });

  test("右片段不是從下一則第 0 欄接續（開頭是空白）→ 不接", () => {
    const b = block("PU aaa: xx #1gU3ww", " NZ (Browsers)");
    expect(detectWrappedAids(b.chars, b.breaks)).toEqual([]);
  });

  // ---- DBCS 旗標：trail byte 可能長得像合法 AID 字元 ----
  test("左片段緊貼換行的是 Big5 trail byte → 不接（必須看旗標不是 ch）", () => {
    const c = chars("PU aaa: xx #1gU3w").concat([
      { ch: "\xa4", isLeadByte: true },
      { ch: "Z" }, // trail byte 剛好是合法 AID 字元
      { ch: "\n" },
      ...chars("NZ (Browsers)"),
    ]);
    const breaks = [
      { index: c.findIndex((x) => x.ch === "\n"), leftFull: true, leftTime: TIME, rightTime: TIME },
    ];
    expect(detectWrappedAids(c, breaks)).toEqual([]);
  });

  // ---- URL fragment 同形（term_url_flag 的那個坑）----
  test("斷點兩側落在已標記的 URL 內 → 不接，免得把網址從中切開", () => {
    const left = "PU aaa: see https://x.io/a/#1gU3ww";
    const b = block(left, "NZ/ok");
    const urlFrom = left.indexOf("https://");
    for (let i = urlFrom; i < b.chars.length; ++i) {
      if (b.chars[i].ch === "\n") continue;
      b.chars[i].isPartOfURL = () => true;
    }
    expect(detectWrappedAids(b.chars, b.breaks)).toEqual([]);
  });

  // ---- 邊界 ----
  test("沒有 breaks → 直接回空（絕大多數塊走這條）", () => {
    expect(detectWrappedAids(chars("PU aaa: nothing"), [])).toEqual([]);
    expect(detectWrappedAids(null, null)).toEqual([]);
  });

  test("同一塊最多接 3 處（每處 2 筆候選）", () => {
    let s = "PU aaa: ";
    const breaks = [];
    for (let k = 0; k < 5; ++k) {
      s += "#1gU3ww";
      breaks.push({ index: s.length, leftFull: true, leftTime: TIME, rightTime: TIME });
      // 每一段用不同的尾 2 碼，否則會被 seen 去重
      s += "\nN" + k + " ";
    }
    expect(detectWrappedAids(chars(s), breaks)).toHaveLength(6);
  });

  test("同一個 AID 出現兩次只接一處", () => {
    let s = "PU aaa: #1gU3ww";
    const b1 = s.length;
    s += "\nNZ #1gU3ww";
    const b2 = s.length;
    s += "\nNZ ok";
    const breaks = [
      { index: b1, leftFull: true, leftTime: TIME, rightTime: TIME },
      { index: b2, leftFull: true, leftTime: TIME, rightTime: TIME },
    ];
    expect(detectWrappedAids(chars(s), breaks)).toHaveLength(2);
  });
});
