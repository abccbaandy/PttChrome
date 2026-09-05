// 「點空白處關框」的判斷守護（純函式，零 DOM）。
//
// 素材依據（pttbbs 原始碼，非畫面反推）：
//   include/vtuikit.h:39-42  VMSG_PAUSE " 請按任意鍵繼續 " / VMSG_PAUSE_PAD "▄"
//                            VMSG_MSG_PREFIX " ◆ " / VMSG_MSG_FLOAT " [按任意鍵繼續]"
//   mbbsd/vtuikit.c:328,439  vshowmsg 一律 move(b_lines,0) ⇒ 只看**最後一列**
//   mbbsd/vtuikit.c:445      `do { i = vkey(); } while (i == 0);` ⇒ 任何真按鍵都收得掉
//   mbbsd/vtuikit.c:1346     vgetstring 的 Ctrl-C ⇒ 清空 ＋ abort ＝ 取消
//   mbbsd/io.c:228-247       system_key_hook 吃掉 Ctrl-L ⇒ **不可以**拿它關框
//
// 最重要的是**負向**那幾條：沒有框時一定要回 null。沒有「安全鍵」可送 ——
// Ctrl-C 在文章列表會清標記清單（read.c:950），空白鍵在文章裡是翻頁。
import {
  DISMISS_ANY_KEY,
  DISMISS_INPUT,
  KEY_ABORT,
  KEY_DISMISS,
  dismissClickAllowed,
  resolveDismiss,
} from "../../src/js/screen_dismiss";

// vshowmsg(NULL) 那一列：`▄` 填滿、正中央是 VMSG_PAUSE。
const PAUSE_ROW = "▄".repeat(32) + " 請按任意鍵繼續 " + "▄".repeat(32);
// vmsg("…") 橫幅：" ◆ " ＋訊息，右靠 " [按任意鍵繼續]"。
const VMSG_ROW = " ◆ 抱歉, 禁止推薦" + " ".repeat(40) + " [按任意鍵繼續]";
// 一般的文章狀態列（pmore footer）與文章列表 footer —— 都**不是**框。
const ARTICLE_FOOTER =
  "  瀏覽 第 1/3 頁 ( 33%)  目前顯示: 第 01~22 行  (h)按鍵說明  (←/q)離開 ";
const LIST_FOOTER =
  " 文章選讀  (y)回應(X)推文(^X)轉錄 (=[]<>)相關主題 (/?a)找標題/作者 (b)進板畫面";

describe("resolveDismiss：這一幀有沒有滑鼠關得掉的框", () => {
  test("pressanykey（▄ ＋ 請按任意鍵繼續）→ 送空白鍵", () => {
    expect(resolveDismiss({ lastRowText: PAUSE_ROW })).toEqual({
      kind: DISMISS_ANY_KEY,
      bytes: KEY_DISMISS,
    });
    expect(KEY_DISMISS).toBe(" ");
  });

  test("vmsg 橫幅（ ◆ … [按任意鍵繼續]）→ 送空白鍵", () => {
    expect(resolveDismiss({ lastRowText: VMSG_ROW })).toEqual({
      kind: DISMISS_ANY_KEY,
      bytes: KEY_DISMISS,
    });
  });

  test("fork 沿用的 Maple 寫法「請按 空白鍵 繼續」同樣認得", () => {
    // term_buf.setPageState 從 PttChrome 時代就同時認這一句。
    const row = "▄".repeat(30) + " 請按 空白鍵 繼續 " + "▄".repeat(30);
    expect(resolveDismiss({ lastRowText: row }).kind).toBe(DISMISS_ANY_KEY);
  });

  test("vgetstring 輸入欄 → 送 Ctrl-C（且**優先於**訊息列的判斷）", () => {
    expect(
      resolveDismiss({ lastRowText: "", cursorOnInputField: true }),
    ).toEqual({ kind: DISMISS_INPUT, bytes: KEY_ABORT });
    expect(KEY_ABORT).toBe("\x03");
    // vans/getdata 的提示與訊息列長得像，但游標在不在反白欄裡是確定的。
    // 送錯的代價：Ctrl-C 對輸入欄是取消，對別的畫面可能是清標記清單。
    expect(
      resolveDismiss({ lastRowText: VMSG_ROW, cursorOnInputField: true }).kind,
    ).toBe(DISMISS_INPUT);
  });

  test("NEGATIVE：沒有框時一律 null（沒有「安全鍵」可送）", () => {
    expect(resolveDismiss({ lastRowText: ARTICLE_FOOTER })).toBeNull();
    expect(resolveDismiss({ lastRowText: LIST_FOOTER })).toBeNull();
    expect(resolveDismiss({ lastRowText: "" })).toBeNull();
    expect(resolveDismiss({})).toBeNull();
    expect(resolveDismiss()).toBeNull();
  });

  test("REGRESSION：pageState 5 的第二來源（isUnicolor 啟發式）不得被當成框", () => {
    // term_buf.setPageState 還有一條「最後一列 28..53 欄同底色 ＋ 游標停在右下角」
    // 的啟發式也會判成 PASS，但那種畫面**不保證**在等按鍵。resolveDismiss 只認
    // 文字指紋，所以整列色塊（無任何訊息）必須回 null —— 這正是「不可以用
    // pageState === 5 當判準」的落點。
    expect(resolveDismiss({ lastRowText: " ".repeat(80) })).toBeNull();
    expect(resolveDismiss({ lastRowText: "█".repeat(80) })).toBeNull();
  });

  test("NEGATIVE：內文提到「按任意鍵」但不是 vmsg 格式 ⇒ 不是框", () => {
    // parseVmsgText 要求 ◆ 之前只有空白；這一列是推文，前面有型別符與 id。
    expect(
      resolveDismiss({ lastRowText: "推 someone: 這裡有個 ◆ 符號   09/05 10:00" }),
    ).toBeNull();
  });
});

describe("dismissClickAllowed：游標所在那一列不算空白處（D2）", () => {
  test("REGRESSION：點在游標列一個 byte 都不送", () => {
    // 輸入欄開著時那一列是使用者正在打的字；pressanykey 的橫幅也在那一列。
    expect(dismissClickAllowed({ clickRow: 23, cursorRow: 23 })).toBe(false);
    expect(dismissClickAllowed({ clickRow: 0, cursorRow: 0 })).toBe(false);
  });

  test("其餘每一列都算空白處", () => {
    expect(dismissClickAllowed({ clickRow: 10, cursorRow: 23 })).toBe(true);
    expect(dismissClickAllowed({ clickRow: 0, cursorRow: 23 })).toBe(true);
    expect(dismissClickAllowed({ clickRow: 22, cursorRow: 23 })).toBe(true);
  });
});
