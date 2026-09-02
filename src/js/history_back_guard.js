// 瀏覽器「上一頁」→ PTT 的左方向鍵（退出文章／列表）。
//
// 為什麼是 history sentinel 而不是攔事件：滑鼠側鍵（MouseEvent.button 3/4）在
// Chromium／Firefox 多數平台是**在事件送到頁面之前**就導航，preventDefault 不可
// 靠（w3c/pointerevents#191 至今未標準化）。唯一跨瀏覽器可行的是「先疊一層自己的
// history entry，back 真的發生時把它吃掉」。同一條路順便涵蓋 Alt+← / ⌘[ / 工具列
// 上一頁；觸控板手勢**不**走這裡（那條走 CSS + wheel 辨識，零動畫零 history 汙染，
// 見 swipe_gesture.js 與 docs/mouse.md）。
//
// window 是注入的（比照 deep_link_entry.js），unit 給假的即可。
//
// 三個坑，改這支之前先讀：
//  1. **順序**：必須排在 installDeepLink() 的 consume()（history.replaceState 清掉
//     hash）之後。否則 sentinel 會把「還帶著 #Board/AID」的網址留在 stack 裡，
//     使用者按 back 回到那個 URL → hashchange → 又跳一次文。
//  2. **user activation**：Chrome 的 History Manipulation Intervention 會把「該
//     document 從未取得 user activation 時 pushState 出來的 entry」在 back 時直接
//     跳過且不發 popstate ⇒ 使用者直接離站。所以 sentinel 等第一次 pointerdown/
//     keydown 才疊。
//  3. **離站逃生門**：sentinel 讓 back 永遠退不出站。800ms 內第二次 back 就放行
//     （不補 sentinel、直接 history.go(-1)）。
export const SENTINEL = { pttchromeBackGuard: 1 };
export const DOUBLE_BACK_MS = 800;
export const ESCAPE_HINT = '再按一次「上一頁」可離開本站';

export function installHistoryBackGuard(app, win, opts) {
  const w = win || window;
  const o = opts || {};
  const now = o.now || (() => Date.now());

  let hasActivation = false;
  let armed = false;
  let lastBackAt = 0;

  // pref 是動態的（設定頁隨時可改）⇒ 每次都重問，不快取。關閉時不疊 sentinel：
  // 疊了卻不攔的話，使用者要按兩次上一頁才離得開，比不裝更糟。
  const gateOn = () => !!(app.mouseGates && app.mouseGates().backButton);

  function pushSentinel() {
    if (!w.history || !w.history.pushState) return false;
    try {
      w.history.pushState(SENTINEL, '');
      return true;
    } catch (e) {
      // file:// 之類會 throw —— 沒有 sentinel 就退回瀏覽器原本的行為，不是錯誤。
      return false;
    }
  }

  function onActivation() {
    hasActivation = true;
    // pref 是後來才打開的話，下一次使用者動作就會補上（listener 刻意常駐）。
    if (!armed && gateOn()) armed = pushSentinel();
  }

  function onPopState(e) {
    const st = e && e.state;
    // 落在 sentinel 上（例如使用者按了「下一頁」回到它）不是一次「往外退」。
    if (st && st.pttchromeBackGuard) return;
    if (!armed) return;
    armed = false;
    // 中途被關掉 ⇒ 放行，這一次 back 就是真的 back。
    if (!gateOn()) return;
    const t = now();
    if (lastBackAt && t - lastBackAt <= DOUBLE_BACK_MS) {
      // 逃生門：連按兩次就離站（不補 sentinel，go(-1) 越過我們這一層）。
      lastBackAt = 0;
      try { w.history.go(-1); } catch (err) { /* 沒有上一頁可去，忽略 */ }
      return;
    }
    lastBackAt = t;
    armed = pushSentinel();
    const sent = !!(app.sendNavKeyAsUser && app.sendNavKeyAsUser('ArrowLeft'));
    // 送得出去就不吵（畫面自己會退出文章／列表）；被守門擋下時這一次 back 等於
    // 什麼都沒發生，得告訴使用者怎麼離站，否則就是無聲吞掉輸入。
    if (!sent && app.view && app.view.flashListHint) app.view.flashListHint(ESCAPE_HINT);
  }

  w.addEventListener('pointerdown', onActivation, true);
  w.addEventListener('keydown', onActivation, true);
  w.addEventListener('popstate', onPopState);

  return {
    // pref 關掉時**不自動退回**（那會在使用者沒按上一頁時偷偷改網址），只停止
    // 補 sentinel —— 下一次 back 會被 onPopState 的 gateOn() 放行。
    uninstall() {
      w.removeEventListener('pointerdown', onActivation, true);
      w.removeEventListener('keydown', onActivation, true);
      w.removeEventListener('popstate', onPopState);
      armed = false;
    },
    isArmed() { return armed; }
  };
}

export default installHistoryBackGuard;
