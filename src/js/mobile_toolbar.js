// 手機底部導覽（components/MobileToolbar）該顯示哪些動作 —— 純函式，讀 buf 不讀 DOM。
// App 在每次 screenSettled 算一次、有變才通知元件（App.onScreenContextChange）。
//
//   pager  ：pageState 3 且**這一幀**底列真的是 pager 狀態列（prompt 幀會沿用舊的
//            pageState，見 long_push_gate.atPagerStatusRow）。
//   mail   ：pager 是站內信（parsePagerFooterContext）。信件的 X 是別的鍵、沒有看板 ⇒
//            不給推／分享／同主題；y 的 label 是「回信」（mail.c 的 pager）。
//   push   ：pager && !mail，送 X（mbbsd/more.c pager_common_cmds 'X'）。
//   reply  ：pager，送 y（同表 'y'＝回文；信件 pager 由 mail.c 接成回信）。
//   share  ：pager && !mail（deep link 需要看板，見 deep_link_controller.shareCurrentPostLink）。
//   threadNav：pager && !mail，「更多」裡的同主題前／下／首篇（[ ] =）與列表前／下篇（b f），
//            同表 'pager_common_cmds'。
//   post   ：文章列表（列表好讀 session 持有，或 《看板》＋文章列表 footer），送 Ctrl+P
//            （mbbsd/bbs.c 的 bbs_cmd_new_post）。游標在輸入欄（prompt 開著）時不給。
//   search ：可開的搜尋種類，與鍵盤攔截同一個判準（article_search.availableSearchKinds）。
//   appBar ：頂部 App Bar 的標題（mobile_app_bar.js），同一次計算、同一個通知。
// 判準刻意不看 enableLongPush：推鈕送的是 X，長推文關掉時就是 PTT 原生推文。

import { parsePagerFooterContext } from './string_util';
import { atPagerStatusRow } from './long_push_gate';
import { availableSearchKinds, searchGateFacts } from './article_search';
import { boardListContextKind } from './board_list_parse';
import { OWNER_ARTICLE_LIST } from './list_render_owner';
import { appBarFromFacts, sameAppBar, EMPTY_APP_BAR } from './mobile_app_bar';
import { MOBILE_KEYPAD_PUSH_KEY } from './mobile_layout';

export const EMPTY_TOOLBAR_CONTEXT = Object.freeze({
  push: false, reply: false, mail: false, share: false, threadNav: false, post: false,
  search: [], appBar: EMPTY_APP_BAR
});

// 送鍵表：key 是 term_view.sendKeyAsUser 的 keyName（單字元或 KeyMap 裡的具名鍵），
// mods 是修飾鍵。Ctrl+P 走 Alt remap（mobile_layout.mobileCtrlKey 同理）：Alt+字母的 byte
// 與 Ctrl 相同，但不會被瀏覽器當成「列印」。
export const TOOLBAR_KEYS = Object.freeze({
  push: { key: MOBILE_KEYPAD_PUSH_KEY },
  reply: { key: 'y' },
  post: { key: 'p', mods: { altKey: true } }
});

// 「更多」裡的文章導覽（label 是 i18n key）。
export const THREAD_NAV_KEYS = Object.freeze([
  { key: '[', label: 'mobileToolbar_threadPrev' },
  { key: ']', label: 'mobileToolbar_threadNext' },
  { key: '=', label: 'mobileToolbar_threadFirst' },
  { key: 'b', label: 'mobileToolbar_articlePrev' },
  { key: 'f', label: 'mobileToolbar_articleNext' }
]);

function isArticleList(facts) {
  if (facts.inputField) return false;
  return facts.listOwner === OWNER_ARTICLE_LIST || boardListContextKind(facts) === 'article-list';
}

// opts：appBarFromFacts 的 opts（pageState 以外的 articleTitle／articleBoard／prev）。
export function toolbarContextFromFacts(facts, pageState, opts) {
  if (!facts) return EMPTY_TOOLBAR_CONTEXT;
  const last = (facts.rowTexts || [])[facts.rows - 1] || '';
  const pager = pageState === 3 && atPagerStatusRow(last);
  const mail = pager && parsePagerFooterContext(last) === 'mail';
  const article = pager && !mail;
  return {
    push: article,
    reply: pager,
    mail: mail,
    share: article,
    threadNav: article,
    post: !pager && isArticleList(facts),
    search: availableSearchKinds(facts),
    appBar: appBarFromFacts(facts, { ...(opts || {}), pageState: pageState })
  };
}

export function mobileToolbarContext(core) {
  const facts = searchGateFacts(core);
  const view = (core && core.view) || {};
  const prev = core && core._screenContext && core._screenContext.appBar;
  return toolbarContextFromFacts(facts, core && core.buf ? core.buf.pageState : null, {
    articleTitle: view._articleTitle,
    articleBoard: view._articleBoard,
    prev: prev
  });
}

const FLAGS = ['push', 'reply', 'mail', 'share', 'threadNav', 'post'];

export function sameToolbarContext(a, b) {
  if (!a || !b) return a === b;
  for (const f of FLAGS) if (!!a[f] !== !!b[f]) return false;
  return (a.search || []).join(',') === (b.search || []).join(',') &&
    sameAppBar(a.appBar || EMPTY_APP_BAR, b.appBar || EMPTY_APP_BAR);
}
