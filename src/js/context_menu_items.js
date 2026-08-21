// 右鍵選單的可測邏輯：三個顯示旗標，以及「每個複製選項按下去實際會複製什麼」。
//
// 抽成純函式模組的兩個理由：
//   1. 旗標曾經算錯過（見 menuTargetFlags 的註解），而那個 bug 在 React 元件裡
//      驗不到 —— 元件只是照旗標畫。
//   2. 選單要顯示「複製預覽」。預覽與真正寫進剪貼簿的字串**必須同源**，不然使用者
//      看到 A、複製到 B。所以 COPY_TEXT 同時被 index.jsx 的 handler 與預覽消費。

import { formatArticleCode } from "./article_link_target";
import { buildDeepLink } from "./deep_link";

// 右鍵當下要畫哪一組選項。
//
// selEnabled 的定義是「**真的有選取文字**」，不是 normalEnabled 的補集。
// 舊寫法 `selEnabled = !normalEnabled` 在「游標停在連結上、且沒有選取」時
// （urlEnabled=true ⇒ normalEnabled=false）會算出 selEnabled=true ⇒ 畫出
// 「複製」「複製 (包含 ANSI 顏色)」，但 selectedText 是空字串 ⇒ 點了什麼都沒發生。
// 那個情境要的是「複製連結網址」，本來就另外有一項。
export function menuTargetFlags({ contextOnUrl, selectionCollapsed }) {
  const urlEnabled = !!contextOnUrl;
  return {
    urlEnabled,
    normalEnabled: !urlEnabled && !!selectionCollapsed,
    selEnabled: !selectionCollapsed
  };
}

// eventKey → 實際會被寫進剪貼簿的字串（null = 該項不適用／當下算不出來）。
// state 就是 ContextMenu 的 state（開選單當下算好的那份）。
const COPY_TEXT = {
  copyLinkUrl: s => s.contextOnUrl || null,
  copyArticleAid: s => formatArticleCode(s.contextArticle),
  copyArticleDeepLink: (s, href) =>
    s.contextArticle
      ? buildDeepLink(href, s.contextArticle.board, s.contextArticle.aid)
      : null,
  // 「本篇」。currentArticle 由 onContextMenu 用 aidNavigation.findLocalPostAid()
  // 現算：讀畫面上的「※ 文章網址:」那行，零副作用。讀不到時是 null ⇒ 沒有預覽，
  // 但選項照樣在（點下去由 deep_link_controller 走按 Q 的 fallback）。
  copyArticleLink: (s, href) =>
    s.currentArticle
      ? buildDeepLink(href, s.currentArticle.board, s.currentArticle.aid)
      : null
};

// 有預覽的選項（順序無意義，只用來迭代）。
export const PREVIEW_EVENT_KEYS = Object.keys(COPY_TEXT);

function currentHref() {
  return typeof window !== "undefined" && window.location
    ? window.location.href
    : "";
}

export function copyTextFor(eventKey, state, href) {
  const fn = COPY_TEXT[eventKey];
  if (!fn) return null;
  return fn(state || {}, href === undefined ? currentHref() : href) || null;
}

// 中段省略。CSS 的 text-overflow 只砍得掉尾巴，但網址的辨識資訊多半就在尾巴
// （檔名與副檔名），所以自己做：頭尾都留，省略號放中間。尾巴留得比頭多。
export function truncateMiddle(text, max = 72) {
  const s = text == null ? "" : String(text);
  if (s.length <= max || max <= 1) return s;
  const keep = max - 1; // 省略號自己佔一格
  const tail = Math.ceil(keep * 0.6);
  const head = keep - tail;
  return s.slice(0, head) + "…" + s.slice(s.length - tail);
}

// state → { eventKey: 已截斷的預覽字串 }。算不出內容的 key 不會出現在結果裡
// （DropdownMenu 據此決定要不要畫第二行）。
export function copyPreviews(state, href) {
  const out = {};
  for (const key of PREVIEW_EVENT_KEYS) {
    const text = copyTextFor(key, state, href);
    if (text) out[key] = truncateMiddle(text);
  }
  return out;
}
