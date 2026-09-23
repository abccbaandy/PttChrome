// 底部狀態列（最後一列）**左側 Caption** 的畫面判定 —— 純函式，零 DOM、零狀態。
//
// pttbbs 的列表底列一律是 `vtuikit.c#vs_footer(caption, hints)`：caption 從 col 0
// 起印（配色 VCLR_FOOTER_CAPTION，vtuikit.h:40），後面接按鍵提示。本專案靠這個
// caption 分辨「文章列表／信箱／看板列表／編輯器」。
//
// ── 兩種格式必須同時吃 ─────────────────────────────────────────────────────
//
// 舊格式（CONFIRMED @ pttbbs 03cdf5eb）：
//   read.c:1237    " 文章選讀 "   —— 非信箱的**所有** i_read 列表（一般／搜尋結果／文摘）
//   read.c:1234    " 鴻雁往返 "   —— currstat == RMAIL
//   board.c:1285   "  選擇看板  " —— 看板列表三變體（最愛／分類子層／全部）共用
//   edit.c:470     " 編輯文章 "
//
// 新格式（**guess** @ 2026-09-20 公告「介面調整: 動態指令列與看板資訊改版」，
// PTT2 09/20、PTT1 10/18 預定；該改動**還沒進公開的 pttbbs repo**，只有公告文字）：
//   文章列表 → 「文章列表」一般／「系列文章」搜尋・同主題・篩選／「文摘列表」Tab 文摘
//   信箱     → 「信件列表」
//   看板列表 → 「看板列表」一般・熱門・分類子層／「我的最愛」／「分類看板」分類根
//   編輯器   → 「編輯文章」不變
// 舊版「文章選讀」涵蓋的正好就是新版那三種 ⇒ 集合一對一，信箱照舊排除。
//
// PTT1/PTT2 上線時間差約一個月，兩種格式會並存 ⇒ **不要刪舊格式**。
// 精華區 caption（announce.c:259 的【功能鍵】等，新版「精華列表」…）本專案沒有
// 消費端（精華區靠 row 0【精華文章】），故不收。
//
// 只認**行首**第一個 token（允許前導空白）：caption 本來就從 col 0 起印；新版中段
// 提示是動態的，只做 indexOf 會讓提示文字裡剛好出現的「我的最愛」之類誤命中。
//
// 重新校準：docs/handoff/list-caption-recalibrate.md。守護：tests/unit/screen_captions.test.js

export const ARTICLE_LIST_CAPTIONS = ['文章選讀', '文章列表', '系列文章', '文摘列表'];
export const MAIL_LIST_CAPTIONS = ['鴻雁往返', '信件列表'];
export const BOARD_LIST_CAPTIONS = ['選擇看板', '看板列表', '我的最愛', '分類看板'];
export const EDITOR_CAPTION = '編輯文章';

const KNOWN_CAPTIONS = new Set(
  [].concat(ARTICLE_LIST_CAPTIONS, MAIL_LIST_CAPTIONS, BOARD_LIST_CAPTIONS, [EDITOR_CAPTION])
);

// 最後一列的 caption；不是已知 caption 回 null。
export function footerCaption(lastRowText) {
  if (!lastRowText) return null;
  const m = /^\s*(\S+)/.exec(lastRowText);
  if (!m) return null;
  return KNOWN_CAPTIONS.has(m[1]) ? m[1] : null;
}

// 文章列表（非信箱）的底列。
export function isArticleListFooter(lastRowText) {
  return ARTICLE_LIST_CAPTIONS.indexOf(footerCaption(lastRowText)) >= 0;
}

// 看板列表（choose_board）的底列。分類看板根也算（呼叫端另以 row 0 區分）。
export function isBoardListFooter(lastRowText) {
  return BOARD_LIST_CAPTIONS.indexOf(footerCaption(lastRowText)) >= 0;
}

// 光看 caption 就能定的看板列表變體。只有新版「我的最愛」做得到；
// 其餘（舊版「選擇看板」、新版「看板列表」）回 null ＝交給呼叫端的按鍵提示判斷。
export function boardListCaptionVariant(lastRowText) {
  return footerCaption(lastRowText) === '我的最愛' ? 'fav' : null;
}
