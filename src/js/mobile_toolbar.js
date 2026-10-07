// 手機底部工具列（components/MobileToolbar）該顯示哪些按鈕 —— 純函式，讀 buf 不讀 DOM。
// App 在每次 screenSettled 算一次、有變才通知元件（App.onScreenContextChange）。
//
//   push   ：在文章裡（pageState 3 且**這一幀**底列真的是 pager 狀態列 ——
//            prompt 幀會沿用舊的 pageState，見 long_push_gate.atPagerStatusRow）、
//            不是站內信（信件 pager 的 X 是別的鍵）。
//   search ：可開的搜尋種類，與鍵盤攔截同一個判準（article_search.availableSearchKinds）。
// 判準刻意不看 enableLongPush：推鈕送的是 X，長推文關掉時就是 PTT 原生推文。

import { parsePagerFooterContext } from './string_util';
import { atPagerStatusRow } from './long_push_gate';
import { availableSearchKinds, searchGateFacts } from './article_search';

export const EMPTY_TOOLBAR_CONTEXT = Object.freeze({ push: false, search: [] });

export function toolbarContextFromFacts(facts, pageState) {
  if (!facts) return EMPTY_TOOLBAR_CONTEXT;
  const last = (facts.rowTexts || [])[facts.rows - 1] || '';
  return {
    push: pageState === 3 && atPagerStatusRow(last) && parsePagerFooterContext(last) !== 'mail',
    search: availableSearchKinds(facts)
  };
}

export function mobileToolbarContext(core) {
  const facts = searchGateFacts(core);
  return toolbarContextFromFacts(facts, core && core.buf ? core.buf.pageState : null);
}

export function sameToolbarContext(a, b) {
  if (!a || !b) return a === b;
  return a.push === b.push && a.search.join(',') === b.search.join(',');
}
