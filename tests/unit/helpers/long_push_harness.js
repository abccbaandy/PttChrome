// 長推文狀態機的共用 harness（真 CommandQueue ＋ 假 buf/view）。
//
// 兩個消費者：long_push_flow.test.js（送出序列）與 long_push_preflight.test.js
// （探路）。**不要在任一邊複製第二份**——兩支測的是同一台狀態機的前後半段，
// 畫面常數一分歧就會出現「一邊綠一邊紅、但兩邊的 PTT 畫面其實不一樣」。

import { CommandQueue } from "../../../src/js/command_queue";
import { LongPushSession } from "../../../src/js/long_push_session";
import { pageArticleNums } from "../../../src/js/comment_parse";

// facts.rowTexts.join 的分隔字元（測試裡拿來湊 Q 的資訊框判準）。
export const BAR = "|";

export const ROWS = 24;
export const PROMPT = "推 testuser: ";
export const ARROW_PROMPT = "→ testuser: ";
export const TYPE_MENU = "您覺得這篇文章 1.值得推薦 2.給它噓聲 3.只加→註解 [1]? ";
export const CONFIRM = "推 testuser: 內容                        確定[y/N]:";
export const ARTICLE_FOOTER =
  "  瀏覽 第 1/2 頁 ( 50%)  目前顯示: 第 01~23 行  (y)回應(X%)推文(h)說明(←)離開 ";
export const vmsg = (msg) => " ◆ " + msg + "          [按任意鍵繼續]";
export const LIST_FOOTER = " 文章選讀  (y)回應(X)推文(^X)轉錄 ";
export const AID = "1_abcDEF";
// 長推文綁定的那一篇，文章標頭與列表列都用它。
export const ANCHOR_AUTHOR = "abcUser";
export const ANCHOR_TITLE = "[閒聊] 原本那篇";
export const ARTICLE_HEAD = [
  "作者  " + ANCHOR_AUTHOR + " (安安) 看板 Test",
  "標題  " + ANCHOR_TITLE,
  "時間  Mon Sep  1 12:00:00 2026",
];

// 依 bbs.c#readdoent 的 printf 序列排版（欄位表見 comment_parse.js）：
//   0-6 %7d 序號 | 7 空格 | 8 型別 | 9-10 推文數 | 11-16 %-6.5s 日期
//   17-29 %-13.12s 作者 | 30- mark + 標題
export function listRow(num, author, title, cursor) {
  const seq = cursor ? ">" + String(num).padStart(6) : String(num).padStart(7);
  return (
    seq + "    " + " 9/01 " + author.padEnd(13).slice(0, 13) + "□" + title
  );
}
export const ANCHOR_ROW = (num, cursor) =>
  listRow(num, ANCHOR_AUTHOR, ANCHOR_TITLE, cursor);
// 置底列：readdoent 在序號欄印 `"  " ANSI "  ★ "` 而不是 %7d（bbs.c:843）。★ 是
// 全形，rowToText 收成一個字 ⇒ 7 cells 只剩 6 字（realignListColumns 會補回來）。
// 新版游標 '>' 只蓋 col 0，★ 仍在。
export const PINNED_ANCHOR_ROW = (cursor) =>
  (cursor ? ">   ★ " : "    ★ ") +
  listRow(0, ANCHOR_AUTHOR, ANCHOR_TITLE, false).slice(7);
export const OTHER_ROW = (num, cursor) =>
  listRow(num, "someoneElse", "[公告] 剛剛才貼的新文", cursor);

