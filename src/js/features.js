// @ts-check
// 週邊功能宣告表（架構 review A6「功能註冊表與明確的執行階段」第一批）。
//
// 一個週邊功能＝App 上一個屬性（name，也是 owner 標籤）＋一個開關（pref，DEFAULT_PREFS 鍵；
// 故障停用時 `buf.addEventListener(…, { feature })` 登記的就是它）＋建構函式。App 建構子照陣列
// 順序建 ⇒ **陣列順序就是 settle 派發順序**（建構子裡註冊監聽）。
//
// 第一批只搬「跟前後沒有先後依賴、建構子裡本來就連在一起」的三個，原地換成一行
// createFeatures ⇒ 建構順序與搬之前完全相同。之後要搬有先後依賴的（commentBar／articleNav），
// 先在這裡加 `after` 並由表產生 listener_order 的 BEFORE（草稿見共享資料夾
// research/plans/a6-feature-interface.md）。核心流程（listSession、aidNavigation…）不進表。
//
// 守護：tests/unit/features_table.test.js。

import { FollowOnly } from './follow_only';
import { ListFastScroll } from './list_fast_scroll';
import { EditorInput } from './editor_input';

/**
 * @typedef {{ name: string, pref: string, create: (app: any) => any }} FeatureDecl
 */

/** 建構子裡 searchStatus 之後、nextArticle 之前那一段。 @type {ReadonlyArray<FeatureDecl>} */
export const LIST_TOOL_FEATURES = Object.freeze([
  // 只看關注（文章列表右上角的切換鈕）。
  { name: 'followOnly', pref: 'enableFollowOnly', create: (app) => new FollowOnly(app) },
  // 列表快速捲動把手（P30）：捲動列表好讀時右緣出現，拖動不送鍵、放開跳號。
  { name: 'listFastScroll', pref: 'enableListFastScroll', create: (app) => new ListFastScroll(app) },
  // 編輯器輸入框（P27）：PTT 編輯器畫面用一般文字框打字，按插入走貼上漏斗。
  { name: 'editorInput', pref: 'enableEditorInput', create: (app) => new EditorInput(app) },
]);

/**
 * 照表順序建，掛到 app[name]。
 * @param {any} app
 * @param {ReadonlyArray<FeatureDecl>} list
 */
export function createFeatures(app, list) {
  for (const f of list) app[f.name] = f.create(app);
}
