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
//
// touchLongPress（手機長按）：Chromium 處理長按手勢時**先選字、後發 contextmenu**
// （GestureManager::HandleGestureLongPress）⇒ 事件到這裡時選取必定不是空的。照桌機
// 規則算，normalEnabled 恆 false ⇒ 「加入黑名單」「前已讀後未讀」「貼上」等整組消失
// （使用者回報）。長按選到的那個字不是使用者刻意的選取，所以 normalEnabled 不看選取；
// selEnabled 照舊（「複製」那個字仍有用）。
export function menuTargetFlags({ contextOnUrl, selectionCollapsed, touchLongPress }) {
  const urlEnabled = !!contextOnUrl;
  return {
    urlEnabled,
    normalEnabled: !urlEnabled && (!!selectionCollapsed || !!touchLongPress),
    selEnabled: !selectionCollapsed
  };
}

// 這次 contextmenu 是不是觸控長按。Chrome 的 contextmenu 是 PointerEvent（帶
// pointerType）；舊一點的版本退回 InputDeviceCapabilities.firesTouchEvents。
export function isTouchContextMenu(event) {
  if (!event) return false;
  if (event.pointerType === "touch") return true;
  const caps = event.sourceCapabilities;
  return !!(caps && caps.firesTouchEvents);
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

// 右鍵事件該怎麼處置。抽成純函式的理由是**順序敏感**：三個分支的先後不是風格問題，
// 調換就會產生一個只在特定動線下出現、而且靜默的 bug。
//
//   'swallow' — 吞掉（stopPropagation + preventDefault，什麼都不開）。
//               來源是「按住右鍵滾輪翻頁」：手勢結束放開右鍵時瀏覽器仍會發一次
//               contextmenu，那顆旗標（pttchrome.jsx 的 doDOMMouseScroll）就是用來
//               把它消費掉的。
//   'native'  — 放行瀏覽器原生選單（**一個 preventDefault 都不准叫**）。
//   'menu'    — 開我們自己的選單。
//
// **doDOMMouseScroll 必須先判**：那顆旗標的唯一消費者就是這裡。若把圖片判斷排在
// 它前面，使用者在圖片上做「按住右鍵滾輪翻頁」時會走 'native' 直接 return ⇒ 旗標
// 留著 '1' ⇒ 下一次（任何地方的）正常右鍵被靜默吞掉一次，看起來像「右鍵選單偶爾
// 叫不出來」。守護：tests/unit/context_menu_disposition.test.js
//
// mobile＋selectMode：手機按鍵列的「選取模式」開著 ⇒ 右鍵／長按＝一般網頁操作（Chrome
// 原生選取把手＋複製工具列），我們的選單不出來。排在 swallow 之後，理由同上（旗標只在
// 這裡被消費）。
// **只看模式，不看事件來源**：Android Chrome 拖完選取把手放手時會再補發一次
// contextmenu（RenderWidgetHostViewAndroid::ShowContextMenuAtTouchHandle → Blink
// EventHandler::ShowNonLocatedContextMenu），造出來的事件是 pointerType 'mouse'、
// firesTouchEvents false —— 沒有任何觸控標記，靠 isTouchContextMenu 判斷會走 'menu'，
// 我們的選單跳出來、原生複製工具列被 preventDefault 吃掉。代價：手機版面接滑鼠、開著
// 選取模式時右鍵也走原生（使用者自己開的模式，可接受）。桌機不受影響
// （applyMobileLayout 在非手機時強制 mobileSelectMode=false，這裡也再看一次 mobile）。
// 見 docs/mobile.md「長按選單與選取模式」。
export function contextMenuDisposition({ nativeTarget, doDOMMouseScroll, mobile, selectMode }) {
  if (doDOMMouseScroll) return "swallow";
  if (nativeTarget || (!!mobile && !!selectMode)) return "native";
  return "menu";
}

// 手機、選取模式關著的觸控長按：開我們的選單，並且**不留原生選取**（Chromium 長按
// 先選字、後發 contextmenu ⇒ 那個字的選取把手會跟選單搶畫面／搶手指）。使用者要
// 選字複製就去開選取模式。
export function shouldClearTouchSelection({ mobile, touch, selectMode }) {
  return !!mobile && !!touch && !selectMode;
}

// 文章列表列的黑名單快速新增目標。
//   cards＝手機卡片（view.listCards）：整張卡片是同一組點選目標，作者與標題**一起**給
//     ——卡片上的作者只是第二行的一小段字，按「長按落在哪一段」分的話手指幾乎按不中，
//     兩個選項就都不出現（使用者回報）。
//   否則（桌機 80 欄格線）：region（comment_parse.listColRegion）分作者欄／標題區。
// 刪除列沒有作者、標題是空字串 ⇒ 該項為 null（不出現）。
export function listBlacklistTargets({ cards, region, listAuthor, listTitle }) {
  const author = listAuthor || null;
  const title = listTitle || null;
  if (cards) return { author, title };
  return {
    author: region === "author" ? author : null,
    title: region === "title" ? title : null,
  };
}
