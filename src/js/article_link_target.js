// 右鍵選單要回答一個問題：游標下這個 <a> 指向某一篇 PTT 文章嗎？
//
// 兩種來源，兩種都要認得：
//   1. 好讀模式的文章代碼連結（Row/LinkSegmentBuilder 畫的 class="aidLink"）。
//      它的 href 是**佔位用的 "#"**（導航靠 onClick + preventDefault），真正的
//      aid/board 掛在 data-aid / data-board 上。
//   2. 文章內文裡真正的 ptt.cc 文章網址（TermBuf.uriRegEx 標出來的一般連結）。
//
// 抽成純函式（吃 anchor-like：只用到 classList.contains 與 getAttribute），
// ContextMenu 只負責把 DOM 節點餵進來 ⇒ 判斷邏輯可以在 unit test 裡驗完。

import { parseArticleUrl, isAidc, BOARD_RE } from "./aid_codec";

export const AID_LINK_CLASS = "aidLink";

function attr(anchor, name) {
  return anchor.getAttribute ? anchor.getAttribute(name) : null;
}

// 「這個 <a> 的 href 只是佔位符」。右鍵選單必須據此**排除**它：
// 不排除的話 contextOnUrl 會拿到一個 "#"，於是
//   - 「複製連結網址」複製到一個孤零零的 '#'；
//   - urlEnabled 變 true ⇒ 整組 normalEnabled 項目（含「複製本篇文章連結」）
//     全部消失。
export function isAidLinkAnchor(anchor) {
  return !!(
    anchor &&
    anchor.classList &&
    anchor.classList.contains &&
    anchor.classList.contains(AID_LINK_CLASS)
  );
}

// anchor + 遞補看板 → { board, aid } | null。
//
// fallbackBoard 是「目前文章所在的看板」（term_view._articleBoard）：畫面上的
// #AID 常常沒寫看板，pttchrome.jsx 的點擊路徑也是用同一套遞補。沒有看板就回
// null —— PTT 的 # 搜尋只搜 currboard，組不出能用的連結。
export function articleTargetFromAnchor(anchor, fallbackBoard) {
  if (!anchor) return null;
  if (isAidLinkAnchor(anchor)) {
    const aid = attr(anchor, "data-aid");
    if (!isAidc(aid)) return null;
    const board = attr(anchor, "data-board") || fallbackBoard;
    return typeof board === "string" && BOARD_RE.test(board)
      ? { board: board, aid: aid }
      : null;
  }
  return parseArticleUrl(attr(anchor, "href"));
}

// PTT 站上的慣用寫法（bbs.c#view_postinfo 印的也是這個形狀）：貼回 PTT 或貼進
// 本站的文章裡都認得，而且帶著看板 ⇒ 換個板貼也找得到。
export function formatArticleCode(target) {
  if (!target || !target.aid) return null;
  return "#" + target.aid + (target.board ? " (" + target.board + ")" : "");
}
