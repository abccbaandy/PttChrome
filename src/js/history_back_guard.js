// 瀏覽器「返回」→ PTT 的左方向鍵（退出文章／回上一層）。
//
// **一種攔法涵蓋所有返回來源**：觸控板左滑手勢、滑鼠側鍵（button 3/4）、
// `Alt+←`／`⌘[`、工具列上一頁、長按上一頁的下拉選單。
//
// 為什麼是 history sentinel 而不是攔事件：
//  * 側鍵在 Chromium／Firefox 多數平台是**在事件送到頁面之前**就導航，
//    `preventDefault` 不可靠（w3c/pointerevents#191 至今未標準化）；
//  * 觸控板手勢**沒有辦法模擬**——`WheelEvent` 不含 macOS `NSEvent` 的 phase／
//    momentumPhase，頁面分不出「手指還在」「放開了」「這是慣性尾巴」⇒「放手才
//    退出」原理上做不到，而原生的返回箭頭是瀏覽器 chrome 畫的、頁面畫不出來。
//    ⇒ 讓瀏覽器自己跑手勢（CSS 不擋 overscroll，見 main.css），我們只在導航
//    真的發生時接住它。詳見 docs/mouse.md「手勢與瀏覽器返回」。
//
// window 是注入的（比照 deep_link_entry.js），unit 給假的即可。
//
// 五個坑，改這支之前先讀：
//  1. **順序**：必須排在 installDeepLink() 的 consume()（history.replaceState 清掉
//     hash）之後。否則 sentinel 會把「還帶著 #Board/AID」的網址留在 stack 裡，
//     使用者按 back 回到那個 URL → hashchange → 又跳一次文。
//  2. **user activation**：Chrome 的 History Manipulation Intervention 會把「該
//     document 從未取得 user activation 時 pushState 出來的 entry」在 back 時直接
//     跳過且不發 popstate ⇒ 使用者直接離站。所以第一層 sentinel 等第一次
//     pointerdown/keydown 才疊。
//  3. **sentinel 補回來只能用 traversal，不可以 pushState**（最重要）：**觸控板
//     返回手勢本身不是 user activation**（只有 click／pointerdown／keydown 等才
//     是）⇒ 在 popstate handler 裡 pushState 出來的那一層同樣會被 intervention
//     標成可跳過 ⇒ **下一次手勢變成完全的 no-op**（沒導航、沒 popstate、也沒
//     離站），實機症狀是「滑一次就失效，要點一下畫面才能再滑一次」。改用
//     history.forward() 走回既有的 entry：traversal 不建立 entry，不受 intervention
//     影響，可以無限次重複。stack 全程維持 [E0, S1]，我們平常站在 S1。
//  4. **sentinel 要帶唯一 id**：popstate 時只有 `state.pttchromeBackGuard === myId`
//     才算「落回自己站著的那一層」。用布林的話，退到 stack 裡**舊的**殘骸
//     sentinel（deep link 的 replaceState／使用者手動操作都可能留下）會被誤判成
//     「沒有往外退」而靜默失效。
//  5. **離站逃生門＝什麼都不做**：放行時停在 E0（不補 sentinel），下一次 back
//     自然離站。**不是** history.go(-1)——開新分頁直接進站時 E0 前面根本沒有
//     entry，go(-1) 是靜默無效。
//     觸發條件是「我們用不到的 back」（navKeyAllowed 擋下）連兩次；**送得出去的
//     back 會重置計數**，否則「文章→列表→看板列表」連退兩層很容易落在同一個
//     時窗內而把使用者丟出站。
import { beginSelfNavigation } from './self_navigation';

export const DOUBLE_BACK_MS = 800;
// forward() 之後多久檢查有沒有真的回到 sentinel（沒有就補一層，否則下一次
// back 直接離站）。
export const RESTORE_CHECK_MS = 120;
export const ESCAPE_HINT = '再按一次「上一頁」可離開本站';

