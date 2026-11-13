// 手機底部導覽（components/MobileToolbar）該顯示哪些動作 —— 純函式，讀 buf 不讀 DOM。
// App 在每次 screenSettled 算一次、有變才通知元件（App.onScreenContextChange）。
//
//   pager  ：pageState 3 且**這一幀**底列真的是 pager 狀態列（prompt 幀會沿用舊的
//            pageState，見 long_push_gate.atPagerStatusRow），且游標不在輸入欄。
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
//   boardTools：P66（pref mobileBoardTools）。文章列表（同 post 的判準），且不是搜尋結果
//            （search_status.searchListMode 'select'）⇒「更多」最上面一列「這個看板」：進板畫面 b、
//            精華區 z、文摘 Tab、看板資訊 i（bbs.c 的 bbs_cmd_notes／man／board_digest／config），
//            每顆只送那一個原生單鍵（BOARD_TOOL_KEYS），畫面照 PTT 原生。
//   help   ：底列寫著 `(h)說明`／`(h)按鍵說明`（看板列表／文章列表／主功能表 footer、
//            pager 狀態列；vs_footer 與 pmore.c 的提示都在 b_lines），「更多」裡的「操作說明」送 h
//            ⇒ 新版說明選單（好讀開著時是 help_menu.js 的 bottom sheet）。手機上這些畫面的底列
//            常被收起（卡片／好讀文章），點不到原生的 (h)說明。游標在輸入欄時不給；主功能表（含子選單）
//            也不給，理由同 contentTools（sheet 再多一列就把整個選單蓋住、遮罩點不到）。
//   contentTools：「更多」裡的全選／上傳圖片／圖片上傳紀錄。主功能表（含子選單）不給：那裡沒有
//            內容可選、上傳也只能退回複製到剪貼簿，卻會把 sheet 撐到蓋住整個選單（遮罩點不到）。
//   search ：可開的搜尋種類，與鍵盤攔截同一個判準（article_search.availableSearchKinds）。
//   appBar ：頂部 App Bar 的標題（mobile_app_bar.js），同一次計算、同一個通知。
//   editor ：PTT 編輯器（pageState 6，term_buf.setPageState 的判準）。第 1 格放「輸入框」
//            （editor_input.js；pref 關掉時元件畫空格）。
//   editorSave：P57（pref mobileEditorSave）。編輯器、且**這一幀**打字會進內文（底列是編輯器
//            caption、游標不在輸入欄＝term_buf.isEditorTypingNow 的同一個判準）⇒ 第 2 格「存檔」
//            送 ^X，打開 PTT 原生的「檔案處理」選單（edit.c#write_file），存檔／放棄由使用者自己選。
//            ^S 搜尋、F5 跳行這類 getdata(b_lines - 1) 的 prompt 開著時底列還在 ⇒ 要看游標。
//   mailList：P59（pref mobileMailListTools，searchGateFacts 的 mailListTools：手機＋信件列表）。
//            第 1 格「搜尋」（/、a，availableSearchKinds）、第 2 格「寫信」送 ^P（mail.c#mail_comms
//            的 Ctrl('P') mail_cmd_send，打開原生寄信流程）、「到底」送 End（read.c 共用的 KEY_END）。
//            游標在輸入欄時不給（同 post）。
//   choices：P61（pref mobilePromptChoices）。PTT 正在問「選一個」（發文種類、回文對象、編輯器檔案處理、
//            是非題）⇒ 底部導覽上方浮出可點選項（prompt_choices.js：只認固定字樣、欄位要是空的）。
//            同一個位置還有 P62（pref mobilePromptKeyboard）其他輸入欄的「開鍵盤輸入」、P63（pref
//            mobileAnyKeyContinue）「請按任意鍵繼續」的「繼續」（prompt_choices.js#promptPanelFromBuf）。
// 判準刻意不看 enableLongPush：推鈕送的是 X，長推文關掉時就是 PTT 原生推文。

