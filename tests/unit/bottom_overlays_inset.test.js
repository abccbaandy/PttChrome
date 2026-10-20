// @unit-env browser
// 畫面底部的浮動提示（flashListHint、「讀取中…」、T2 的說明列與輸入框）必須讓開底部
// 常駐的東西：手機的底部工具列（z-index 2500，比提示高）、手勢列 safe-area、軟鍵盤。
// 症狀：手機上「讀取中…」（bottom:16px）整個被工具列蓋住，點文章之後看不到任何回應；
// 跳號輸入框（bottom:88px）被軟鍵盤蓋住，看不到自己打的字。
// 位置來源是 App._onVisualViewport 寫的 --term-bottom-inset（＝終端機的底部 inset）。
import { TermView } from "../../src/js/term_view";

const INSET = 300;
const root = document.documentElement;
let view;

beforeEach(() => {
  root.style.setProperty("--term-bottom-inset", INSET + "px");
  view = Object.create(TermView.prototype);
  view.showStatusHints = true;
});
afterEach(() => {
  root.style.removeProperty("--term-bottom-inset");
  for (const el of [view._listHintEl, view._listLoadingEl, view._listOverlayEl, view._listInputWrap])
    if (el) el.remove();
  if (view._listHintTimer) clearTimeout(view._listHintTimer);
});

const coveredLine = () => window.innerHeight - INSET;

test("flashListHint 排在底部 inset 上方", () => {
  view.flashListHint("提示");
  expect(view._listHintEl.getBoundingClientRect().bottom).toBeLessThanOrEqual(coveredLine());
});

test("「讀取中…」排在底部 inset 上方", () => {
  view.setListLoading(true);
  expect(view._listLoadingEl.getBoundingClientRect().bottom).toBeLessThanOrEqual(coveredLine());
});

test("T2 說明列與輸入框排在底部 inset 上方", () => {
  view.showListOverlay("說明");
  expect(view._listOverlayEl.getBoundingClientRect().bottom).toBeLessThanOrEqual(coveredLine());
  view.promptListInput("跳到", "", () => {});
  expect(view._listInputWrap.getBoundingClientRect().bottom).toBeLessThanOrEqual(coveredLine());
});

test("沒有 inset（桌機）⇒ 維持原本離底的距離", () => {
  root.style.removeProperty("--term-bottom-inset");
  view.flashListHint("提示");
  view.setListLoading(true);
  expect(window.innerHeight - view._listHintEl.getBoundingClientRect().bottom).toBeCloseTo(48, 0);
  expect(window.innerHeight - view._listLoadingEl.getBoundingClientRect().bottom).toBeCloseTo(16, 0);
});
