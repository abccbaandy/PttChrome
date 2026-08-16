// functionMode 只在好讀**開著**時才有意義。
//
// functionMode 是好讀模式的一種渲染狀態：term_view.redraw 的分支條件是
// `useEasyReadingMode && buf.easyReadingFunctionMode`，而它唯一的出口
// _evalFunctionModeExit 只能經 _onScreenSettled 進入 —— 那裡第一行就是
// `if (!this._enabled) { _maybeReenterOnNewArticle(); return; }`。
//
// 所以在好讀關閉時設這個旗標：畫面上什麼都不會變，卻**永遠清不掉**，而且一次就
// 同時廢掉兩條回到好讀的路：
//   - nextEasyReadingReentry 的 functionMode gate（自動重入）
//   - term_view.onKeyDown 的 `!buf.easyReadingFunctionMode` gate → tryReenterFromNative
//     （End/F8 手動切回）
//
// 冷啟動 deep link 就是這樣把整個 session 鎖死在原生模式的：aid_navigation._begin
// 無條件呼叫 _enterFunctionMode()，而那時使用者根本還沒開過任何一篇文章，_enabled
// 是 false。實測 2026-08-16：「deep link 跳轉後有時不會進入好讀模式」。

import { EasyReading } from "../../src/js/easy_reading";

function harness({ enabled = true, scrollTop = 300 } = {}) {
  const buf = {
    easyReadingFunctionMode: false,
    lineChangeds: { fill: () => {} },
    changed: false,
    notifyCalls: 0,
    notify() {
      this.notifyCalls++;
    }
  };
  const ctx = {
    _enabled: enabled,
    sendCommandAfterUpdate: "\x1b[6~",
    _savedScrollTop: null,
    _view: { mainDisplay: { scrollTop } },
    _termBuf: buf
  };
  // 真實物件用 bindProperty 把 _functionMode 綁到 buf.easyReadingFunctionMode
  // （term_view 就是讀 buf 上那個）。假 ctx 也照做，否則測不到跨物件的那一半。
  Object.defineProperty(ctx, "_functionMode", {
    get: () => buf.easyReadingFunctionMode,
    set: v => {
      buf.easyReadingFunctionMode = v;
    }
  });
  return { ctx, buf };
}

const enterFunctionMode = ctx => EasyReading.prototype._enterFunctionMode.call(ctx);

test("REGRESSION：好讀關閉時 _enterFunctionMode 是 no-op（旗標不可留下）", () => {
  const h = harness({ enabled: false });
  enterFunctionMode(h.ctx);
  // 留下 true 就再也清不掉：_onScreenSettled 在 !_enabled 時早退，永遠跑不到
  // _evalFunctionModeExit。
  expect(h.buf.easyReadingFunctionMode).toBe(false);
});

test("好讀關閉時也不該有任何副作用（不重畫、不吃掉 pending 指令）", () => {
  const h = harness({ enabled: false });
  enterFunctionMode(h.ctx);
  expect(h.buf.notifyCalls).toBe(0);
  expect(h.ctx._savedScrollTop).toBeNull();
});

test("好讀關閉 + 已呼叫過 → term_view 的 End/F8 重入 gate 仍成立", () => {
  // 症狀層代理：term_view.onKeyDown 進 tryReenterFromNative 的前提就是
  // `!useEasyReadingMode && !buf.easyReadingFunctionMode && pageState === 3`。
  const h = harness({ enabled: false });
  enterFunctionMode(h.ctx);
  const canReenterByKey = !h.ctx._enabled && !h.buf.easyReadingFunctionMode;
  expect(canReenterByKey).toBe(true);
});

test("好讀開著：照常進入，存下捲動位置並重畫", () => {
  const h = harness({ enabled: true, scrollTop: 300 });
  enterFunctionMode(h.ctx);
  expect(h.buf.easyReadingFunctionMode).toBe(true);
  expect(h.ctx._savedScrollTop).toBe(300);
  expect(h.ctx.sendCommandAfterUpdate).toBe(""); // in-flight 的自動翻頁要丟掉
  expect(h.buf.notifyCalls).toBe(1);
});

test("好讀開著且已在 functionMode：重複呼叫不覆蓋已存的捲動位置", () => {
  const h = harness({ enabled: true, scrollTop: 300 });
  enterFunctionMode(h.ctx);
  h.ctx._view.mainDisplay.scrollTop = 0; // 已經被 redraw 歸零
  enterFunctionMode(h.ctx);
  expect(h.ctx._savedScrollTop).toBe(300);
  expect(h.buf.notifyCalls).toBe(1);
});
