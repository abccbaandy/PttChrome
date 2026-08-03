// Pure-logic unit tests for src/js/string_util.js (vitest, no DOM / no network).
//
// 這批 parser 全部是「靠讀 PTT server 畫上來的文字反推狀態」的邏輯，被
// easy_reading / list_session / term_buf / term_view / aid_navigation / pttchrome
// 依賴。字串或欄位一旦與官方 pttbbs 不符 → **靜默失效**（好讀模式判定掉出、
// 水球漏抓），不會炸也不會被別的 test 抓到，所以逐條對官方 source 釘死。
//
// 對照基準：3rd_script/pttbbs @ c1ff72df（＝線上 term.ptt.cc 的 upstream 基準，
// 由系統資訊「編譯版本」的 build_origin 欄位得知，見 docs/pttbbs-screen-protocol.md
// §0）。每個 describe 標明官方出處函式名（行號會漂，函式名為準）。
//
// 素材來源：標「實錄」者取自 tests/e2e/cassettes/*.json 的真實 byte stream
// （剝掉 ANSI 後的 getRowText 形式），其餘依官方 printf 格式字串建構。

import {
  wrapText,
  normalizeCopyText,
  parseStatusRow,
  parseListRow,
  parseWaterball,
  parseReplyText,
  parsePushInitText,
  parseReqNotMetText,
  isDBCSLead,
  unescapeStr,
  b2u,
  u2b
} from "../../src/js/string_util";
import { loadBig5Tables } from "./helpers/load_big5_tables";

describe("wrapText group-width measurement", () => {
  // Regression guard for the CodeQL "incomplete string escaping" fix: the group
  // width calculation must replace ALL tabs (and CR/LF), not just the first.
  // "ab\t\t" forms one group (word + trailing tabs). Each tab is 4 columns →
  // width 2 + 8 = 10, exactly filling maxLen, so "cd" must spill to a new line.
  // Pre-fix (no `g`) only the first tab counted (width 7) → no wrap.
  it("counts every tab in a group when wrapping", () => {
    expect(wrapText("ab\t\tcd", 10, "\n")).toBe("ab\t\t\ncd");
  });

  it("does not wrap when the group still fits", () => {
    expect(wrapText("ab\tcd", 10, "\n")).toBe("ab\tcd");
  });

  // Plain ASCII below the limit is returned unchanged.
  it("leaves short ASCII untouched", () => {
    expect(wrapText("hello", 10, "\n")).toBe("hello");
  });
});

// Guards the copy pipeline (App.doCopy → navigator.clipboard.writeText):
// extracted from the pre-Clipboard-API doCopy so the exact normalization
// semantics survive the execCommand('copy') removal.
describe("normalizeCopyText", () => {
  it("converts \\r\\n and bare \\n to BBS \\r line endings", () => {
    expect(normalizeCopyText("a\r\nb\nc")).toBe("a\rb\rc");
  });

  it("strips trailing spaces before a line break", () => {
    expect(normalizeCopyText("a   \nb  \r\nc")).toBe("a\rb\rc");
  });

  it("keeps text without line breaks unchanged", () => {
    expect(normalizeCopyText("hello world")).toBe("hello world");
  });

  // ANSI copies (copyAnsi) must keep their exact byte sequence — no line-ending
  // or whitespace rewriting once an escape char is present.
  it("passes ANSI text through untouched", () => {
    const ansi = "\x1b[1;33mhi  \r\nthere\x1b[m";
    expect(normalizeCopyText(ansi)).toBe(ansi);
  });
});

