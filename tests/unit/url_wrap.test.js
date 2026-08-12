// 跨行推文連結接合（src/js/url_wrap.js）純邏輯守護。
//
// PTT 推文輸入欄有固定寬度上限（pttbbs bbs.c#recommend maxlength +
// vtuikit.c#vgetstring 的 iend+1>=len），作者貼長網址會被硬切成兩則連續推文：
//   → pttuser : ...DeepMind員工 https://i.imgur.c  08/09 15:35
//   → pttuser : om/Pn3XurX.jpeg                    08/09 15:35
// 逐列偵測（TermBuf.uriRegEx / url_fix.detectFixableUrls）兩層都看不到完整網址。
// 本模組在「連續同作者推文合併」塊的換行邊界把它接回去。
//
// 三個訊號缺一不可（單一訊號都會誤判，見 comment_merge.js 檔頭的 gap 門檻教訓）：
//   1. 左邊那則寫滿內容欄（breaks[].leftFull，由 comment_merge 依 pttbbs 算式推導）
//   2. 兩則時間戳相差 ≤ 1 分鐘
//   3. 斷點兩側**併起來**是合法 URL（TLD 允許清單，與 url_fix 共用一份）
//
// cell 假資料手法同 comment_merge.test.js：ASCII-only，DBCS 用
// { ch, isLeadByte } 佔位（trail byte 刻意取 '@'＝0x40，重現「trail byte 長得像
// ASCII」的踩坑）。
import fs from "node:fs";
import path from "node:path";
import { detectWrappedUrls } from "../../src/js/url_wrap";
import {
  buildMergedCommentChars,
  commentContentCells,
} from "../../src/js/comment_merge";

const cell = (c) => ({ ch: c });
const chars = (str) => str.split("").map(cell);

const TIME = "08/09 15:35";

// 直接搭出「合併塊」的 chars + breaks（不經 buildMergedCommentChars，聚焦本模組）。
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

