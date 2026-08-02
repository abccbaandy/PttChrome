// 好讀「連續同作者推文合併」的 Screen render 接線守護（仿
// merge_image_caption_render.test.jsx）。守的是使用者 2026-08 回報的症狀：
//   1. 三則連推被黏成一段 → 現在一則一行（塊內換行數 = 則數 - 1）。
//   2. 換行後回到第 0 欄 → 懸掛縮排（padding-left 與 text-indent 互為相反、
//      寬度＝首則內容起始欄 × 半形字寬）。
//   3. 時間戳位置與樣式 → **作者在第一則、時間在最後一則**，且時間是一般文字
//      cell（在 bbsline span 內，故 ^C 的 getSelection 選得到），非 React 標籤。
import { render } from "@testing-library/react";
import Screen from "../../src/components/Screen";

const COLOR = {
  fg: 7,
  bg: 0,
  blink: false,
  equals(o) {
    return o === this;
  },
};

function cell(c) {
  return {
    ch: c,
    isLeadByte: false,
    isStartOfURL: () => false,
    isEndOfURL: () => false,
    getFullURL: () => null,
    getColor: () => COLOR,
  };
}
const line = (str) => str.split("").map(cell);

// 原生推文列的欄位配置（見 docs/pttbbs-screen-protocol.md §11.1）：marker 佔
// cols 0-1（DBCS，此處以第 2 個 cell 補空字串佔位讓 rowToText 與欄位數學都成立）、
// col 2 空格、id 從 col 3 起、`: ` 之後是內容欄，時間戳一律從 TIME_COL 起。
const TIME_COL = 67;
const comment = (marker, id, content, time) => {
  const prefix = ` ${id}: `;
  const startCol = 2 + prefix.length;
  const pad = " ".repeat(TIME_COL - (startCol + content.length));
  return [cell(marker), cell("")].concat(line(prefix + content + pad + time));
};

const ID = "testuser01";
const PREFIX_COLS = 2 + ` ${ID}: `.length; // 15：內容起始欄
const LAST_TIME = "07/20 14:28";
const lines = [
  line("--"),
  comment("推", ID, "first push line", "07/20 14:26"),
  // 打滿到最後一格（pad 僅剩必要的 1 格）——舊 gap 門檻會把它與下一則黏成一段。
  comment("→", ID, "x".repeat(TIME_COL - PREFIX_COLS - 1), "07/20 14:27"),
  comment("→", ID, "third", LAST_TIME),
  comment("推", "another01", "unrelated", "07/20 14:29"),
];

const FORCE_WIDTH = 20;

function renderScreen() {
  return render(
    <Screen
      lines={lines}
      forceWidth={FORCE_WIDTH}
      enableLinkInlinePreview={false}
      enableLinkHoverPreview={false}
      enhance={{
        pageState: 3,
        easyReading: true,
        dropHidden: true,
        articleId: 1,
        mergeSameAuthorComments: true,
      }}
    />,
  );
}

// 一則一行＝一個 bbsline span（每行各自帶自動開圖，見 LinkSegmentBuilder）。
const blockLines = (c) =>
  Array.from(
    c.querySelectorAll(".mergedCommentBlock [data-type=bbsline]"),
  ).map((n) => n.textContent);

describe("Screen 推文合併 render", () => {
  test("三則連推合成一塊、各自成行；不同作者不併入", () => {
    const { container: c } = renderScreen();
    const blocks = c.querySelectorAll(".mergedCommentBlock");
    expect(blocks.length).toBe(1);
    const parts = blockLines(c);
    const text = parts.join("\n");
    expect(parts.length).toBe(3);
    expect(parts[0]).toContain("first push line");
    expect(parts[1]).toBe("x".repeat(TIME_COL - PREFIX_COLS - 1));
    expect(parts[2].startsWith("third")).toBe(true);
    // 另一位作者維持自己的列，沒被吃進合併塊。
    expect(text).not.toContain("unrelated");
    expect(c.querySelector('[data-pusher="another01"]')).not.toBeNull();
  });

  test("懸掛縮排寬度＝內容起始欄×半形字寬（CSS 由這個 var 推導）", () => {
    const { container: c } = renderScreen();
    const block = c.querySelector(".mergedCommentBlock");
    // inline CSS var（jsdom 不算 calc，直接驗變數值；bbsrow padding-left 與首則
    // bbsline 的負 margin 都由它推導）
    expect(block.style.getPropertyValue("--merged-comment-indent")).toBe(
      `${(PREFIX_COLS * FORCE_WIDTH) / 2}px`,
    );
  });

  test("作者在第一則、時間在最後一則；時間是 bbsline 內的一般文字（可選取複製）", () => {
    const { container: c } = renderScreen();
    const parts = blockLines(c);
    // 作者只出現在第一行；中間各則不重複前綴。
    expect(parts[0]).toContain("testuser01");
    expect(parts[1]).not.toContain("testuser01");
    expect(parts[2]).not.toContain("testuser01");
    // 時間只出現一次，在最後一行尾端（＝最後一則的時間，非首則）。
    const times = parts.join("\n").match(/\d{1,2}\/\d{2} \d{2}:\d{2}/g);
    expect(times).toEqual([LAST_TIME]);
    expect(parts[2].endsWith(LAST_TIME)).toBe(true);
    // **置右**：末行的左緣偏移＝PREFIX_COLS（懸掛縮排），加上末行寬度後，時間戳
    // 起訖欄與原生逐列渲染完全相同（TIME_COL..TIME_COL+11）。
    expect(PREFIX_COLS + parts[2].length).toBe(TIME_COL + LAST_TIME.length);
    expect(PREFIX_COLS + parts[2].indexOf(LAST_TIME)).toBe(TIME_COL);
    // 已無 React 時間標籤節點（舊 .mergedCommentTime 帶 user-select:none 不可複製）。
    expect(c.querySelector(".mergedCommentTime")).toBeNull();
  });
});
