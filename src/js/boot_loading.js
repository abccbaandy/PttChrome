// 開站載入提示（index.html 的 #bootLoading）。
//
// 為什麼要有：HTTP 快取沒命中（清快取、Pages 新部署換了 hash）時，主程式要從 GitHub Pages
// 重抓，手機上實測可到 5–10 秒，期間原本是一片黑（docs/android-app.md 狀態表「冷啟動黑畫面」）。
//
// 進度是**分段**的，不是位元組進度：瀏覽器不讓頁面讀 module script 的下載進度，自己 fetch
// 一份來量會重複下載、反而拖慢。所以第一段（下載程式）在 index.html 內就顯示，之後由本模組
// 往後推；元素、樣式、第一段文字全部 inline 在 index.html，零額外請求。
//
// 生命週期：startApp 決定好要不要連線（deep link 交接）時 finishBootLoading() 拆掉；
// 載入資源失敗時 failBootLoading() 改成錯誤訊息（以前只寫 console，畫面永遠是黑的）。

const ID = 'bootLoading';

// i18n 模組此時還沒初始化（它在 startApp 才 setup），文字只有這幾句，直接依瀏覽器語系。
const zh = () =>
  typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '');

const STAGES = {
  resources: { pct: 75, zh: '載入字型與轉碼表…', en: 'Loading fonts and tables…' },
  starting: { pct: 95, zh: '啟動中…', en: 'Starting…' }
};

function el(part) {
  if (typeof document === 'undefined') return null;
  const root = document.getElementById(ID);
  if (!root || !part) return root;
  return root.querySelector('[data-boot="' + part + '"]');
}

export function setBootStage(name) {
  const stage = STAGES[name];
  const bar = el('bar');
  const label = el('label');
  if (!stage || !bar || !label) return;
  bar.style.width = stage.pct + '%';
  label.textContent = zh() ? stage.zh : stage.en;
}

export function failBootLoading() {
  const root = el();
  const label = el('label');
  if (!root || !label) return;
  root.setAttribute('data-failed', '');
  label.textContent = zh()
    ? '載入失敗，請重新整理頁面。'
    : 'Failed to load. Please reload the page.';
}

export function finishBootLoading() {
  const root = el();
  if (root) root.remove();
}
