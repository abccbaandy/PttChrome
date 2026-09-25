// 底部狀態列（最後一列）**左側 Caption** 的畫面判定 —— 純函式，零 DOM、零狀態。
//
// pttbbs 的列表底列一律是 `vtuikit.c#vs_footer(caption, hints)`：caption 從 col 0
// 起印（配色 VCLR_FOOTER_CAPTION），後面接按鍵提示。本專案靠這個 caption 分辨
// 「文章列表／信箱／看板列表／編輯器」。
//
// ── 兩種格式必須同時吃 ─────────────────────────────────────────────────────
//
// 舊格式（CONFIRMED @ pttbbs 03cdf5eb）：
//   read.c:1237    " 文章選讀 "   —— 非信箱的**所有** i_read 列表（一般／搜尋結果／文摘）
//   read.c:1234    " 鴻雁往返 "   —— currstat == RMAIL
//   board.c:1285   "  選擇看板  " —— 看板列表三變體（最愛／分類子層／全部）共用
//   edit.c:470     " 編輯文章 "
//
// 新格式（CONFIRMED @ pttbbs origin/piaip.newui 7e35b24e；PTT2 09/20、PTT1 10/18 預定）：
//   read.c#i_read_caption    RMAIL→" 信件列表 "、MODE_DIGEST→" 文摘列表 "、
//                            MODE_SELECT→" 系列文章 "、其餘→" 文章列表 "
//   board.c#brdlist_caption  IN_CLASSROOT→" 分類看板 "、IN_FAVORITE→" 我的最愛 "、
//                            其餘→" 看板列表 "
//   edit.c#edit_msg          " 編輯文章 "（不變）
// 舊版「文章選讀」涵蓋的正好就是新版那三種 ⇒ 集合一對一，信箱照舊排除。
//
// ⚠️ 看板列表的 caption **不等於**變體：IN_FAVORITE 是 `class_bid == 0`，不看
// yank_flag ⇒ 在我的最愛按 `y` 列出全站看板時 caption 仍是「我的最愛」。變體判定
// 在 board_list_parse.js#boardListVariant。
//
// PTT1/PTT2 上線時間不同，兩種格式會並存 ⇒ **不要刪舊格式**。
// 精華區 caption（announce.c）本專案沒有消費端（精華區靠 row 0【精華文章】），故不收。
//
// 只認**行首**第一個 token（允許前導空白）：caption 本來就從 col 0 起印；新版中段
// 提示是動態的（psb.c#vs_cmd_bar 依 prio／權限／寬度增減），只做 indexOf 會讓提示
// 文字裡剛好出現的「我的最愛」之類誤命中。
//
// 守護：tests/unit/screen_captions.test.js

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