describe("detectWrappedUrls", () => {
  test("使用者範例：scheme 帶在左片段，斷在 host 中間 → 接回完整圖片網址", () => {
    const b = block("PU pttuser: works at DeepMind https://i.imgur.c", "om/Pn3XurX.jpeg");
    expect(detectWrappedUrls(b.chars, b.breaks)).toEqual([
      {
        original: "https://i.imgur.c\nom/Pn3XurX.jpeg",
        fixed: "https://i.imgur.com/Pn3XurX.jpeg",
        host: "i.imgur.com",
        gray: false,
        wrapped: true,
      },
    ]);
  });

  test("斷在 path 中間也接", () => {
    const b = block("PU aaa: pic https://i.imgur.com/Pn3Xur", "X.jpeg");
    expect(detectWrappedUrls(b.chars, b.breaks)[0].fixed).toBe(
      "https://i.imgur.com/Pn3XurX.jpeg",
    );
  });

  test("上一則沒寫滿內容欄 → 不接（作者只是分兩則講話）", () => {
    const b = block("PU aaa: pic https://i.imgur.c", "om/x.jpeg", {
      leftFull: false,
    });
    expect(detectWrappedUrls(b.chars, b.breaks)).toEqual([]);
  });

  test("兩則時間差 > 1 分鐘 → 不接", () => {
    const b = block("PU aaa: pic https://i.imgur.c", "om/x.jpeg", {
      rightTime: "08/09 15:37",
    });
    expect(detectWrappedUrls(b.chars, b.breaks)).toEqual([]);
  });

  test("跨分鐘（差 1 分）仍接：送出時剛好跨過整分", () => {
    const b = block("PU aaa: pic https://i.imgur.c", "om/x.jpeg", {
      leftTime: "08/09 15:35",
      rightTime: "08/09 15:36",
    });
    expect(detectWrappedUrls(b.chars, b.breaks)).toHaveLength(1);
  });

  // 反向守門：左片段本身已經是「作者剛好寫滿的完整網址」，下一則是新的一句話。
  test("左片段以媒體副檔名結尾 → 視為完整網址，不接", () => {
    const b = block("PU aaa: pic https://i.imgur.com/abc.jpeg", "ok");
    expect(detectWrappedUrls(b.chars, b.breaks)).toEqual([]);
  });

  test("右片段不是從下一則內容的第 0 欄接續（前面有空白）→ 不接", () => {
    const b = block("PU aaa: pic https://i.imgur.c", " om/x.jpeg");
    expect(detectWrappedUrls(b.chars, b.breaks)).toEqual([]);
  });

  test("左片段以中文結尾（沒有 URL 字元）→ 不接", () => {
    const cells = chars("PU aaa: hello").concat(
      [{ ch: "\xb1", isLeadByte: true }, { ch: "\xc0" }],
      chars("\nom/x.jpeg"),
    );
    const breaks = [
      { index: 15, leftFull: true, leftTime: TIME, rightTime: TIME },
    ];
    expect(detectWrappedUrls(cells, breaks)).toEqual([]);
  });

  // 踩坑重現：Big5 trail byte 可能剛好是 0x40（'@'）這種合法 URL 字元，
  // 掃描一律走 cell 旗標，不可只看 ch。
  test("DBCS trail byte 長得像 ASCII（'@'）不得被當成 URL 字元", () => {
    const cells = chars("PU aaa: pic ").concat(
      [{ ch: "\xb1", isLeadByte: true }, { ch: "@" }],
      chars("\nom/x.jpeg"),
    );
    const breaks = [
      { index: 14, leftFull: true, leftTime: TIME, rightTime: TIME },
    ];
    expect(detectWrappedUrls(cells, breaks)).toEqual([]);
  });

  test("接起來的 TLD 不在允許清單 → 不接", () => {
    const b = block("PU aaa: pic https://i.imgur.z", "zz/x.jpeg");
    expect(detectWrappedUrls(b.chars, b.breaks)).toEqual([]);
  });

  test("無 scheme 但有路徑 → 接並補 https://", () => {
    const b = block("PU aaa: pic i.imgur.c", "om/x.jpeg");
    expect(detectWrappedUrls(b.chars, b.breaks)[0].fixed).toBe(
      "https://i.imgur.com/x.jpeg",
    );
  });

  // url_fix 的 gray 那一類（無 scheme、無路徑）在這裡直接排除：接出來只是首頁連結，
  // 證據薄弱到不值得，也就永遠不需要 AI 閘門。
  test("無 scheme 又無路徑 → 不接", () => {
    const b = block("PU aaa: 看 i.imgur.c", "om");
    expect(detectWrappedUrls(b.chars, b.breaks)).toEqual([]);
  });

  test("多個斷點各自判斷；同一個結果不重複回報", () => {
    const left = "PU aaa: a https://i.imgur.c";
    const mid = "om/x.jpeg then https://i.imgur.c";
    const right = "om/x.jpeg";
    const cells = chars(left + "\n" + mid + "\n" + right);
    const breaks = [
      { index: left.length, leftFull: true, leftTime: TIME, rightTime: TIME },
      {
        index: left.length + 1 + mid.length,
        leftFull: true,
        leftTime: TIME,
        rightTime: TIME,
      },
    ];
    const out = detectWrappedUrls(cells, breaks);
    expect(out).toHaveLength(1);
    expect(out[0].fixed).toBe("https://i.imgur.com/x.jpeg");
  });

  test("沒有 breaks / 空塊 → []", () => {
    expect(detectWrappedUrls(chars("PU aaa: hi"), [])).toEqual([]);
    expect(detectWrappedUrls(chars("PU aaa: hi"), undefined)).toEqual([]);
  });
});

