// 手機文章 App Bar 的「檔頭看不看得到」（P58，pref mobileAppBarArticleDetail）。
// 檔頭卡片（render/article_meta_card.js 的標題列 .articleMeta--title）還在畫面上 ⇒ 標題已經
// 看得到，App Bar 只寫看板；捲出畫面 ⇒ App Bar 換成標題，副標「作者 · 看板 · 時間」
// （mobile_app_bar.articleDetail）。只讀版面、不送鍵。
//
// 好讀累積長頁的列住在 content-visibility 分塊裡（docs/easy-reading.md「長頁分塊」）：
// 被跳過的分塊裡的元素量不到尺寸（高 0）⇒ 一律當成看不到（它本來就遠在畫面外）。

export const ARTICLE_HEADER_SELECTOR = '#mainContainer .articleMeta--title';

// true／false；找不到檔頭卡片（不是手機好讀換行版面、或不是首頁開始讀）⇒ null。
export function articleHeaderVisible(doc, barBottom) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d) return null;
  const el = d.querySelector(ARTICLE_HEADER_SELECTOR);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!(r.height > 0)) return false;
  const win = d.defaultView;
  const bottomEdge = win ? win.innerHeight : Infinity;
  return r.bottom > (barBottom || 0) && r.top < bottomEdge;
}

// App Bar 實際顯示的兩行。enabled＝pref；headerVisible＝上面的結果。
export function articleBarText(appBar, headerVisible, enabled) {
  const a = appBar || {};
  if (!enabled || a.kind !== 'article') return { title: a.title || '', subtitle: a.subtitle || '' };
  // 標題看得到 ⇒ 只寫看板（站內信沒有看板 ⇒ 照舊寫標題）。
  if (headerVisible === true) return { title: a.subtitle || a.title || '', subtitle: '' };
  return { title: a.title || '', subtitle: a.detail || a.subtitle || '' };
}
