// 好讀模式下按 X 推文，「有時」看不到推文輸入框——但字確實送出去了（切回原生就看得到）。
//
// 根因：讓 X 切成原生鏡像（functionMode）的唯一路徑是 keydown ——
// easy_reading._onKeyDown 的 default 分支 `if (e.key.length === 1) _enterFunctionMode()`。
// 中文 IME 開著時 keydown 的 e.key 是 'Process'（keyCode 229），length !== 1 → 進不去；
// 字元改由 input 事件走 term_view.onInput → onTextInput → _convSend 送出。
// 於是 PTT 開了推文 prompt（只 patch 最後一列），好讀長頁卻原封不動 ⇒ 看不到輸入框。
//
// App.onPasteDone 早就為「貼上不是 keypress」補過同一刀；這裡把共用漏斗 onTextInput
// 也補上，keydown／IME／貼上三條入口對 functionMode 行為一致。
import { EasyReading } from "../../src/js/easy_reading";

function harness({ enabled = true, startedEasyReading = true } = {}) {
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
    startedEasyReading,
    sendCommandAfterUpdate: "",
    _savedScrollTop: null,
    _view: { mainDisplay: { scrollTop: 120 } },
    _termBuf: buf,
    // 真實實作：noteTextInput 的重點就是「有沒有正確接上 _enterFunctionMode」。
    _enterFunctionMode: EasyReading.prototype._enterFunctionMode
  };
  Object.defineProperty(ctx, "_functionMode", {
    get: () => buf.easyReadingFunctionMode,
    set: v => {
      buf.easyReadingFunctionMode = v;
    }
  });
  return { ctx, buf };
}

const noteTextInput = ctx => EasyReading.prototype.noteTextInput.call(ctx);

test("REGRESSION：好讀文章中送出文字（IME 的 X）→ 切進原生鏡像", () => {
  const h = harness();
  noteTextInput(h.ctx);
  expect(h.buf.easyReadingFunctionMode).toBe(true);
  expect(h.ctx._savedScrollTop).toBe(120); // 之後 'resume' 要靠它捲回原閱讀位置
  expect(h.buf.notifyCalls).toBe(1);
});

test("好讀關著：no-op（旗標留下就再也清不掉，見 function_mode_gate）", () => {
  const h = harness({ enabled: false });
  noteTextInput(h.ctx);
  expect(h.buf.easyReadingFunctionMode).toBe(false);
  expect(h.buf.notifyCalls).toBe(0);
});

test("好讀開著但沒有文章開著（列表／選單）：no-op", () => {
  const h = harness({ startedEasyReading: false });
  noteTextInput(h.ctx);
  expect(h.buf.easyReadingFunctionMode).toBe(false);
  expect(h.buf.notifyCalls).toBe(0);
});

test("已在鏡像中重複送字：不覆蓋已存的捲動位置、不重複重畫", () => {
  const h = harness();
  noteTextInput(h.ctx);
  h.ctx._view.mainDisplay.scrollTop = 0; // 已被 redraw 歸零
  noteTextInput(h.ctx);
  expect(h.ctx._savedScrollTop).toBe(120);
  expect(h.buf.notifyCalls).toBe(1);
});
