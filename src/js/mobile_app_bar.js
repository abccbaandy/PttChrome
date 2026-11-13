// 手機頂部 App Bar（components/MobileAppBar）的標題 —— 純函式，讀 facts 不讀 DOM。
// 與底部工具列同一次計算（mobile_toolbar.mobileToolbarContext，screenSettled 時、有變才通知）。
// docs/mobile.md「App Bar」。
//
// kind（判斷順序就是優先序）：
//   article  pageState 3：標題＝文章（或信件）檔頭的「標題」列，副標＝看板。
//            檔頭只在第一頁 ⇒ 由 term_view 跟著 _articleAuthor 一起記（_articleTitle）。
//            detail＝「作者 · 看板 · 發文時間」（P58，_articleByline）：元件在檔頭卡片捲出
//            畫面後拿它當副標（標題看得到時只寫看板），見 components/MobileAppBar。
//   list     文章列表（《看板》＋文章列表 footer，或列表好讀 session 持有）：標題＝看板名。
//            row 0 也是 `【板主:xxx】` 形狀 ⇒ 必須先於 menu 判。
//   boards   看板列表（我的最愛／分類／全部看板）：標題＝row 0 的【X】。
//   menu     其他 row 0 是【X】的畫面（主功能表、所有 domenu 子選單、精華區…）。
//   editor   pageState 6 且 opts.editorTitle（P57，pref mobileEditorSave）：標題由元件寫「編輯文章」
//            （發文／回文／寫信／改文都是同一個 edit.c 編輯器）。沒開 ⇒ 照舊沿用上一個。
// 都不是（prompt、半繪的過渡幀）⇒ 沿用上一個（prev），避免標題閃爍。
// newMail：row 0 中段的「你有新信件」（mbbsd/menu.c#redraw_title；主選單與文章列表共用）。
// 沒有返回鍵：返回交給系統邊緣滑動（history_back_guard.js 把返回轉成 ←）。

import { boardListContextKind } from './board_list_parse';
import { OWNER_ARTICLE_LIST } from './list_render_owner';
import { parseBoardName, parseHeaderTitle } from './screen_titles';
import { PAGE_STATE } from './screen_model';

export const NEW_MAIL_MARK = '你有新信件';

export const EMPTY_APP_BAR = Object.freeze({
  kind: 'other', title: '', subtitle: '', newMail: false, detail: ''
});

function bar(kind, title, subtitle, newMail, detail) {
  return {
    kind: kind, title: title || '', subtitle: subtitle || '', newMail: !!newMail, detail: detail || ''
  };
}

// 「作者 · 看板 · 時間」，缺的省略（站內信沒有看板）。
export function articleDetail(byline, board) {
  const b = byline || {};
  return [b.author, board, b.time].filter(Boolean).join(' · ');
}

// facts：article_search.searchGateFacts 的形狀（rowTexts/rows/listOwner…）。
// opts：{ pageState, articleTitle, articleBoard, articleByline, prev }。
export function appBarFromFacts(facts, opts) {
  const o = opts || {};
  const prev = o.prev || EMPTY_APP_BAR;
  if (!facts) return prev;
  const rowTexts = facts.rowTexts || [];
  const row0 = rowTexts[0] || '';
  const newMail = row0.indexOf(NEW_MAIL_MARK) >= 0;

  if (o.pageState === PAGE_STATE.READING) {
    return bar('article', o.articleTitle, o.articleBoard, false,
      articleDetail(o.articleByline, o.articleBoard));
  }
  if (o.pageState === PAGE_STATE.EDITOR && o.editorTitle) return bar('editor', '', '', false);
  const ctx = boardListContextKind(facts);
  if (facts.listOwner === OWNER_ARTICLE_LIST || ctx === 'article-list') {
    const board = parseBoardName(row0) || (prev.kind === 'list' ? prev.title : '');
    return bar('list', board, '', newMail);
  }
  const head = parseHeaderTitle(row0);
  if (ctx === 'brdlist' || ctx === 'brdlist-other') {
    return bar('boards', head || (prev.kind === 'boards' ? prev.title : ''), '', newMail);
  }
  if (head) return bar('menu', head, '', newMail);
  return prev;
}

export function sameAppBar(a, b) {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.title === b.title &&
    a.subtitle === b.subtitle && a.newMail === b.newMail && (a.detail || '') === (b.detail || '');
}
