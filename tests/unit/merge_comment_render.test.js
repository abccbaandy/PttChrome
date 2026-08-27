// 好讀「連續同作者推文合併」的渲染接線守護（仿
// merge_image_caption_render.test.js）。守的是使用者 2026-08 回報的症狀：
//   1. 三則連推被黏成一段 → 現在一則一行（塊內換行數 = 則數 - 1）。
//   2. 換行後回到第 0 欄 → 懸掛縮排（padding-left 與 text-indent 互為相反、
//      寬度＝首則內容起始欄 × 半形字寬）。
//   3. 時間戳位置與樣式 → **作者在第一則、時間在最後一則**，且時間是一般文字
//      cell（在 bbsline span 內，故 ^C 的 getSelection 選得到），非 React 標籤。
import { mountScreen, unmountAll } from "./helpers/mount_screen";

// 修復連結行一定會掛延遲載入佔位盒，resolver 在後續 microtask reject。
const flushPreviews = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(unmountAll);

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
  return mountScreen({ lines: lines, forceWidth: FORCE_WIDTH, enableLinkInlinePreview: false, enableLinkHoverPreview: false, enhance: {
        pageState: 3,
        easyReading: true,
        dropHidden: true,
        articleId: 1,
        mergeSameAuthorComments: true,
      } });
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

// 跨行連結接合（src/js/url_wrap.js）的 Screen 接線：被推文輸入欄切成兩則的網址，
// 逐列偵測兩層都看不見（TermBuf.uriRegEx 只看到殘段、url_fix 逐列），只有合併塊
// 的換行邊界接得回來 → 併進 fixedUrls，沿用既有的 ↳ 修復行渲染。
describe("Screen 推文合併：跨行連結接合", () => {
  // 內容欄右界 fieldEnd＝TIME_COL-1＝66；寫滿的一列內容 exclusive 尾端＝65。
  const FRAG = "https://i.imgur.c";
  const filler = "pic ".padEnd(65 - PREFIX_COLS - FRAG.length, " ");
  const wrapLines = [
    comment("推", ID, filler + FRAG, "08/09 15:35"),
    comment("→", ID, "om/Pn3XurX.jpeg", "08/09 15:35"),
  ];

  const renderWrap = (props) =>
    mountScreen({ lines: wrapLines, forceWidth: FORCE_WIDTH, enableLinkInlinePreview: true, enableLinkHoverPreview: false, enhance: {
          pageState: 3,
          easyReading: true,
          dropHidden: true,
          articleId: 1,
          mergeSameAuthorComments: true,
          autoFixUrl: true,
          ...props,
        } });

  test("斷成兩則的網址 → 合併塊下方出現接回去的 ↳ 修復連結", async () => {
    const { container: c } = renderWrap();
    const fixed = c.querySelector(".mergedCommentBlock .fixedUrlLine");
    expect(fixed).not.toBeNull();
    expect(fixed.textContent).toContain("https://i.imgur.com/Pn3XurX.jpeg");
    // 原文一個字都不改：兩則殘段照樣各自成行。
    const parts = blockLines(c);
    expect(parts[0]).toContain(FRAG);
    expect(parts[1].startsWith("om/Pn3XurX.jpeg")).toBe(true); // 末行仍帶原 padding＋時間戳
    await flushPreviews();
  });

  test("關掉「自動修復斷掉的連結」→ 不接（合併塊照常）", () => {
    const { container: c } = renderWrap({ autoFixUrl: false });
    expect(c.querySelector(".mergedCommentBlock")).not.toBeNull();
    expect(c.querySelector(".fixedUrlLine")).toBeNull();
  });
});