import { parsePagerFooterContext } from './string_util';
import { atPagerStatusRow } from './long_push_gate';
import { availableSearchKinds, searchGateFacts } from './article_search';
import { boardListContextKind, classifyBoardListScreen } from './board_list_parse';
import { refreshTargetFromFacts, homeDashboardShown } from './screen_refresh';
import { OWNER_ARTICLE_LIST } from './list_render_owner';
import { appBarFromFacts, sameAppBar, EMPTY_APP_BAR } from './mobile_app_bar';
import { MOBILE_KEYPAD_PUSH_KEY } from './mobile_layout';
import { isEditorFooter } from './screen_captions';
import { readEffectivePrefs } from './pref_storage';
import { promptPanelFromBuf, promptChoicesSig } from './prompt_choices';
import { searchListMode } from './search_status';
import { PAGE_STATE } from './screen_model';

export const EMPTY_TOOLBAR_CONTEXT = Object.freeze({
  push: false, reply: false, mail: false, share: false, threadNav: false, post: false,
  unreadJump: false, markAllRead: false, boardTools: false, help: false, contentTools: false, refresh: false, end: false,
  editor: false, editorSave: false, mailList: false, readOnly: false, search: [], appBar: EMPTY_APP_BAR, choices: null
});

// 送鍵表：key 是 term_view.sendKeyAsUser 的 keyName（單字元或 KeyMap 裡的具名鍵），
// mods 是修飾鍵。Ctrl+P 走 Alt remap（mobile_layout.mobileCtrlKey 同理）：Alt+字母的 byte
// 與 Ctrl 相同，但不會被瀏覽器當成「列印」。
export const TOOLBAR_KEYS = Object.freeze({
  push: { key: MOBILE_KEYPAD_PUSH_KEY },
  reply: { key: 'y' },
  post: { key: 'p', mods: { altKey: true } },
  // ^P：信件列表的「寄信」（同 post 走 Alt remap）。
  mailCompose: { key: 'p', mods: { altKey: true } },
  end: { key: 'End' },
  help: { key: 'h' },
  // ^X：同 post 走 Alt remap。
  editorSave: { key: 'x', mods: { altKey: true } }
});

// 底列有沒有「(h)說明」這顆提示（文字判準，不看 pageState：主功能表、看板列表、文章列表、
// pager 都適用；說明選單自己的 `(h)小天使` 不算）。
const HELP_HINT_RE = /\(h\)(?:按鍵)?說明/;
export function hasHelpHint(lastRowText) {
  return HELP_HINT_RE.test(lastRowText || '');
}

// 工具列的固定格位。**每一格的位置不隨畫面變**：按鈕依畫面有條件出現時，flex 等寬
// 會讓同一顆按鈕在不同畫面跑到不同位置（使用者回報「搜尋／到底有時在中間有時在旁邊」）。
//   第 1 格：主要動作 —— 文章＝推、編輯器＝輸入框、列表／主功能表＝搜尋
//   第 2 格：次要動作 —— 文章／信件＝回文（回信）、文章列表＝發文、編輯器＝存檔（P57）、
//            信件列表＝寫信（P59）
//   第 3～6 格：重整、到底、按鍵、更多，**永遠都在**；不能用時反灰（不藏）。
// null ＝這個畫面沒有這一格的動作，畫一個空格佔位（寬度照算）。
export const TOOLBAR_SLOT_COUNT = 6;
export function toolbarSlots(c) {
  const ctx = c || EMPTY_TOOLBAR_CONTEXT;
  const first = ctx.push ? 'push' : ctx.editor ? 'editorInput' : ctx.search && ctx.search.length ? 'search' : null;
  const second = ctx.reply ? 'reply' : ctx.post ? 'post' : ctx.editorSave ? 'editorSave' :
    ctx.mailList ? 'mailCompose' : null;
  return [first, second, 'refresh', 'end', 'keys', 'more'];
}