export function installHistoryBackGuard(app, win, opts) {
  const w = win || window;
  const o = opts || {};
  const now = o.now || (() => Date.now());
  const later = o.setTimeout
    || (typeof w.setTimeout === 'function' ? w.setTimeout.bind(w) : setTimeout);

  let seq = 0;
  let myId = 0;
  let armed = false;
  let restoring = false;
  let passThrough = false;
  // 只累計「我們用不到的 back」（見坑 5）。
  let lastBlockedAt = 0;

  // pref 是動態的（設定頁隨時可改）⇒ 每次都重問，不快取。關閉時不疊 sentinel：
  // 疊了卻不攔的話，使用者要按兩次上一頁才離得開，比不裝更糟。
  const gateOn = () => !!(app.mouseGates && app.mouseGates().backNav);

  function pushSentinel() {
    if (!w.history || !w.history.pushState) return false;
    const st = { pttchromeBackGuard: ++seq };
    try {
      w.history.pushState(st, '');
      myId = st.pttchromeBackGuard;
      return true;
    } catch (e) {
      // file:// 之類會 throw —— 沒有 sentinel 就退回瀏覽器原本的行為，不是錯誤。
      return false;
    }
  }

  // sentinel 被消耗掉之後補回來。**用 traversal 走回既有的那一層**（坑 3）。
  function restoreSentinel() {
    const canFwd = w.navigation ? !!w.navigation.canGoForward : true;
    if (!canFwd || !w.history || typeof w.history.forward !== 'function') {
      armed = pushSentinel();
      return;
    }
    restoring = true;
    armed = true;
    // **這一段 traversal 是我們自己造成的**：sentinel 那一格的網址被
    // 「網址列跟著現在在讀哪一篇走」改成過 `#Board/AID`（replaceState 改的正是
    // 我們站著的那一層），走回去會讓 fragment 變動 ⇒ 派發 hashchange ⇒
    // deep_link_entry 會把它當成「使用者又貼了一條連結」而把畫面拉回那篇文章。
    // 見 self_navigation.js。
    const endSelfNav = beginSelfNavigation();
    try {
      w.history.forward();
    } catch (e) {
      endSelfNav();
      restoring = false;
      armed = pushSentinel();
      return;
    }
    // 保險：forward 沒把我們帶回 sentinel（stack 被別人動過）就補一層，否則
    // 下一次 back 直接離站。順便關掉上面的靜音窗口。
    later(() => {
      endSelfNav();
      const st = w.history && w.history.state;
      if (st && st.pttchromeBackGuard) {
        myId = st.pttchromeBackGuard;
        return;
      }
      restoring = false;
      armed = pushSentinel();
    }, RESTORE_CHECK_MS);
  }

  function onActivation() {
    // pref 是後來才打開的話，下一次使用者動作就會補上（listener 刻意常駐）。
    if (!armed && gateOn()) armed = pushSentinel();
  }

  // 長按上一頁的下拉選單可以一次跳好幾層。單看 popstate 分不出「退一層」和
  // 「退五層」⇒ 有 Navigation API（Chrome/Edge/Firefox 都有）時用 index 差算
  // delta，一次跳多層就整個放行不接管。沒有這個 API 的引擎照吃一層。
  function onNavigate(e) {
    if (!e || e.navigationType !== 'traverse') return;
    const nav = w.navigation;
    const from = nav && nav.currentEntry ? nav.currentEntry.index : null;
    const to = e.destination ? e.destination.index : null;
    if (typeof from !== 'number' || typeof to !== 'number') return;
    if (to - from < -1) passThrough = true;
  }

  function onPopState(e) {
    // 我們自己 forward() 回來的那一發，不是使用者的返回。
    if (restoring) {
      restoring = false;
      const st0 = e && e.state;
      if (st0 && st0.pttchromeBackGuard) myId = st0.pttchromeBackGuard;
      return;
    }
    const st = e && e.state;
    // 落回「自己站著的那一層」（例如使用者按了下一頁）不是一次往外退。
    if (st && st.pttchromeBackGuard === myId) return;
    // 退到別的（舊的）sentinel 上：仍然是一次往外退，但要改認新的那一層。
    if (st && st.pttchromeBackGuard) myId = st.pttchromeBackGuard;
    if (!armed) return;
    armed = false;
    // 中途被關掉 ⇒ 放行，這一次 back 就是真的 back。
    if (!gateOn()) return;
    // 一次跳好幾層：讓它真的走，不吃也不補 sentinel。
    if (passThrough) {
      passThrough = false;
      return;
    }
    if (app.sendNavKeyAsUser && app.sendNavKeyAsUser('ArrowLeft')) {
      // 送得出去就不吵（畫面自己會退出文章／列表），也不算逃生門的一次——
      // 連退好幾層是正常操作，不可以因此把使用者丟出站。
      lastBlockedAt = 0;
      restoreSentinel();
      return;
    }
    // 送不出去（未連線／modal／PTT 開著輸入框／pageState 0/5/6）＝這一次 back
    // 我們用不到。第二次就還給瀏覽器：不補 sentinel ⇒ 下一次 back 真的離站。
    const t = now();
    if (lastBlockedAt && t - lastBlockedAt <= DOUBLE_BACK_MS) {
      lastBlockedAt = 0;
      return;
    }
    lastBlockedAt = t;
    restoreSentinel();
    // 這一次 back 等於什麼都沒發生，得告訴使用者怎麼離站，否則就是無聲吞掉輸入。
    if (app.view && app.view.flashListHint) app.view.flashListHint(ESCAPE_HINT);
  }

  w.addEventListener('pointerdown', onActivation, true);
  w.addEventListener('keydown', onActivation, true);
  w.addEventListener('popstate', onPopState);
  if (w.navigation && w.navigation.addEventListener)
    w.navigation.addEventListener('navigate', onNavigate);

  return {
    // pref 關掉時**不自動退回**（那會在使用者沒按上一頁時偷偷改網址），只停止
    // 補 sentinel —— 下一次 back 會被 onPopState 的 gateOn() 放行。
    uninstall() {
      w.removeEventListener('pointerdown', onActivation, true);
      w.removeEventListener('keydown', onActivation, true);
      w.removeEventListener('popstate', onPopState);
      if (w.navigation && w.navigation.removeEventListener)
        w.navigation.removeEventListener('navigate', onNavigate);
      armed = false;
    },
    isArmed() { return armed; }
  };
}

export default installHistoryBackGuard;
