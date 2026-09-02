// term_view.onTextInput ＝「使用者送了一段文字給 PTT」的**共用漏斗**（IME 組字送出、
// 一般輸入、以及貼上的最後一段）。三條入口對「要不要先切成原生鏡像」必須行為一致，
// 否則就會出現「看不到輸入框，字卻真的送出去了」。
//
// 文章好讀那一半（easyReading.noteTextInput）2026-08 已補；列表好讀那一半漏掉，
// 症狀＝在列表好讀下切中文輸入法打字，畫面看起來整個卡住（PTT 的 prompt 被累積
// 緩衝視窗蓋住）。本檔釘住漏斗的分派規則。
import { TermView } from "../../src/js/term_view";

function makeCtx({ listTakes = false, hasEasyReading = true, hasListSession = true } = {}) {
  const calls = { convSend: [], easyNote: 0, listNote: [] };
  const listSession = hasListSession
    ? {
        noteTextInput(text) {
          calls.listNote.push(text);
          return listTakes;
        },
      }
    : null;
  const ctx = {
    lineWrap: 0,
    bbscore: {
      easyReading: hasEasyReading
        ? {
            noteTextInput() {
              calls.easyNote++;
            },
          }
        : null,
      listSession,
      // 分派的唯一真相源：term_view 只問 App.activeListSession「現在誰在畫列表」。
      activeListSession: () => listSession,
    },
    _convSend(text) {
      calls.convSend.push(text);
    },
  };
  return { ctx, calls };
}

const onTextInput = (ctx, text, isPasting) =>
  TermView.prototype.onTextInput.call(ctx, text, isPasting);

describe("onTextInput 的分派", () => {
  test("REGRESSION：listSession 接手（回 true）→ 不得再裸送，也不碰文章好讀", () => {
    const { ctx, calls } = makeCtx({ listTakes: true });
    onTextInput(ctx, "測試");
    expect(calls.listNote).toEqual(["測試"]);
    expect(calls.convSend).toEqual([]); // 接手了還送＝送兩次
    expect(calls.easyNote).toBe(0); // 兩個模式不可能同時擁有畫面
  });

  test("listSession 不接手（回 false）→ 走原路：文章好讀鉤子＋裸送", () => {
    const { ctx, calls } = makeCtx({ listTakes: false });
    onTextInput(ctx, "測試");
    expect(calls.listNote).toEqual(["測試"]);
    expect(calls.easyNote).toBe(1);
    expect(calls.convSend).toEqual(["測試"]);
  });

  test("貼上（isPasting）→ 不得再問 listSession（App.onPasteDone 已問過，會送兩次）", () => {
    const { ctx, calls } = makeCtx({ listTakes: true });
    onTextInput(ctx, "貼上內容", true);
    expect(calls.listNote).toEqual([]);
    expect(calls.convSend.length).toBe(1); // 仍走原生貼上路徑
  });

  test("沒有 listSession（尚未建立）不炸", () => {
    const { ctx, calls } = makeCtx({ hasListSession: false });
    expect(() => onTextInput(ctx, "測試")).not.toThrow();
    expect(calls.convSend).toEqual(["測試"]);
  });
});

// onInput 的 IME 特判（easyReadingKeyDownKeyCode == 229）是**不可達的死碼**：
// 唯一寫入點在 onKeyDown 內，而 keyEventFilter 第一條就 `if (e.keyCode == 229)
// return false` ⇒ 該欄位永遠不可能是 229。它的語意是「IME 開著時除了 X 以外的
// 字元一律靜默丟棄」，與現行「keydown／IME／貼上三個入口一致」的設計直接衝突。
// 本測試釘的是**刪除後**的契約：onInput 不看 keyCode，任何字元都往漏斗走。
describe("onInput 不因 IME 丟棄字元", () => {
  function inputCtx() {
    const got = [];
    const ctx = {
      bbscore: { modalShown: false, contextMenuShown: false },
      isComposition: false,
      useEasyReadingMode: true,
      buf: { startedEasyReading: true },
      easyReadingKeyDownKeyCode: 229, // 產品路徑上構不出來，這裡刻意設
      updateInputBufferWidth() {},
      onTextInput(text) {
        got.push(text);
      },
    };
    return { ctx, got };
  }

  test("好讀文章中用 IME 打出非 X 的字 → 必須送進 onTextInput，不得吞掉", () => {
    const { ctx, got } = inputCtx();
    const e = { target: { value: "中" } };
    TermView.prototype.onInput.call(ctx, e);
    expect(got).toEqual(["中"]);
    expect(e.target.value).toBe("");
  });

  test("組字進行中（isComposition）仍只更新寬度，不送字", () => {
    const { ctx, got } = inputCtx();
    ctx.isComposition = true;
    TermView.prototype.onInput.call(ctx, { target: { value: "ㄘ" } });
    expect(got).toEqual([]);
  });
});
