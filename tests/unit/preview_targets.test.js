// 「這一下壓在哪」的兩組判準（src/js/preview_targets.js）。
//
// 兩條選擇器**刻意不同**，這支測試守的就是那個差別：
//   PREVIEW_CLICK_SELECTOR  整寬區塊（含 slot 與載入中／失敗提示）—— 用來擋「點了
//                           就離開文章」的左側手勢，寧可寬。
//   NATIVE_MENU_SELECTOR    只有真的 <img> —— 放行原生選單只該在指標壓在圖片像素上
//                           時成立。用寬的那條會讓圖片那一整列都失去我們的選單。
// 兩者混用過一次就回不去了（沒有任何症狀會立刻現形），所以在這裡釘死。
import {
  isNativeMenuTarget,
  isPreviewTarget,
} from "../../src/js/preview_targets";

const make = (html) => {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.firstElementChild;
};

describe("isNativeMenuTarget（放行瀏覽器原生選單）", () => {
  test("內嵌預覽圖 ⇒ 命中", () => {
    expect(
      isNativeMenuTarget(make('<img class="easyReadingImg hyperLinkPreview">')),
    ).toBe(true);
  });

  test("佔位盒本身（圖片左右的留白）⇒ 不命中", () => {
    const slot = make('<div class="inlinePreviewSlot"></div>');
    expect(isNativeMenuTarget(slot)).toBe(false);
    // 對照：整寬那條**會**命中，兩者確實不同。
    expect(isPreviewTarget(slot)).toBe(true);
  });

  test("替身盒（div.easyReadingImg）⇒ 不命中（沒有圖可另存）", () => {
    expect(
      isNativeMenuTarget(make('<div class="easyReadingImg inlinePreviewGhost">')),
    ).toBe(false);
  });

  test("影片／iframe ⇒ 不命中（有自己的原生控制項／是第三方頁面）", () => {
    expect(
      isNativeMenuTarget(make('<video class="easyReadingVideo"></video>')),
    ).toBe(false);
    expect(isNativeMenuTarget(make("<iframe></iframe>"))).toBe(false);
  });

  test("一般文字 span ⇒ 不命中（右鍵照舊開我們的選單）", () => {
    expect(isNativeMenuTarget(make('<span type="bbsrow">推文</span>'))).toBe(
      false,
    );
  });

  test("空值不炸（事件可能沒有 target）", () => {
    expect(isNativeMenuTarget(null)).toBe(false);
    expect(isNativeMenuTarget(undefined)).toBe(false);
    expect(isNativeMenuTarget({})).toBe(false);
  });
});
