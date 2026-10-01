// 右鍵事件三態處置的**順序**守護（src/js/context_menu_items.js#contextMenuDisposition）。
//
// 背景：ContextMenu/index.jsx 的 onContextMenu 原本第一行就無條件 preventDefault()，
// 於是圖片上的瀏覽器原生選單（另存圖片／複製圖片／以 Google 智慧鏡頭搜尋）整組叫
// 不出來。智慧鏡頭沒有任何網頁可呼叫的 API，唯一入口就是原生選單，所以那道牆只能拆。
//
// 拆的時候多了一個順序陷阱，這支測試就是為它存在的：doDOMMouseScroll（「按住右鍵
// 滾輪翻頁」放開右鍵時補發的那次 contextmenu）**必須先判**。把圖片判斷排到它前面，
// 在圖片上做那個手勢就會走 'native' 直接 return ⇒ 旗標留著 '1' ⇒ 下一次正常右鍵被
// 靜默吞掉一次。症狀是「右鍵選單偶爾叫不出來」，極難回推。
import {
  contextMenuDisposition,
  shouldClearTouchSelection,
} from "../../src/js/context_menu_items";

describe("contextMenuDisposition", () => {
  test("一般文字區、旗標滅 ⇒ 開我們的選單", () => {
    expect(
      contextMenuDisposition({ nativeTarget: false, doDOMMouseScroll: false }),
    ).toBe("menu");
  });

  test("壓在圖片上 ⇒ 放行原生選單", () => {
    expect(
      contextMenuDisposition({ nativeTarget: true, doDOMMouseScroll: false }),
    ).toBe("native");
  });

  test("右鍵滾輪翻頁的殘留事件 ⇒ 吞掉", () => {
    expect(
      contextMenuDisposition({ nativeTarget: false, doDOMMouseScroll: true }),
    ).toBe("swallow");
  });

  // 這條就是順序本身。反過來寫（先判圖片）會讓它變成 'native'。
  test("圖片上做右鍵滾輪手勢 ⇒ 仍是 swallow（旗標必須在這裡被消費掉）", () => {
    expect(
      contextMenuDisposition({ nativeTarget: true, doDOMMouseScroll: true }),
    ).toBe("swallow");
  });
});

// 手機按鍵列的「選取模式」（docs/mobile.md「選取模式」）。
//
// 判斷**只看模式、不看事件來源**：Android Chrome 拖完選取把手放手時會再補發一次
// contextmenu（ShowContextMenuAtTouchHandle → Blink ShowNonLocatedContextMenu），
// 那次是 pointerType 'mouse'、firesTouchEvents false。舊規則要求「觸控＋選取模式」
// ⇒ 那次走 'menu' ⇒ 我們的選單跳出來、原生「複製」工具列被 preventDefault 吃掉。
// 所以這裡的函式簽名刻意不收「是不是觸控」。
describe("選取模式", () => {
  test("手機＋選取模式開 ⇒ 放行原生（選取把手＋複製工具列），不開我們的選單", () => {
    expect(
      contextMenuDisposition({ nativeTarget: false, doDOMMouseScroll: false, mobile: true, selectMode: true }),
    ).toBe("native");
  });

  // REGRESSION：拖完把手補發的那次 contextmenu 沒有任何觸控標記。呼叫端不會也不該
  // 傳 touch 進來；即使把舊參數塞進來表明「這次不是觸控」，結果也必須是 native。
  test("REGRESSION：選取模式開＋非觸控（拖把手後的非定位 contextmenu）⇒ 仍放行原生", () => {
    expect(
      contextMenuDisposition({
        nativeTarget: false,
        doDOMMouseScroll: false,
        mobile: true,
        selectMode: true,
        touchSelectMode: false,
      }),
    ).toBe("native");
  });

  test("選取模式關 ⇒ 照舊開我們的選單", () => {
    expect(
      contextMenuDisposition({ nativeTarget: false, doDOMMouseScroll: false, mobile: true, selectMode: false }),
    ).toBe("menu");
  });

  test("非手機版面 ⇒ 選取模式旗標不算數", () => {
    expect(
      contextMenuDisposition({ nativeTarget: false, doDOMMouseScroll: false, mobile: false, selectMode: true }),
    ).toBe("menu");
  });

  test("右鍵滾輪旗標仍然先判（旗標只在這裡被消費）", () => {
    expect(
      contextMenuDisposition({ nativeTarget: false, doDOMMouseScroll: true, mobile: true, selectMode: true }),
    ).toBe("swallow");
  });

  test("只有「手機＋觸控＋選取模式關」才清掉長按選到的字", () => {
    expect(shouldClearTouchSelection({ mobile: true, touch: true, selectMode: false })).toBe(true);
    expect(shouldClearTouchSelection({ mobile: true, touch: true, selectMode: true })).toBe(false);
    expect(shouldClearTouchSelection({ mobile: true, touch: false, selectMode: false })).toBe(false);
    expect(shouldClearTouchSelection({ mobile: false, touch: true, selectMode: false })).toBe(false);
  });
});