// ---------------------------------------------------------------------------
// parseStatusRow — pmore 底部狀態列（＝「這頁是文章」的決定性指紋）
//
// 官方組裝處 mbbsd/pmore.c#mf_display_footer，三段拼接：
//   part1 (SUMMARY): "  瀏覽 第 %1d/%1d 頁 (%3d%%) "   allpages >= 0
//                    "  瀏覽 第 %1d 頁 (%3d%%) "        allpages <  0（單頁/未知總頁）
//                    bpref.oldstatusbar 時改印 "  瀏覽 P.%d(%d%%)  " 後直接 return
//   part2 (DETAIL):  " 目前顯示: 第 %02d~%02d 行"        mf.xpos == 0
//                    " 顯示範圍: %d~%d 欄位, %02d~%02d 行"  mf.xpos > 0（左右捲動中）
//                    override_msg 時整段被搜尋/警告訊息取代
//   part3 (HELP):    mbbsd/more.c#common_pmore_footer_handler，依剩餘寬度五選一：
//                    FOOTERMSG_MAIL_LONG  "(y)回信 (h)說明 (←/q)離開 "   currstat==RMAIL
//                    FOOTERMSG_READ_LONG  "(y)回應(X%)推文(h)說明(←)離開 "
//                    FOOTERMSG_READ_MID   "(y)回應(X/%)推文 (←)離開 "
//                    FOOTERMSG_SHORT      "(h)說明 (←/q)離開 "
//                    FOOTERMSG_VERYSHORT  "(←q)離開 "
//                    ——以及**一種都不印**（見下）
// part1 尾 1 空格 ＋ part2 首 1 空格 ⇒ 「%)」與「目前顯示」之間恰 2 空格。
//
// part3 可能整段消失，有兩層來源（2026-08 反查 efc21a30）：
//   1. mbbsd/pmore.c#mf_display_footer：part2 印完 `if (avail <= 0) return;`
//      —— 連 footer_handler 都不會被呼叫。
//   2. mbbsd/more.c#common_pmore_footer_handler:461 最後的
//      `else while (width-- > w) outc(' ');` —— 連 VERYSHORT 都塞不下時只填空白。
// ⇒ **parser 不可要求 part3 存在**。要求它的後果不是「少解析一個欄位」而是整列
//    失配 → term_buf.setPageState 判不出 pageState 3 → term_view.redraw 走 native
//    分支 → hideEasyReadingOverlays() 清空 buf.pageLines（好讀累積頁整個不見）。
// ---------------------------------------------------------------------------
describe("parseStatusRow（pmore footer, pmore.c#mf_display_footer）", () => {
  test("實錄 stock-huang：多頁 ＋ FOOTERMSG_READ_LONG", () => {
    const row =
      "  瀏覽 第 1/5 頁 (  9%)  目前顯示: 第 01~20 行  " +
      "(y)回應(X%)推文(h)說明(←)離開 ";
    expect(parseStatusRow(row)).toEqual({
      pageIndex: 1,
      pageTotal: 5,
      pagePercent: 9,
      rowIndexStart: 1,
      rowIndexEnd: 20
    });
  });

  // allpages < 0 → part1 沒有 "/總頁"。pageTotal 因此是 NaN（regex group 未命中），
  // 呼叫端（easy_reading / term_view）只用 rowIndexStart/End，故維持現狀即可，
  // 但把它釘住以免日後誤以為是 0 或 null。實錄 stock-end 第一頁。
  test("實錄 stock-end：單頁版（allpages < 0）→ pageTotal 為 NaN", () => {
    const row =
      "  瀏覽 第 1 頁 (  0%)  目前顯示: 第 01~22 行    " +
      "(y)回應(X%)推文(h)說明(←)離開 ";
    const r = parseStatusRow(row);
    expect(r).not.toBeNull();
    expect(r.pageIndex).toBe(1);
    expect(Number.isNaN(r.pageTotal)).toBe(true);
    expect(r.rowIndexStart).toBe(1);
    expect(r.rowIndexEnd).toBe(22);
  });

  // 長文的 part1+part2 撐掉可用寬度 → part3 退到 FOOTERMSG_SHORT。
  test("實錄 stock-end 板尾：FOOTERMSG_SHORT ＋ 5 位行號", () => {
    const row =
      "  瀏覽 第 540/540 頁 (100%)  目前顯示: 第 11851~11873 行    " +
      "(h)說明 (←/q)離開 ";
    expect(parseStatusRow(row)).toEqual({
      pageIndex: 540,
      pageTotal: 540,
      pagePercent: 100,
      rowIndexStart: 11851,
      rowIndexEnd: 11873
    });
  });

  test("FOOTERMSG_READ_MID（(X/%)推文、無 (h)說明）", () => {
    const row =
      "  瀏覽 第 2/6 頁 ( 19%)  目前顯示: 第 22~44 行  " +
      "(y)回應(X/%)推文 (←)離開 ";
    expect(parseStatusRow(row)).not.toBeNull();
  });

  test("FOOTERMSG_VERYSHORT（(←q)離開）", () => {
    const row = "  瀏覽 第 3/6 頁 ( 42%)  目前顯示: 第 45~67 行  (←q)離開 ";
    expect(parseStatusRow(row)).not.toBeNull();
  });

  // part3 整段不印：common_pmore_footer_handler 最後的 else 只填空白（連
  // VERYSHORT 都塞不下），或 mf_display_footer 的 `if (avail <= 0) return;`。
  // 舊 regex 強制要求「…離開 」→ 這兩種畫面被判成「不是文章」→ 好讀累積頁被清空。
  test("part3 整段不印（common_pmore_footer_handler 最後 else，只填空白）", () => {
    const row =
      "  瀏覽 第 12345/12345 頁 (100%)  目前顯示: 第 271589~271611 行        ";
    expect(parseStatusRow(row)).toEqual({
      pageIndex: 12345,
      pageTotal: 12345,
      pagePercent: 100,
      rowIndexStart: 271589,
      rowIndexEnd: 271611
    });
  });

  test("part3 整段不印 ＋ 行尾無空白（mf_display_footer 的 avail<=0 提前 return）", () => {
    const row = "  瀏覽 第 999 頁 ( 87%)  目前顯示: 第 987654~987676 行";
    const r = parseStatusRow(row);
    expect(r).not.toBeNull();
    expect(r.rowIndexStart).toBe(987654);
    expect(r.rowIndexEnd).toBe(987676);
  });

  // xpos > 0（左右捲動）的 part2 更長，更容易把 part3 擠掉。
  test("顯示範圍（xpos>0）＋ part3 不印", () => {
    const row =
      "  瀏覽 第 8/9 頁 ( 91%)  顯示範圍: 101~178 欄位, 168~190 行   ";
    expect(parseStatusRow(row)).toMatchObject({
      pageIndex: 8,
      pageTotal: 9,
      rowIndexStart: 168,
      rowIndexEnd: 190
    });
  });

  // FOOTERMSG_MAIL_LONG：currstat == RMAIL（讀信箱裡的信也是 pmore）。
  // 「(y)回信」不是「(y)回應」，舊 regex 卡在這裡 → 郵件永遠不被判為 article。
  test("FOOTERMSG_MAIL_LONG（郵件：(y)回信）", () => {
    const row =
      "  瀏覽 第 1/2 頁 ( 50%)  目前顯示: 第 01~22 行  " +
      "(y)回信 (h)說明 (←/q)離開 ";
    expect(parseStatusRow(row)).toEqual({
      pageIndex: 1,
      pageTotal: 2,
      pagePercent: 50,
      rowIndexStart: 1,
      rowIndexEnd: 22
    });
  });

  // mf.xpos > 0：使用者按 `>` / `.` 右捲長行後，part2 換成「顯示範圍」。
  // 行號仍在（第 3、4 個數字），文章身分不變 → 必須照樣解得出來，否則
  // pageState 掉出 3、好讀模式當場失效。
  test("xpos > 0：「顯示範圍: A~B 欄位, S~E 行」仍是文章列", () => {
    const row =
      "  瀏覽 第 2/5 頁 ( 21%)  顯示範圍: 3~81 欄位, 22~44 行  " +
      "(y)回應(X%)推文(h)說明(←)離開 ";
    expect(parseStatusRow(row)).toEqual({
      pageIndex: 2,
      pageTotal: 5,
      pagePercent: 21,
      rowIndexStart: 22,
      rowIndexEnd: 44
    });
  });

  // part1 的 %1d 沒有位數上限；實錄已見 540 頁，四位數只是更長的文章。
  test("四位數頁碼不得失配（%1d 無上限）", () => {
    const row =
      "  瀏覽 第 1000/1200 頁 ( 83%)  目前顯示: 第 22001~22022 行  " +
      "(h)說明 (←/q)離開 ";
    const r = parseStatusRow(row);
    expect(r).not.toBeNull();
    expect(r.pageIndex).toBe(1000);
    expect(r.pageTotal).toBe(1200);
  });

  test("非文章列 → null", () => {
    expect(parseStatusRow("")).toBeNull();
    expect(parseStatusRow("  瀏覽 第 1/5 頁 (  9%) ")).toBeNull(); // 只有 part1
    expect(
      parseStatusRow(" 文章選讀 (y)回應(X)推文(^X)轉錄 (b)進板畫面  ")
    ).toBeNull(); // 看板列表 feeter，不是文章
  });
});