export function harness(opts) {
  const o = opts || {};
  const sent = [];
  const copied = [];
  const hints = [];
  const queue = new CommandQueue({ send: (d) => sent.push(d) });
  let rowTexts = new Array(ROWS).fill("");
  // start() 在「還在文章裡」的時候讀標頭當錨點基準（long_push_anchor 檔頭：
  // 落地幀已經是 i_read 重讀 headers 之後的畫面，不能當基準）。
  (o.articleRows === undefined ? ARTICLE_HEAD : o.articleRows).forEach(
    (t, i) => (rowTexts[i] = t),
  );
  const termBuf = {
    rows: ROWS,
    cols: 80,
    pageState: o.pageState === undefined ? 3 : o.pageState,
    getRowText: (r) => rowTexts[r] || "",
  };
  const view = { flashListHint: (m) => hints.push(m) };
  const restored = [];
  // aidNavigation 的合約見 aid_navigation.js#resolvePostAid：免費路徑
  // （findLocalPostAid）命中就 boxOpen=false，否則按 Q 並以 boxOpen=true 回報。
  // localAid: undefined = 命中；null = 落空要按 Q。
  const localAid =
    o.localAid === undefined ? { aid: AID, board: "Test" } : o.localAid;
  const aidNavigation = {
    resolvePostAid(handlers) {
      if (localAid) {
        handlers.onDone(localAid, { boxOpen: false });
        return;
      }
      queue.enqueue({
        keys: "Q",
        kind: handlers.kind,
        fullRepaint: false,
        probe: false,
        timeoutMs: 2500,
        onFlushed: handlers.onFlushed,
        expect: (snap, facts) =>
          /文章代碼|按任意鍵/.test(facts.rowTexts.join(BAR))
            ? { info: o.qAid === undefined ? { aid: AID, board: "Test" } : o.qAid }
            : false,
        onDone: (r) => handlers.onDone(r.info, { boxOpen: true }),
        onFail: (reason) => handlers.onFail(reason),
      });
    },
  };
  const core = {
    doCopy: (s) => copied.push(s),
    easyReading: {
      _enterFunctionMode() {},
      requestScrollRestore: (i) => restored.push(i),
    },
    listSession: { beginExternalNavigation() {} },
    aidNavigation: o.aidNavigation === undefined ? aidNavigation : o.aidNavigation,
  };
  const session = new LongPushSession(core, view, termBuf, queue);
  // 失敗／取消的終局。**剩餘內容走這裡，不再自動進剪貼簿**（copied 留著就是為了
  // 反向斷言 doCopy 沒有被呼叫）。
  const results = [];
  session.onResult = (r) => results.push(r);
  // 一幀 server 回應：只填底列（其餘留白），再餵給 queue.onSettle —— 與
  // list_session._onScreenSettled 的驅動方式相同。
  const settle = (lastRow, over) => {
    rowTexts = new Array(ROWS).fill("");
    rowTexts[ROWS - 1] = lastRow;
    if (over && over.rows)
      for (const k of Object.keys(over.rows)) rowTexts[k] = over.rows[k];
    queue.onSettle(
      {},
      { rowTexts, rows: ROWS, kind: (over && over.kind) || "article" },
    );
  };
  // 一幀**文章列表**畫面。rows 從第 3 列開始鋪，cursorRow 是其中第幾列（0-based）。
  // facts 的欄位與 list_session._collectFacts 一致。
  const settleList = (rows, cursorRow) => {
    rowTexts = new Array(ROWS).fill("");
    rowTexts[0] = "【看板 Test】";
    rowTexts[2] = "  編號    日 期 作  者       文  章  標  題";
    rows.forEach((t, i) => (rowTexts[3 + i] = t));
    rowTexts[ROWS - 1] = LIST_FOOTER;
    const curY = 3 + cursorRow;
    const nums = pageArticleNums(rowTexts, curY);
    queue.onSettle(
      {},
      {
        rowTexts,
        rows: ROWS,
        curX: 0,
        curY,
        kind: "clean-list",
        boardName: "Test",
        nums,
        cursorRowNum: nums[curY] == null ? null : nums[curY],
      },
    );
  };

  return {
    session,
    sent,
    copied,
    hints,
    results,
    settle,
    settleList,
    queue,
    restored,
  };
}

