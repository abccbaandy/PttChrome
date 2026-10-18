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
//            放在「更多」裡（工具列本身留給高頻動作）。
//   refresh：這一幀重整得了（screen_refresh.refreshTargetFromFacts，與 F5 攔截同一個判準）。
//   end    ：pager／文章列表／看板列表，送 End（文末／最後一筆；pmore 與列表的 KEY_END）。
//   threadNav：pager && !mail，「更多」裡的同主題前／下／首篇（[ ] =）與列表前／下篇（b f），
//            同表 'pager_common_cmds'。
//   post   ：文章列表（列表好讀 session 持有，或 《看板》＋文章列表 footer），送 Ctrl+P
//            （mbbsd/bbs.c 的 bbs_cmd_new_post）。游標在輸入欄（prompt 開著）時不給。
//   unreadJump：文章列表（同 post 的判準），「更多」裡的「跳到第一篇未讀」（unread_jump.js）。
//   markAllRead：文章列表（同 post 的判準），「更多」裡的「設為全部已讀」（mark_all_read.js）。
//   help   ：底列寫著 `(h)說明`／`(h)按鍵說明`（看板列表／文章列表／主功能表 footer、
//            pager 狀態列；vs_footer 與 pmore.c 的提示都在 b_lines），「更多」裡的「操作說明」送 h
//            ⇒ 新版說明選單（好讀開著時是 help_menu.js 的 bottom sheet）。手機上這些畫面的底列
//            常被收起（卡片／好讀文章），點不到原生的 (h)說明。游標在輸入欄時不給；主功能表（含子選單）
//            也不給，理由同 contentTools（sheet 再多一列就把整個選單蓋住、遮罩點不到）。
//   contentTools：「更多」裡的全選／上傳圖片／圖片上傳紀錄。主功能表（含子選單）不給：那裡沒有
//            內容可選、上傳也只能退回複製到剪貼簿，卻會把 sheet 撐到蓋住整個選單（遮罩點不到）。
//   search ：可開的搜尋種類，與鍵盤攔截同一個判準（article_search.availableSearchKinds）。
//   appBar ：頂部 App Bar 的標題（mobile_app_bar.js），同一次計算、同一個通知。
// 判準刻意不看 enableLongPush：推鈕送的是 X，長推文關掉時就是 PTT 原生推文。

import { parsePagerFooterContext } from './string_util';
import { atPagerStatusRow } from './long_push_gate';
import { availableSearchKinds, searchGateFacts } from './article_search';
import { boardListContextKind, classifyBoardListScreen } from './board_list_parse';
import { refreshTargetFromFacts } from './screen_refresh';
import { OWNER_ARTICLE_LIST } from './list_render_owner';
import { appBarFromFacts, sameAppBar, EMPTY_APP_BAR } from './mobile_app_bar';
import { MOBILE_KEYPAD_PUSH_KEY } from './mobile_layout';

export const EMPTY_TOOLBAR_CONTEXT = Object.freeze({
  push: false, reply: false, mail: false, share: false, threadNav: false, post: false,
  unreadJump: false, markAllRead: false, help: false, contentTools: false, refresh: false, end: false,
  search: [], appBar: EMPTY_APP_BAR
});

// 送鍵表：key 是 term_view.sendKeyAsUser 的 keyName（單字元或 KeyMap 裡的具名鍵），
// mods 是修飾鍵。Ctrl+P 走 Alt remap（mobile_layout.mobileCtrlKey 同理）：Alt+字母的 byte
// 與 Ctrl 相同，但不會被瀏覽器當成「列印」。
export const TOOLBAR_KEYS = Object.freeze({
  push: { key: MOBILE_KEYPAD_PUSH_KEY },
  reply: { key: 'y' },
  post: { key: 'p', mods: { altKey: true } },
  end: { key: 'End' },
  help: { key: 'h' }
});

// 底列有沒有「(h)說明」這顆提示（文字判準，不看 pageState：主功能表、看板列表、文章列表、
// pager 都適用；說明選單自己的 `(h)小天使` 不算）。
const HELP_HINT_RE = /\(h\)(?:按鍵)?說明/;
export function hasHelpHint(lastRowText) {
  return HELP_HINT_RE.test(lastRowText || '');
}

// 工具列的固定格位。**每一格的位置不隨畫面變**：按鈕依畫面有條件出現時，flex 等寬
// 會讓同一顆按鈕在不同畫面跑到不同位置（使用者回報「搜尋／到底有時在中間有時在旁邊」）。
//   第 1 格：主要動作 —— 文章＝推、列表／主功能表＝搜尋
//   第 2 格：次要動作 —— 文章／信件＝回文（回信）、文章列表＝發文
//   第 3～6 格：重整、到底、按鍵、更多，**永遠都在**；不能用時反灰（不藏）。
// null ＝這個畫面沒有這一格的動作，畫一個空格佔位（寬度照算）。
export const TOOLBAR_SLOT_COUNT = 6;
export function toolbarSlots(c) {
  const ctx = c || EMPTY_TOOLBAR_CONTEXT;
  const first = ctx.push ? 'push' : ctx.search && ctx.search.length ? 'search' : null;
  const second = ctx.reply ? 'reply' : ctx.post ? 'post' : null;
  return [first, second, 'refresh', 'end', 'keys', 'more'];
}

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
  const o = opts || {};
  const lists = !facts.inputField && (isArticleList(facts) || !!classifyBoardListScreen(facts));
  const menu = boardListContextKind(facts) === 'menu';
  return {
    push: article,
    reply: pager,
    mail: mail,
    share: article,
    threadNav: article,
    post: !pager && isArticleList(facts),
    unreadJump: !pager && isArticleList(facts),
    markAllRead: !pager && isArticleList(facts),
    help: !facts.inputField && !menu && hasHelpHint(last),
    contentTools: !menu,
    refresh: !!o.connected && !!refreshTargetFromFacts(facts, pageState, {
      articleBoard: o.articleBoard,
      listOpened: o.listOpened
    }),
    end: pager || lists,
    search: availableSearchKinds(facts),
    appBar: appBarFromFacts(facts, { ...(opts || {}), pageState: pageState })
  };
}

export function mobileToolbarContext(core) {
  const facts = searchGateFacts(core);
  const view = (core && core.view) || {};
  const prev = core && core._screenContext && core._screenContext.appBar;
  const ls = core && core.listSession;
  return toolbarContextFromFacts(facts, core && core.buf ? core.buf.pageState : null, {
    articleTitle: view._articleTitle,
    articleBoard: view._articleBoard,
    prev: prev,
    connected: !!(core && core.conn && core.conn.isConnected),
    listOpened: !!(ls && ls.currentAnchor && ls.currentAnchor())
  });
}

const FLAGS = [
  'push', 'reply', 'mail', 'share', 'threadNav', 'post', 'unreadJump', 'markAllRead', 'help', 'contentTools', 'refresh', 'end'
];

export function sameToolbarContext(a, b) {
  if (!a || !b) return a === b;
  for (const f of FLAGS) if (!!a[f] !== !!b[f]) return false;
  return (a.search || []).join(',') === (b.search || []).join(',') &&
    sameAppBar(a.appBar || EMPTY_APP_BAR, b.appBar || EMPTY_APP_BAR);
}
