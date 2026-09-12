// 「按 X 要不要改開長推文輸入框」的判準。三條使用者入口（鍵盤／底列功能鍵按鈕／
// IME）與右鍵選單的顯示條件都吃這一份，本檔釘的是判準本身。
//
// 兩條最容易被改壞的規則各有一組測試：
//  - X 與 % 都要按 Shift ⇒ shiftKey 不得列入排除條件；
//  - pageState 3 會過期（term_buf.setPageState 沒有 reset 分支）⇒ 必須加驗當前這一
//    幀真的是 pmore 狀態列，否則按 s 打看板名 XBOX 的第一個字會被吞掉。
import {
  isPushKey,
  longPushAvailable,
  atPagerStatusRow,
  shouldInterceptPushKey,
  pushGateFacts,
} from "../../src/js/long_push_gate";

// 真實底列（pmore 狀態列 ＋ part3 footer），取自 aid_navigation.test.js。
const READ_ROW =
  "  瀏覽 第 1/2 頁 ( 45%)  目前顯示: 第 1~23 行  (y)回應(X%)推文(h)說明(←)離開 ";
const MAIL_ROW =
  "  瀏覽 第 1/1 頁 (100%)  目前顯示: 第 01~18 行  (y)回信 (h)說明 (←/q)離開 ";
// footer 塞不下時 part3 整段消失——仍然是文章畫面，仍然要攔。
const READ_ROW_NO_FOOTER =
  "  瀏覽 第 12345/12345 頁 (100%)  目前顯示: 第 271589~271611 行        ";
// 文章列表底列：畫得出 (X)推文，但不是 pmore 狀態列。
const LIST_ROW =
  "  文章選讀  (y)回應 (X)推文 (^Z)離開 (b)上頁 (f)下頁 (q)離開                  ";
// prompt 幀：底列被 s 的輸入列蓋掉，pageState 還停在上一幀的 3。
const PROMPT_ROW = "請輸入看板名稱(按空白鍵自動搜尋)：XBO";

const PREFS_ON = { enableLongPush: true, pushKeyOpensLongPush: true };
const base = (over) => ({
  key: "X",
  prefs: PREFS_ON,
  pageState: 3,
  lastRowText: READ_ROW,
  ...over,
});

describe("isPushKey（pttbbs more.c:90-93）", () => {
  test("X 與 % 是推文鍵", () => {
    expect(isPushKey("X")).toBe(true);
    expect(isPushKey("%")).toBe(true);
  });

  // 小寫 x 在 pager 完全沒綁定、在文章列表是 NULL、在信件列表是轉寄。攔了它就是
  // 攔到一個「原本什麼都不會發生」或語意完全不同的鍵。
  test("小寫 x 不是推文鍵", () => {
    expect(isPushKey("x")).toBe(false);
  });

  test("其他鍵與非字串都不是", () => {
    ["y", "X ", "XX", "", undefined, null].forEach((k) =>
      expect(isPushKey(k)).toBe(false)
    );
  });
});

describe("longPushAvailable（選單與攔截共用的可用性）", () => {
  test("文章畫面 → 可用", () => {
    expect(
      longPushAvailable({ prefs: PREFS_ON, pageState: 3, lastRowText: READ_ROW })
    ).toBe(true);
  });

  test("footer 整段消失（寬度不夠）仍然可用——推論只能單向", () => {
    expect(
      longPushAvailable({
        prefs: PREFS_ON,
        pageState: 3,
        lastRowText: READ_ROW_NO_FOOTER,
      })
    ).toBe(true);
  });

  test("站內信 pager（(y)回信）→ 不可用", () => {
    expect(
      longPushAvailable({ prefs: PREFS_ON, pageState: 3, lastRowText: MAIL_ROW })
    ).toBe(false);
  });

  test.each([0, 1, 2, 5, 6])("pageState %i（非文章）→ 不可用", (pageState) => {
    expect(
      longPushAvailable({ prefs: PREFS_ON, pageState, lastRowText: READ_ROW })
    ).toBe(false);
  });

  test("總開關關掉 → 不可用", () => {
    expect(
      longPushAvailable({
        prefs: { enableLongPush: false, pushKeyOpensLongPush: true },
        pageState: 3,
        lastRowText: READ_ROW,
      })
    ).toBe(false);
  });
});

