// @ts-check
// 週邊功能宣告表（架構 review A6「功能註冊表與明確的執行階段」）。
//
// 一個週邊功能＝App 上一個屬性（name，也是 owner 標籤）＋一個開關（pref，DEFAULT_PREFS 鍵；
// 故障停用時 `buf.addEventListener(…, { feature })` 登記的就是它）＋建構函式。App 建構子照陣列
// 順序建 ⇒ **陣列順序就是 settle 派發順序**（建構子裡註冊監聽）。
//
// 「順序有意義」寫在 `after`：列出必須先建好（先註冊 settle 監聽）的功能。createFeatures 建到這一項時
// 那些名稱還沒掛在 app 上就丟例外（開站即炸，unit 抓得到），不會靜默換了派發順序。每一組 after 也必須
// 列在 `tests/e2e/offline/listener_order.offline.spec.js` 的 BEFORE（真 boot 量派發順序），由
// `tests/unit/features_table.test.js` 對（兩邊不能各寫各的）。
//
// `after` 也可以指向核心流程（deepLinkController、reconnectResume 這類建構子裡直接 new 的），只要它們
// 在那一次 createFeatures 之前就建好。
//
// 三張表各是建構子裡本來就連在一起的一段，原地換成 createFeatures ⇒ 建構順序與搬之前完全相同。
// 中間夾的 installPullNextArticle／installWheelNextArticle 不是週邊功能物件（只掛 DOM 監聽、沒有 settle），
// 留在建構子裡。核心流程（listSession、aidNavigation…）不進表。草稿見共享資料夾
// research/plans/a6-feature-interface.md。

import { HomeDashboard } from './home_dashboard';
import { WhatsNew } from './whats_new';
import { RecentArticles } from './recent_articles';
import * as prefSync from './pref_sync';
import { CommentBar } from './comment_bar';
import { SearchStatus } from './search_status';
import { FollowOnly } from './follow_only';
import { ListFastScroll } from './list_fast_scroll';
import { EditorInput } from './editor_input';
import { NextArticle } from './next_article';
import { MessageInbox } from './message_inbox';
import { NewComments } from './new_comments';
import { ArticleNav } from './article_nav';
import { BoardTabs } from './board_tabs';

/**
 * @typedef {{ name: string, pref: string, create: (app: any) => any, after?: ReadonlyArray<string> }} FeatureDecl
 */

/** 建構子裡 inputArea 之後那一段（首頁）。 @type {ReadonlyArray<FeatureDecl>} */
export const HOME_FEATURES = Object.freeze([
  // 首頁儀表板（主功能表上的我的最愛／最近看板面板）。要在 inputArea 之後（聽 #t 的按鍵收起面板）；
  // settle 排在 deep link／斷線回原處之後（使用者剛給的連結、斷線前的位置優先於首頁）。
  {
    name: 'homeDashboard',
    pref: 'enableHomeDashboard',
    create: (app) => new HomeDashboard(app),
    after: ['deepLinkController', 'reconnectResume'],
  },
  // 更新後的新功能介紹（首頁儀表板最上面／右下角小卡）。
  { name: 'whatsNew', pref: 'showWhatsNew', create: (app) => new WhatsNew(app) },
  // 最近讀過的文章＋稍後再讀（儀表板／指令面板／右鍵選單共用的清單）。稍後閱讀跨裝置同步
  // （read_later_sync.js）：pref_sync 的 snapshot 交雲端清單過來、變動由它寫回。
  {
    name: 'recentArticles',
    pref: 'enableRecentArticles',
    create: (app) =>
      new RecentArticles(app, undefined, {
        signedIn: () => !!prefSync.getUser(),
        upload: (/** @type {any} */ plan) => prefSync.saveReadLaterEntries(plan),
        subscribe: (/** @type {any} */ cb) => prefSync.registerOnCloudReadLater(cb),
      }),
  },
]);

/** 建構子裡手機找字（articleFind）之後那一段。 @type {ReadonlyArray<FeatureDecl>} */
export const PERIPHERAL_FEATURES = Object.freeze([
  // 好讀文章底部常駐推文列（送出走長推文管線，App.openQuickPush）。
  { name: 'commentBar', pref: 'enableCommentBar', create: (app) => new CommentBar(app) },
  // 搜尋狀態列（搜尋結果列表上方的條件與筆數）。
  { name: 'searchStatus', pref: 'enableSearchStatus', create: (app) => new SearchStatus(app) },
  // 只看關注（文章列表右上角的切換鈕）。
  { name: 'followOnly', pref: 'enableFollowOnly', create: (app) => new FollowOnly(app) },
  // 列表快速捲動把手（P30）：捲動列表好讀時右緣出現，拖動不送鍵、放開跳號。
  { name: 'listFastScroll', pref: 'enableListFastScroll', create: (app) => new ListFastScroll(app) },
  // 編輯器輸入框（P27）：PTT 編輯器畫面用一般文字框打字，按插入走貼上漏斗。
  { name: 'editorInput', pref: 'enableEditorInput', create: (app) => new EditorInput(app) },
  // 讀完接著讀下一篇（好讀文末的下一篇標題卡）。
  { name: 'nextArticle', pref: 'enableNextArticleCard', create: (app) => new NextArticle(app) },
]);

/** 建構子裡下一篇手勢（installPull／WheelNextArticle）之後那一段。 @type {ReadonlyArray<FeatureDecl>} */
export const LATE_PERIPHERAL_FEATURES = Object.freeze([
  // 水球／系統訊息收件匣（這次連線收到的水球與廣播，鈴鐺打開看）。斷線收攤在 App.onClose。
  { name: 'messageInbox', pref: 'enableMessageInbox', create: (app) => new MessageInbox(app) },
  // 新推文標記（重開讀過的文章，上次讀完之後的推文前面一條灰線）；term_view 畫好讀累積頁時
  // 經 app.newComments.rowFor 問那一列。
  { name: 'newComments', pref: 'markNewComments', create: (app) => new NewComments(app) },
  // 導覽軸：下緣要扣掉推文列 ⇒ 同一個 screenSettled 推文列要先更新。
  { name: 'articleNav', pref: 'enableArticleNav', create: (app) => new ArticleNav(app), after: ['commentBar'] },
  // 看板分頁。
  { name: 'boardTabs', pref: 'enableBoardTabs', create: (app) => new BoardTabs(app) },
]);

/** 所有宣告表（給守護測試逐一對）。 */
export const ALL_FEATURE_TABLES = Object.freeze([HOME_FEATURES, PERIPHERAL_FEATURES, LATE_PERIPHERAL_FEATURES]);

/**
 * 照表順序建，掛到 app[name]。`after` 列的功能必須已經建好，否則丟例外。
 * @param {any} app
 * @param {ReadonlyArray<FeatureDecl>} list
 */
export function createFeatures(app, list) {
  for (const f of list) {
    for (const dep of f.after || []) {
      if (app[dep] == null) throw new Error(`features: ${f.name} 要排在 ${dep} 之後，但 ${dep} 還沒建`);
    }
    app[f.name] = f.create(app);
  }
}