// 「更多」裡的文章導覽（label／short／title 是 i18n key）。P56：兩列成對排——「同主題：首篇｜前篇｜下篇」、
// 「看板：前一篇｜下一篇」，前／下各配左右箭頭（dir：'first'｜'prev'｜'next'）。按鈕上只寫 short，
// 完整名稱（label）給 aria-label。送的鍵不變。
export const THREAD_NAV_GROUPS = Object.freeze([
  Object.freeze({
    title: 'mobileToolbar_navGroupThread',
    keys: Object.freeze([
      { key: '=', label: 'mobileToolbar_threadFirst', short: 'mobileToolbar_navFirst', dir: 'first' },
      { key: '[', label: 'mobileToolbar_threadPrev', short: 'mobileToolbar_navPrevThread', dir: 'prev' },
      { key: ']', label: 'mobileToolbar_threadNext', short: 'mobileToolbar_navNextThread', dir: 'next' }
    ])
  }),
  Object.freeze({
    title: 'mobileToolbar_navGroupBoard',
    keys: Object.freeze([
      { key: 'b', label: 'mobileToolbar_articlePrev', short: 'mobileToolbar_articlePrev', dir: 'prev' },
      { key: 'f', label: 'mobileToolbar_articleNext', short: 'mobileToolbar_articleNext', dir: 'next' }
    ])
  })
]);
// P66「這個看板」：key 是 sendKeyAsUser 的 keyName，label／short 是 i18n key（完整名稱給 aria-label）。
// 鍵對應 upstream mbbsd/bbs.c 的 read_comms 表（'b' 進板、'z' 精華區、KEY_TAB 文摘、'i' 看板設定）。
export const BOARD_TOOL_KEYS = Object.freeze([
  Object.freeze({ id: '__boardNotes', key: 'b', label: 'mobileBoard_notes', short: 'mobileBoardShort_notes' }),
  Object.freeze({ id: '__boardMan', key: 'z', label: 'mobileBoard_man', short: 'mobileBoardShort_man' }),
  Object.freeze({ id: '__boardDigest', key: 'Tab', label: 'mobileBoard_digest', short: 'mobileBoardShort_digest' }),
  Object.freeze({ id: '__boardInfo', key: 'i', label: 'mobileBoard_info', short: 'mobileBoardShort_info' })
]);

export const THREAD_NAV_KEYS = Object.freeze(
  THREAD_NAV_GROUPS.reduce((all, g) => all.concat(g.keys), [])
);

function isArticleList(facts) {
  if (facts.inputField) return false;
  return facts.listOwner === OWNER_ARTICLE_LIST || boardListContextKind(facts) === 'article-list';
}

