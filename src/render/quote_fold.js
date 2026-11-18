// 好讀文章把長引言收起來（P106，標註在 js/quote_collapse.js）的畫法。
//
// 收起的列**還在 DOM**：每一列各自包一層 `div.quoteFold[hidden="until-found"]`（不跨列包：
// 渲染鏈是一列一個節點，dirty-row patch 與分塊都靠它）。until-found 是瀏覽器原生的「找得到才打開」：
//   - 桌機 Ctrl+F 命中收起的字 ⇒ 瀏覽器自己拿掉 hidden、捲過去、發 beforematch ⇒ 我們把整段記成展開
//     （延到下一個 task 才重畫，讓瀏覽器先捲完）。不自己做找字（CLAUDE.md：原生行為接入、不模擬）。
//   - 手機找字（article_find.js）命中 ⇒ revealQuoteFold 走同一條路。
//   - 複製：Selection.toString 不含 content-visibility:hidden 的字 ⇒ screen_chunk.readSelectionText 讀之前
//     用 unfoldSelection 暫時打開選取範圍碰到的收起列、讀完放回（同一個 task，畫面不會閃），接著把那幾段
//     整段展開（提案：選取命中收起的行一律整段展開）。系統自己的複製（Android 選字選單、瀏覽器選單的
//     「複製」）不經過 readSelectionText ⇒ copy 事件裡碰到收起段時改寫剪貼簿內容（installQuoteCopy）。
// 收起段第 2 行下面畫一顆「▸ 展開引言（還有 N 行）」（不是 bbsrow：不帶 type／srow／data-row ⇒
// 選取複製、閱讀紀錄、版面量測這些找 bbsrow 的消費端直接略過它，同推文篩選的細線）。
import { el } from "./dom";
import { i18n } from "../js/i18n";

export const QUOTE_FOLD_SELECTOR = '.quoteFold[hidden="until-found"]';

// 收起的一列：inner＝照常畫出來的那一列。onExpand(key, fold) 由 beforematch／手機找字／複製觸發。
export function buildQuoteFold(inner, key, onExpand) {
  const wrap = el("div", { class: "quoteFold" }, inner);
  wrap.setAttribute("hidden", "until-found");
  wrap.__quoteKey = key;
  wrap.__onReveal = () => {
    if (!onExpand || typeof key !== "string") return;
    // 讓瀏覽器先把命中處捲到畫面上，再整段展開重畫（傳 fold 本身：展開時用它那一列當捲動錨點；
    // 換了文章它已經不在畫面上 ⇒ term_view.expandQuote 不理）。
    setTimeout(() => onExpand(key, wrap), 0);
  };
  wrap.addEventListener("beforematch", wrap.__onReveal);
  return wrap;
}

// 收起段露出來的最後一行（第 2 行）＋下面的「展開引言」鈕。row 給 term_view 展開後把位置放回。
export function buildQuoteSkipHead(inner, row, count, key, onExpand) {
  const btn = el(
    "button",
    {
      // 不寫 type="button"：消費端用 [type] 認 bbsrow（同 commentFilterSkip）。
      tabindex: "-1",
      class: "quoteSkip",
      "data-quote-skip": row,
      "aria-expanded": "false",
    },
    String(i18n("quoteCollapse_expand") || "").replace("{n}", String(count)),
  );
  btn.__quoteKey = key;
  if (onExpand && typeof key === "string") {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      onExpand(key, btn);
    });
  }
  const wrap = el("div", { class: "quoteSkipHead" }, inner ? [inner, btn] : [btn]);
  wrap.__quoteRow = row;
  return wrap;
}

// 這個元素在收起的引言裡 ⇒ 打開那一列並整段展開（手機找字用；同瀏覽器 until-found 的行為）。
export function revealQuoteFold(node) {
  const fold = node && node.closest ? node.closest(QUOTE_FOLD_SELECTOR) : null;
  if (!fold) return false;
  fold.removeAttribute("hidden");
  if (fold.__onReveal) fold.__onReveal();
  return true;
}

// 讀選取文字前：選取碰到的收起列暫時打開。回傳放回去的函式（一定要在同一個 task 裡呼叫）。
export function unfoldSelection(sel, root) {
  const opened = [];
  if (!sel || !sel.rangeCount || sel.isCollapsed || !root || !root.querySelectorAll) return () => {};
  const folds = root.querySelectorAll(QUOTE_FOLD_SELECTOR);
  for (let i = 0; i < folds.length; ++i) {
    if (sel.containsNode(folds[i], true)) {
      folds[i].removeAttribute("hidden");
      opened.push(folds[i]);
    }
  }
  return () => {
    for (const f of opened) f.setAttribute("hidden", "until-found");
    // 選取碰到的收起段整段展開（下一個 task，同找字）。
    for (const f of opened) if (f.__onReveal) f.__onReveal();
  };
}

// 系統的複製（copy 事件）：選取碰到收起段 ⇒ 用打開後的文字寫進剪貼簿；沒碰到就完全不管（照原生）。
export function quoteCopyText(sel, root) {
  if (!sel || sel.isCollapsed || !root || !root.querySelectorAll) return null;
  const folds = root.querySelectorAll(QUOTE_FOLD_SELECTOR);
  let touched = false;
  for (let i = 0; i < folds.length && !touched; ++i) touched = sel.containsNode(folds[i], true);
  if (!touched) return null;
  const restore = unfoldSelection(sel, root);
  try {
    return sel.toString();
  } finally {
    restore();
  }
}

let copyInstalled = false;
export function installQuoteCopy(doc) {
  if (copyInstalled || !doc || typeof doc.addEventListener !== "function") return;
  copyInstalled = true;
  doc.addEventListener("copy", (e) => {
    if (e.defaultPrevented || !e.clipboardData) return;
    const text = quoteCopyText(doc.getSelection && doc.getSelection(), doc.getElementById("mainContainer"));
    if (text == null) return;
    e.clipboardData.setData("text/plain", text.replace(/\u00a0/g, " "));
    e.preventDefault();
  });
}
