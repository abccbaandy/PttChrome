// 關設定頁（PrefModal 的 X／點外／Esc 全部匯流到 onPrefSaveImpl）會呼叫
// App.switchToEasyReadingMode(view.useEasyReadingMode)。它原本無條件走「離開這篇文章 →
// 清 pageLines → ^L 重繪」那條重置路徑，但使用者可能正停在 PTT 的 prompt 上（X 推文、
// r 回應、y 收暫存檔…），此時好讀是 functionMode（原生鏡像）：
//
//   leaveCurrentPost() 清掉 _functionMode ⇒ ^L 回來的整頁重繪落進好讀文章分支
//   ⇒ 但游標停在輸入欄（非 (rows-1, cols-1)）⇒ accumulatePageLines 的 P6 gate 判 complete=false
//   ⇒ decideAccumulateBranch 回 'skip' ⇒ pageLines 維持 [] ⇒ 渲染 0 列 ⇒ **整頁全黑**，
//   而且之後每一幀游標都在 prompt 上，永遠回不來（實測 100% 複現，只能離開文章再進）。
//
// 修法：鏡像原生時關設定只重繪，不碰任何好讀狀態。決策抽成純函式在此守護。
import { switchModePlan } from "../../src/js/easy_reading";

test("REGRESSION：鏡像原生（推文 prompt）時關設定 → 什麼都不重置，只重繪", () => {
  const plan = switchModePlan({ doSwitch: true, functionMode: true, pageState: 3 });
  expect(plan.leavePost).toBe(false);
  expect(plan.clearPageLines).toBe(false);
  expect(plan.restoreNativeView).toBe(false);
  // 方向鍵在 vgets 裡是移動輸入游標（實測回 BEL），prompt 上一個 byte 都不該多送。
  expect(plan.cursorNudge).toBe(false);
});

test("好讀開著且在文章（非鏡像）：維持原本的重置＋游標 nudge", () => {
  const plan = switchModePlan({ doSwitch: true, functionMode: false, pageState: 3 });
  expect(plan.leavePost).toBe(true);
  expect(plan.clearPageLines).toBe(true);
  expect(plan.restoreNativeView).toBe(false);
  expect(plan.cursorNudge).toBe(true);
});

test("好讀開著但不在文章：不送游標 nudge（原本就用 pageState==3 gate）", () => {
  const plan = switchModePlan({ doSwitch: true, functionMode: false, pageState: 2 });
  expect(plan.leavePost).toBe(true);
  expect(plan.cursorNudge).toBe(false);
});

test("好讀關閉：還原原生畫面（overlay/padding/pageLines）", () => {
  const plan = switchModePlan({ doSwitch: false, functionMode: false, pageState: 3 });
  expect(plan.restoreNativeView).toBe(true);
  expect(plan.leavePost).toBe(true);
  expect(plan.clearPageLines).toBe(true);
  expect(plan.cursorNudge).toBe(false);
});

test("好讀關閉 + 殘留 functionMode：仍走還原路徑（leaveCurrentPost 負責清旗標）", () => {
  // 設定頁裡把好讀關掉時 doSwitch 變 false；此時一定要重置，否則 _functionMode
  // 留在 true 會同時廢掉自動重入與 End/F8 手動切回兩條路。
  const plan = switchModePlan({ doSwitch: false, functionMode: true, pageState: 3 });
  expect(plan.leavePost).toBe(true);
  expect(plan.restoreNativeView).toBe(true);
});