// opts：appBarFromFacts 的 opts（pageState 以外的 articleTitle／articleBoard／prev）。
export function toolbarContextFromFacts(facts, pageState, opts) {
  if (!facts) return EMPTY_TOOLBAR_CONTEXT;
  const last = (facts.rowTexts || [])[facts.rows - 1] || '';
  // 游標在輸入欄＝pmore 自己的 prompt（`/` 搜尋、`:` 跳行…）開著：它畫在倒數第二列、
  // 狀態列留著，光看底列還是 pager；這時推／回文／到底按下去只會打進 prompt。
  const pager = pageState === PAGE_STATE.READING && !facts.inputField && atPagerStatusRow(last);
  const mail = pager && parsePagerFooterContext(last) === 'mail';
  // 看板精華區的文章：footer 跟看板文章一樣，但推／回／Q／翻同主題都只會退回精華區選單
  // （TermBuf.pagerContext）。
  const essence = pager && !!facts.pagerFromEssence;
  const article = pager && !mail && !essence;
  const o = opts || {};
  const lists = !facts.inputField && (isArticleList(facts) || !!classifyBoardListScreen(facts));
  const menu = boardListContextKind(facts) === 'menu';
  const mailList = !facts.inputField && !!facts.mailListTools;
  return {
    push: article,
    reply: pager && !essence,
    mail: mail,
    share: article,
    threadNav: article,
    post: !pager && isArticleList(facts),
    unreadJump: !pager && isArticleList(facts),
    markAllRead: !pager && isArticleList(facts),
    boardTools: !!o.boardTools && !pager && isArticleList(facts) &&
      searchListMode(facts.rowTexts) !== 'select',
    help: !facts.inputField && !menu && hasHelpHint(last),
    contentTools: !menu,
    refresh: !!o.connected && !!refreshTargetFromFacts(facts, pageState, {
      articleBoard: o.articleBoard,
      listOpened: o.listOpened,
      home: o.home
    }),
    end: pager || lists || mailList,
    editor: pageState === PAGE_STATE.EDITOR,
    editorSave: pageState === PAGE_STATE.EDITOR && !!o.editorSave && !facts.inputField && isEditorFooter(last),
    mailList: mailList,
    search: availableSearchKinds(facts),
    appBar: appBarFromFacts(facts, { ...(opts || {}), pageState: pageState }),
    choices: o.choices || null
  };
}

// 存到本機的唯讀頁（view._staticRows，docs/saved-articles.md）：沒有連線、送不出任何鍵 ⇒
// 推／回文／重整都不能用（格位照留、反灰），只留「到底」與「更多」裡的閱讀工具（字級、預覽…）；
// 「按鍵」面板照常（term_view 在唯讀頁把鍵盤改成捲動）。readOnly ⇒「更多」不列上傳圖片、登出。
// App Bar 是那篇的標題與看板。
export function staticReaderContext(view) {
  const v = view || {};
  return {
    ...EMPTY_TOOLBAR_CONTEXT,
    end: true,
    contentTools: true,
    readOnly: true,
    appBar: appBarFromFacts({ rowTexts: [] }, {
      pageState: 3,
      articleTitle: v._articleTitle,
      articleBoard: v._articleBoard,
      articleByline: v._articleByline
    })
  };
}

export function mobileToolbarContext(core) {
  if (core && core.view && core.view._staticRows) return staticReaderContext(core.view);
  const facts = searchGateFacts(core);
  const view = (core && core.view) || {};
  const prev = core && core._screenContext && core._screenContext.appBar;
  const ls = core && core.listSession;
  const editorSave = !!readEffectivePrefs().mobileEditorSave;
  return toolbarContextFromFacts(facts, core && core.buf ? core.buf.pageState : null, {
    editorTitle: editorSave,
    articleTitle: view._articleTitle,
    articleBoard: view._articleBoard,
    articleByline: view._articleByline,
    prev: prev,
    connected: !!(core && core.conn && core.conn.isConnected),
    listOpened: !!(ls && ls.currentAnchor && ls.currentAnchor()),
    home: homeDashboardShown(core),
    editorSave: editorSave,
    boardTools: !!readEffectivePrefs().mobileBoardTools,
    choices: core && core.buf ? promptPanelFromBuf(core.buf, readEffectivePrefs()) : null
  });
}

const FLAGS = [
  'push', 'reply', 'mail', 'share', 'threadNav', 'post', 'unreadJump', 'markAllRead', 'boardTools', 'help', 'contentTools', 'refresh', 'end',
  'editor', 'editorSave', 'mailList', 'readOnly'
];

export function sameToolbarContext(a, b) {
  if (!a || !b) return a === b;
  for (const f of FLAGS) if (!!a[f] !== !!b[f]) return false;
  return (a.search || []).join(',') === (b.search || []).join(',') &&
    promptChoicesSig(a.choices) === promptChoicesSig(b.choices) &&
    sameAppBar(a.appBar || EMPTY_APP_BAR, b.appBar || EMPTY_APP_BAR);
}