// 端到端（純邏輯層）：用真實 78 欄佈局的推文列跑完 buildMergedCommentChars →
// detectWrappedUrls，確認 leftFull 是由 comment_merge 依 pttbbs 算式算對的。
describe("整合：78 欄推文列 → 合併 → 接合", () => {
  // 內容欄右界 col 66（fieldEnd）、時間戳固定 col 67；寫滿的一列內容 exclusive
  // 尾端＝ fieldEnd - 1 ＝ 65（vtuikit.c#vgetstring 的 iend+1>=len）。
  const fullRow = (id, prose, tail, time) => {
    const prefix = `PU ${id}: `;
    const gap = 65 - prefix.length - prose.length - tail.length;
    return chars(
      (prefix + prose + " ".repeat(gap) + tail).padEnd(66) + " " + time,
    );
  };
  const shortRow = (id, content, time) =>
    chars(`PU ${id}: ${content}`.padEnd(66) + " " + time);

  test("被截斷的 imgur 連結接回去", () => {
    const lines = [
      fullRow("pttuser", "works at DeepMind", "https://i.imgur.c", TIME),
      shortRow("pttuser", "om/Pn3XurX.jpeg", TIME),
    ];
    expect(lines[0]).toHaveLength(78);
    const info = commentContentCells(lines[0]);
    expect(info.fieldEnd).toBe(66);
    expect(info.end).toBe(65); // 寫滿

    const merged = buildMergedCommentChars(lines, {
      userid: "pttuser",
      rows: [0, 1],
    });
    // 合併塊＝首則前綴(12) + 首則內容(53) → 換行 cell 落在 index 65。
    expect(merged.breaks).toEqual([
      { index: 65, leftFull: true, leftTime: TIME, rightTime: TIME },
    ]);
    expect(detectWrappedUrls(merged.chars, merged.breaks)[0].fixed).toBe(
      "https://i.imgur.com/Pn3XurX.jpeg",
    );
  });

  test("沒寫滿的一列 leftFull=false → 不接", () => {
    const lines = [
      shortRow("pttuser", "pic https://i.imgur.c", TIME),
      shortRow("pttuser", "om/Pn3XurX.jpeg", TIME),
    ];
    const merged = buildMergedCommentChars(lines, {
      userid: "pttuser",
      rows: [0, 1],
    });
    expect(merged.breaks[0].leftFull).toBe(false);
    expect(detectWrappedUrls(merged.chars, merged.breaks)).toEqual([]);
  });

  test("IP 板（BRD_IPLOGRECMD）：內容欄右界扣掉 15 欄的 IP 區", () => {
    // tail = "%15s MM/DD HH:MM" → 內容欄 [start, 51)，寫滿的尾端＝50。
    const prefix = "PU pttuser: ";
    const body = "pic https://i.imgur.c";
    const row = chars(
      (prefix + " ".repeat(50 - prefix.length - body.length) + body).padEnd(
        51,
      ) + "    1.200.29.12 " + TIME,
    );
    expect(row).toHaveLength(78);
    const info = commentContentCells(row);
    expect(info.fieldEnd).toBe(51);
    expect(info.end).toBe(50);
  });
});

// 真實素材回歸（使用者 2026-08-12 的 debug 錄製，Stock 板三連推）。fixture 為畫面
// 還原後的 Big5 原始 bytes（1 byte = 1 cell/col，全行 80 欄），只保留該 run 的三列
// ——debug dump 本身含使用者按鍵，不入 repo；帳號代換成同長度佔位。
describe("真實素材（imgur 網址被推文寬度切斷）", () => {
  const fx = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures/url_wrap_imgur.json"), "utf8"),
  );
  const lines = fx.rows.map((b64) =>
    Array.from(Buffer.from(b64, "base64").toString("latin1")).map(cell),
  );
  const run = { userid: "pttuser", rows: [0, 1, 2] };

  test("第 1 則寫滿內容欄（BRD_ALIGNEDCMT 的 id 補空格不影響右界）", () => {
    const info = commentContentCells(lines[0]);
    expect(info.fieldEnd).toBe(66);
    expect(info.end).toBe(65);
  });

  test("斷掉的 imgur 網址接回完整網址；作者自己重貼的那則不被誤接", () => {
    const merged = buildMergedCommentChars(lines, run);
    expect(merged.breaks).toHaveLength(2);
    expect(merged.breaks[0].leftFull).toBe(true); // 被輸入欄切斷
    expect(merged.breaks[1].leftFull).toBe(false); // "om/Pn3XurX.jpeg" 只有半行
    const out = detectWrappedUrls(merged.chars, merged.breaks);
    expect(out).toHaveLength(1);
    expect(out[0].fixed).toBe("https://i.imgur.com/Pn3XurX.jpeg");
    expect(out[0].original).toBe("https://i.imgur.c\nom/Pn3XurX.jpeg");
    expect(out[0].gray).toBe(false);
  });
});
