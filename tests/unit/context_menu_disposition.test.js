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
import { contextMenuDisposition } from "../../src/js/context_menu_items";

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