// ---------------------------------------------------------------------------
// parseListRow — 選單畫面底部狀態列（term_buf.setPageState 的 MENU 指紋）
//
// 官方 mbbsd/menu.c#show_status，經 vbarf（\t 後靠右對齊）：
//   ANSI "[%d/%d 星期%c%c %d:%02d]" ANSI "%-14s" ANSI " 線上" ANSI "%d"
//   ANSI "人, 我是" ANSI "%s" ANSI "\t[呼叫器]" ANSI "%s "
// 兩個關鍵事實：
//   1. "]" 後**緊接** SHM->today_is（%-14s 左對齊），不保證有空格。
//   2. 呼叫器狀態取自 mbbsd/var.c#str_pager_modes[PAGER_MODES]，共 **5** 種：
//      關閉 / 打開 / 拔掉 / 防水 / 好友。
// ---------------------------------------------------------------------------
describe("parseListRow（主選單狀態列, menu.c#show_status）", () => {
  // vbarf 會把 \t 後的內容推到右端，這裡以固定空白模擬。
  const statusRow = (todayIs, pager, user = "someuser") =>
    `[7/26 星期日 14:30]${todayIs.padEnd(14)} 線上24683人, 我是${user}` +
    `        [呼叫器]${pager} `;

  test("關閉 / 打開", () => {
    expect(parseListRow(statusRow(" 今日主題", "關閉"))).toBe(true);
    expect(parseListRow(statusRow(" 今日主題", "打開"))).toBe(true);
  });

  // str_pager_modes 的後三種：使用者把呼叫器設成拔掉/防水/好友時，主選單
  // 一樣是主選單 —— 舊 regex 只認「關閉|打開」→ setPageState 認不出 MENU、
  // list_session.classifyListScreen 認不出 menu（離板交易的 expect 永不完成）。
  test("拔掉 / 防水 / 好友（str_pager_modes 其餘三種）", () => {
    expect(parseListRow(statusRow(" 今日主題", "拔掉"))).toBe(true);
    expect(parseListRow(statusRow(" 今日主題", "防水"))).toBe(true);
    expect(parseListRow(statusRow(" 今日主題", "好友"))).toBe(true);
  });

  // "]" 後是 %-14s 的第一個字元，today_is 首字非空白時舊 regex 的 "\] " 失配。
  test("today_is 緊接「]」無空格（%-14s 左對齊）", () => {
    expect(parseListRow(statusRow("今日主題就是這個", "關閉"))).toBe(true);
  });

  test("today_is 為空（%-14s 補滿空白）", () => {
    expect(parseListRow(statusRow("", "關閉"))).toBe(true);
  });

  // 時 %d 不補零、分 %02d 補零；月/日皆不補零。
  test("個位數時間（%d:%02d，時不補零）", () => {
    expect(
      parseListRow("[1/2 星期一 9:05]              線上100人, 我是ab  [呼叫器]關閉 ")
    ).toBe(true);
  });

  test("看板文章列表 feeter 不得誤判為選單", () => {
    expect(
      parseListRow(
        " 文章選讀 (y)回應(X)推文(^X)轉錄 (=[]<>)相關主題(/?a)找標題/作者 (b)進板畫面  "
      )
    ).toBe(false);
  });

  test("空字串 / 文章狀態列 → false", () => {
    expect(parseListRow("")).toBe(false);
    expect(
      parseListRow("  瀏覽 第 1/5 頁 (  9%)  目前顯示: 第 01~20 行  (←q)離開 ")
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseWaterball — 水球/廣播（pttchrome.jsx 直接吃 b2u(原始 WS bytes)，不是
// 渲染後的畫面，所以比對的是 server wire 上的真實 byte 序列）
//
// 官方 mbbsd/mbbsd.c#show_call_in → mbbsd/kaede.c#outmsg：
//   一般：ANSI_COLOR(1;33;46) "★%s" ANSI_COLOR(37;45) " %s " ANSI_RESET
//   PLAY_ANGEL(MSGMODE_TOANGEL)：ANSI_COLOR(1;37;46) "★%s" …（同結構）
// include/ansi.h：ANSI_COLOR(x) = ESC "[" x "m"、ANSI_RESET = ESC "[m"。
// 但 wire 上的 ANSI **不是 source 字面**：PTT 用 pfterm，由 pfterm.c#fterm_chattr
// 重新產生最短序列 ESC "[" [0;] [1;] [5;] [3fg;] [4bg] "m"，所以 upstream 的
// "37;45" 在線上呈現為 "0;1;37;45"（fg 回到預設 7 觸發 reset ＋
// FTCONF_WORKAROUND_BOLD 補印 37）。兩種都要能解。
// 尾端的 ESC "[K"（清到行尾）只有新訊息比上一則短時才會送 ⇒ 不可強制要求。
// ---------------------------------------------------------------------------
describe("parseWaterball（show_call_in / outmsg）", () => {
  test("官方字面序列（ANSI_COLOR(37;45)、無尾隨 [K）", () => {
    const wire = "\x1b[1;33;46m★someuser\x1b[37;45m 你好嗎 \x1b[m";
    expect(parseWaterball(wire)).toEqual({
      userId: "someuser",
      message: "你好嗎"
    });
  });

  test("帶 [K（doupdate o_cleol：新訊息比前一則短）", () => {
    const wire = "\x1b[1;33;46m★someuser\x1b[37;45m 嗨 \x1b[m\x1b[K";
    expect(parseWaterball(wire)).toEqual({ userId: "someuser", message: "嗨" });
  });

  // 線上實際觀察到的變體（PttChrome 原作從 term.ptt.cc 流量歸納；PTT 跑的是
  // 私有 commit 50372909，顏色前綴與 upstream 字面不同）。兩者都要吃。
  test("線上觀察變體（[0;1;37;45m）", () => {
    const wire = "\x1b[1;33;46m★someuser\x1b[0;1;37;45m 你好嗎 \x1b[m\x1b[K";
    expect(parseWaterball(wire)).toEqual({
      userId: "someuser",
      message: "你好嗎"
    });
  });

  test("PLAY_ANGEL 小天使變體（[1;37;46m 開頭）", () => {
    const wire = "\x1b[1;37;46m★angelid\x1b[37;45m 神諭 \x1b[m";
    expect(parseWaterball(wire)).toEqual({ userId: "angelid", message: "神諭" });
  });

  // 廣播/系統訊息 fallback：doupdate 的 rel_move 先定位到第 24 列再上色。
  test("底列廣播 fallback（ESC[24;NNH ESC[1;37;45m …）", () => {
    const wire = "\x1b[24;12H\x1b[1;37;45m系統廣播訊息\x1b[m";
    expect(parseWaterball(wire)).toEqual({ message: "系統廣播訊息" });
  });

  test("一般畫面更新 → null", () => {
    expect(parseWaterball("\x1b[H\x1b[2J\x1b[1;33m一般內容\x1b[m")).toBeNull();
    expect(parseWaterball("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// easy_reading 的 prompt 指紋（好讀模式要在這些畫面讓位給原生）
// 官方出處：
//   mbbsd/bbs.c#reply_post — 三種互斥 prompt（權限決定走哪一種）
//   mbbsd/more.c           — "把這篇文章收入到暫存檔？[y/N] "
//   mbbsd/edit.c           — "請選擇暫存檔 (0-9)[0]: "
//   mbbsd/bbs.c#recommend  — outs(ANSI_COLOR(1) "您覺得這篇文章 ")
// ---------------------------------------------------------------------------
describe("parseReplyText（bbs.c#reply_post 的三種 prompt）", () => {
  test("有寄信權限：(F)看板 (M)作者信箱 (B)二者皆是", () => {
    expect(
      parseReplyText("▲ 回應至 (F)看板 (M)作者信箱 (B)二者皆是 (Q)取消？[F] ")
    ).toBe(true);
  });

  // !HasSendMailUserPerm() 分支 —— 沒有這條時，無寄信權限的使用者按 y
  // 回應，好讀模式不會讓位。
  test("無寄信權限：(F)看板 (Q)取消", () => {
    expect(parseReplyText("▲ 回應至 (F)看板 (Q)取消？[F] ")).toBe(true);
  });

  test("不可回應至看板：改回應至 (M)作者信箱", () => {
    expect(
      parseReplyText("▲ 無法回應至看板。 改回應至 (M)作者信箱 (Q)取消？[Q] ")
    ).toBe(true);
  });

  test("暫存檔 prompt（more.c / edit.c）", () => {
    expect(parseReplyText("把這篇文章收入到暫存檔？[y/N] ")).toBe(true);
    expect(parseReplyText("請選擇暫存檔 (0-9)[0]: ")).toBe(true);
  });

  test("一般內容 → false", () => {
    expect(parseReplyText("推 someuser: 這篇不錯                 07/26 14:30")).toBe(
      false
    );
    expect(parseReplyText("")).toBe(false);
  });
});

describe("parsePushInitText（bbs.c#recommend 的推文輸入列）", () => {
  test("推文類型選單（您覺得這篇文章 …）", () => {
    expect(parsePushInitText("您覺得這篇文章 值得推薦 給它噓聲 只加→註解 [1]? ")).toBe(
      true
    );
  });

  // FormatCommentString 的輸入 prompt：「→ id:」但**還沒有**行尾時間戳
  // （tail 是送出後才接上的）。
  test("輸入 prompt「→ id: 」（無時間戳）", () => {
    expect(parsePushInitText("→ someuser: ")).toBe(true);
  });

  // 已完成的 → 推文帶行尾 MM/DD HH:MM，不是輸入列 —— 否則好讀模式會把
  // 第一則箭頭推文誤當輸入列而漏掉它。
  test("已完成的箭頭推文（有時間戳）→ false", () => {
    expect(
      parsePushInitText("→ someuser: 已經送出的推文                07/26 14:30")
    ).toBe(false);
  });

  test("本板不開放回覆 prompt", () => {
    expect(
      parsePushInitText(
        "很抱歉, 本板不開放回覆文章，要改回信給作者嗎？ [y/N]:"
      )
    ).toBe(true);
  });

  test("一般內容 → false", () => {
    expect(parsePushInitText("推 someuser: 內容                    07/26 14:30")).toBe(
      false
    );
  });
});

// mbbsd/bbs.c 三處 vmsgf("未達看板發文限制: %s", …)，經 vtuikit.c#vshowmsg
// 加上 " ◆ " 前綴印在底列。
describe("parseReqNotMetText（未達看板發文限制）", () => {
  test("vmsg 前綴 ◆ ＋ 訊息", () => {
    expect(parseReqNotMetText(" ◆ 未達看板發文限制: 需要 5 篇文章")).toBe(true);
  });

  test("其他底列訊息 → false", () => {
    expect(parseReqNotMetText("◆ 未達看板發文限制: 少了開頭空格")).toBe(false);
    expect(parseReqNotMetText("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Big5 <-> Unicode（src/conv/*.bin 查表；PTT 全站 Big5，見 CLAUDE.md）
// ---------------------------------------------------------------------------
describe("b2u / u2b（Big5 轉碼）", () => {
  beforeAll(() => {
    loadBig5Tables();
  });

  test("ASCII 原樣通過", () => {
    expect(b2u("hello")).toBe("hello");
    expect(u2b("hello")).toBe("hello");
  });

  test("常見 PTT 符號 round-trip", () => {
    // 推文型別記號（bbs.c#recommend 的 ctype[]）與列表 mark。
    for (const s of ["推", "噓", "→", "★", "□", "◆", "※", "《》"]) {
      expect(b2u(u2b(s))).toBe(s);
    }
  });

  test("混合中英文 round-trip", () => {
    const s = "推 someuser: 好文推推 07/26";
    expect(b2u(u2b(s))).toBe(s);
  });

  // Big5 收了日文假名、希臘/俄文字母，所以要挑真的沒有的（U+0100 拉丁擴充 A）。
  test("非 Big5 字元 → u2b 產出 \\xFF\\xFD", () => {
    expect(u2b("Ā")).toBe("\xFF\xFD");
  });

  // b2u 收到落單的 lead byte（跨封包切斷的最後一 byte）不得吞掉或丟例外。
  test("結尾落單 byte 原樣保留", () => {
    expect(b2u("ab\xA1")).toBe("ab\xA1");
  });
});

// DBCS lead byte 範圍。Big5 lead 是 0x81-0xFE；screen.c#outc 另把 0x00/0xFF
// 視為無效（不進虛擬螢幕）。
describe("isDBCSLead", () => {
  test("0x81 / 0xFE 是 lead", () => {
    expect(isDBCSLead("\x81")).toBe(true);
    expect(isDBCSLead("\xFE")).toBe(true);
    expect(isDBCSLead("\xA1")).toBe(true);
  });

  test("0x80 / 0xFF / ASCII 不是 lead", () => {
    expect(isDBCSLead("\x80")).toBe(false);
    expect(isDBCSLead("\xFF")).toBe(false);
    expect(isDBCSLead("A")).toBe(false);
    expect(isDBCSLead(" ")).toBe(false);
  });
});

// 使用者自訂快捷鍵/巨集的 caret notation（^C、^[ …）→ 實際控制碼。
describe("unescapeStr（caret notation）", () => {
  test("^A..^_ → 對應控制碼", () => {
    expect(unescapeStr("^A")).toBe("\x01");
    expect(unescapeStr("^[")).toBe("\x1b");
    expect(unescapeStr("^@")).toBe("\x00");
    expect(unescapeStr("^_")).toBe("\x1f");
  });

  test("^? → DEL", () => {
    expect(unescapeStr("^?")).toBe("\x7f");
  });

  test("\\\\ 與 \\^ 逸出", () => {
    expect(unescapeStr("\\\\x")).toBe("\\x");
    expect(unescapeStr("\\^x")).toBe("^x");
  });

  test("無法辨識的 ^ 後綴保留為字面 ^", () => {
    expect(unescapeStr("^ x")).toBe("^ x");
  });

  test("一般文字原樣通過", () => {
    expect(unescapeStr("abc")).toBe("abc");
  });
});
