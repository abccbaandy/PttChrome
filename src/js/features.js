// @ts-check
// 週邊功能宣告表（架構 review A6「功能註冊表與明確的執行階段」第一批）。
//
// 一個週邊功能＝App 上一個屬性（name，也是 owner 標籤）＋一個開關（pref，DEFAULT_PREFS 鍵；
// 故障停用時 `buf.addEventListener(…, { feature })` 登記的就是它）＋建構函式。App 建構子照陣列
// 順序建 ⇒ **陣列順序就是 settle 派發順序**（建構子裡註冊監聽）。
//
// 目前搬進來的是建構子裡本來就連在一起的一段（searchStatus～nextArticle），原地換成一行
// createFeatures ⇒ 建構順序與搬之前完全相同。之後要搬有先後依賴的（commentBar／articleNav），
// 先在這裡加 `after` 並由表產生 listener_order 的 BEFORE（草稿見共享資料夾
// research/plans/a6-feature-interface.md）。核心流程（listSession、aidNavigation…）不進表。
//
// 守護：tests/unit/features_table.test.js。

import { SearchStatus } from './search_status';
import { FollowOnly } from './follow_only';
import { ListFastScroll } from './list_fast_scroll';
import { EditorInput } from './editor_input';
import { NextArticle } from './next_article';

/**
 * @typedef {{ name: string, pref: string, create: (app: any) => any }} FeatureDecl
 */

/** 建構子裡 commentBar 之後那一段（commentBar／articleNav 有先後依賴，還沒進表）。 @type {ReadonlyArray<FeatureDecl>} */
export const PERIPHERAL_FEATURES = Object.freeze([
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

/**
 * 照表順序建，掛到 app[name]。
 * @param {any} app
 * @param {ReadonlyArray<FeatureDecl>} list
 */
export function createFeatures(app, list) {
  for (const f of list) app[f.name] = f.create(app);
}