describe("atPagerStatusRow（pageState 3 的新鮮度）", () => {
  test("pmore 狀態列 → true", () => {
    expect(atPagerStatusRow(READ_ROW)).toBe(true);
    expect(atPagerStatusRow(READ_ROW_NO_FOOTER)).toBe(true);
  });

  test("prompt 幀／列表底列／空字串 → false", () => {
    expect(atPagerStatusRow(PROMPT_ROW)).toBe(false);
    expect(atPagerStatusRow(LIST_ROW)).toBe(false);
    expect(atPagerStatusRow("")).toBe(false);
    expect(atPagerStatusRow(undefined)).toBe(false);
  });
});

describe("shouldInterceptPushKey", () => {
  test("文章畫面按 X／% → 攔", () => {
    expect(shouldInterceptPushKey(base())).toBe(true);
    expect(shouldInterceptPushKey(base({ key: "%" }))).toBe(true);
  });

  // X 與 % 在一般鍵盤上都要按 Shift；把 shiftKey 放進排除條件＝整個功能失效。
  test("shiftKey 按著仍然要攔", () => {
    expect(shouldInterceptPushKey(base({ shiftKey: true }))).toBe(true);
  });

  test.each(["ctrlKey", "altKey", "metaKey"])("%s 按著 → 不攔", (mod) => {
    expect(shouldInterceptPushKey(base({ [mod]: true }))).toBe(false);
  });

  test("新開關關掉 → 不攔（逃生門）", () => {
    expect(
      shouldInterceptPushKey(
        base({ prefs: { enableLongPush: true, pushKeyOpensLongPush: false } })
      )
    ).toBe(false);
  });

  // 從屬關係：總開關關掉時，新開關就算是開的也不得攔截。
  test("enableLongPush 關掉 → 不攔，即使新開關是開的", () => {
    expect(
      shouldInterceptPushKey(
        base({ prefs: { enableLongPush: false, pushKeyOpensLongPush: true } })
      )
    ).toBe(false);
  });

  // 這條擋的是「按 s 打看板名 XBOX，第一個字被吞去開輸入框」。
  test("prompt 幀（pageState 還停在陳舊的 3）→ 不攔", () => {
    expect(shouldInterceptPushKey(base({ lastRowText: PROMPT_ROW }))).toBe(false);
  });

  test("文章列表（畫得出 (X)推文，但不是 pmore 狀態列）→ 不攔", () => {
    expect(
      shouldInterceptPushKey(base({ pageState: 2, lastRowText: LIST_ROW }))
    ).toBe(false);
    // 就算 pageState 因為上一幀殘留成 3，底列不是狀態列也照樣不攔。
    expect(shouldInterceptPushKey(base({ lastRowText: LIST_ROW }))).toBe(false);
  });

  test("站內信 pager → 不攔", () => {
    expect(shouldInterceptPushKey(base({ lastRowText: MAIL_ROW }))).toBe(false);
  });

  test("非推文鍵 → 不攔", () => {
    expect(shouldInterceptPushKey(base({ key: "x" }))).toBe(false);
    expect(shouldInterceptPushKey(base({ key: "y" }))).toBe(false);
  });

  test("prefs 缺漏／空參數都不炸", () => {
    expect(shouldInterceptPushKey(base({ prefs: undefined }))).toBe(false);
    expect(shouldInterceptPushKey({})).toBe(false);
    expect(shouldInterceptPushKey(undefined)).toBe(false);
  });
});

describe("pushGateFacts", () => {
  test("讀 buf 的最後一列（不讀 DOM）", () => {
    const buf = {
      pageState: 3,
      rows: 24,
      cols: 80,
      getRowText: vi.fn(() => READ_ROW),
    };
    expect(pushGateFacts({ buf })).toEqual({
      pageState: 3,
      lastRowText: READ_ROW,
    });
    expect(buf.getRowText).toHaveBeenCalledWith(23, 0, 80);
  });

  // 假 ctx（既有測試）與尚未連線的 App 都會落在這裡：回 null ＝ 不攔截，
  // 退化結果就是原生推文，永遠不會壞事。
  test("core／buf 不完整 → null，不炸", () => {
    expect(pushGateFacts(undefined)).toBe(null);
    expect(pushGateFacts({})).toBe(null);
    expect(pushGateFacts({ buf: { pageState: 3 } })).toBe(null);
  });
});