// 跨行 AID 接合的 Screen 接線（使用者 2026-08-27 回報，錄製擋
// tests/e2e/cassettes/ask-aid-wrap.json）。兩種切法各自走不同的程式路徑：
//   1. 看板後綴被切到下一則 → aid_parse.parseBoardSuffix 跨換行（不需三訊號）
//   2. AID 本體 8 碼被切成兩半 → aid_wrap.detectWrappedAids（三訊號）
// 兩者共同的失敗症狀都是「board 拿不到 ⇒ 退回目前看板 ⇒ 跳到錯的板」。
describe("Screen 推文合併：跨行 AID 接合", () => {
  const AID = "1gU3wwNZ";
  // 內容欄右界 fieldEnd＝TIME_COL-1＝66；寫滿的一列內容 exclusive 尾端＝65。
  const FULL_LEN = 65 - PREFIX_COLS;

  const renderAid = (aidLines, props) =>
    mountScreen({
      lines: aidLines,
      forceWidth: FORCE_WIDTH,
      enableLinkInlinePreview: false,
      enableLinkHoverPreview: false,
      enhance: {
        pageState: 3,
        easyReading: true,
        dropHidden: true,
        articleId: 1,
        mergeSameAuthorComments: true,
        onAidClick: () => {},
        ...props,
      },
    });

  const aidLink = (c) => c.querySelector(".mergedCommentBlock a.aidLink");

  // 使用者現場：AID 打在一則的結尾（沒寫滿，尾巴還剩空白）、看板打在下一則的開頭。
  const suffixLines = [
    comment("推", ID, "有興趣可到 #" + AID, "08/26 22:17"),
    comment("→", ID, "(Browsers) 體驗", "08/26 22:17"),
  ];

  test("看板後綴被切到下一則 → aidLink 仍帶對的看板", () => {
    const { container: c } = renderAid(suffixLines);
    const a = aidLink(c);
    expect(a).not.toBeNull();
    expect(a.getAttribute("data-aid")).toBe(AID);
    expect(a.getAttribute("data-board")).toBe("Browsers");
    // 連結文字只包 #AID 本身，看板後綴不進 <a>（欄位範圍與逐列一致）。
    expect(a.textContent).toBe("#" + AID);
  });

  test("關掉推文合併 → 沒有合併塊，看板自然拿不到（跨行接合的前提）", () => {
    const { container: c } = renderAid(suffixLines, {
      mergeSameAuthorComments: false,
    });
    expect(c.querySelector(".mergedCommentBlock")).toBeNull();
    const a = c.querySelector("a.aidLink");
    expect(a.getAttribute("data-aid")).toBe(AID);
    expect(a.getAttribute("data-board")).toBe("");
  });

  // AID 本體被輸入欄切成 6+2：左邊那則必須寫滿內容欄，兩則同一分鐘。
  // '#' 前面留一格空白——緊鄰的字若是 AID 字元，`a#...` 那條前綴規則會（正確地）擋掉。
  const splitHead = "#" + AID.slice(0, 6);
  const splitLines = [
    comment(
      "推",
      ID,
      "note".padEnd(FULL_LEN - splitHead.length - 1, "x") + " " + splitHead,
      "08/26 22:17",
    ),
    comment("→", ID, AID.slice(6) + " (Browsers) 體驗", "08/26 22:17"),
  ];

  test("AID 本體被切成兩半 → 兩個殘段都變成指向同一篇的連結", () => {
    const { container: c } = renderAid(splitLines);
    const links = c.querySelectorAll(".mergedCommentBlock a.aidLink");
    // 範圍型連結不可跨換行（LinkSegmentBuilder 在 '\n' 一律收錨），故左右殘段
    // 各自成錨；兩個都帶同一組 data-aid / data-board，點哪一半都跳同一篇。
    expect(links.length).toBe(2);
    expect(links[0].textContent).toBe("#" + AID.slice(0, 6));
    expect(links[1].textContent).toBe(AID.slice(6));
    for (const a of links) {
      expect(a.getAttribute("data-aid")).toBe(AID);
      expect(a.getAttribute("data-board")).toBe("Browsers");
    }
  });

  test("兩則時間差超過 1 分鐘 → 不接（三訊號守門）", () => {
    const lateLines = [
      splitLines[0],
      comment("→", ID, AID.slice(6) + " (Browsers) 體驗", "08/26 22:19"),
    ];
    const { container: c } = renderAid(lateLines);
    expect(c.querySelector(".mergedCommentBlock")).not.toBeNull();
    expect(aidLink(c)).toBeNull();
  });

  test("左邊那則沒寫滿內容欄 → 不接（作者只是分兩則講話）", () => {
    const shortLines = [
      comment("推", ID, "說明 " + splitHead, "08/26 22:17"),
      comment("→", ID, AID.slice(6) + " (Browsers) 體驗", "08/26 22:17"),
    ];
    const { container: c } = renderAid(shortLines);
    expect(c.querySelector(".mergedCommentBlock")).not.toBeNull();
    expect(aidLink(c)).toBeNull();
  });
});
