// 手機 App Bar：點標題捲回頂端（pref mobileAppBarScrollTop，預設開；docs/mobile.md「App Bar」）。
// 手機 App 的慣例（iOS 點狀態列、Android 點標題列）。**只捲畫面，自己一個 byte 都不送**；
// 列表捲到頂之後照平常往上捲的規則補頁，那是列表 session 的事，跟手指滑到頂一樣。
//
// 捲哪一個容器（看得到的那一層優先）：
//   1. 首頁儀表板開著 ⇒ 它自己的捲動容器（蓋在主功能表上面）。
//   2. 卡片列表的視口在 DOM 上 ⇒ 走 screen.scrollListTo：列表有頂端保留區，直接寫
//      scrollTop 會殺掉平滑動畫，也會把保留區算進去（見 render/screen.js）。
//   3. 其餘（好讀文章、原生畫面）⇒ view.mainDisplay。
// 回傳捲了哪一個（'home'／'list'／'main'），已經在頂端或沒有可捲的回傳 null。
import { HOME_DASHBOARD_ID } from './home_dashboard';

export function scrollContentToTop({ doc, view, reducedMotion }) {
  const smooth = !reducedMotion;
  const home = doc.getElementById(HOME_DASHBOARD_ID);
  // 看得到＝有 client rect（面板是 position:fixed，offsetParent 恆為 null，不能拿來判斷）。
  if (home && home.getClientRects().length > 0) {
    if (home.scrollTop <= 0) return null;
    home.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
    return 'home';
  }
  const screen = view && view.componentScreen;
  if (screen && screen.hasListViewport && screen.hasListViewport()) {
    if (screen.getListScrollTop() <= 0) return null;
    screen.scrollListTo(0, smooth ? 'smooth' : undefined);
    return 'list';
  }
  const disp = view && view.mainDisplay;
  if (!disp || disp.scrollTop <= 0) return null;
  disp.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
  return 'main';
}
