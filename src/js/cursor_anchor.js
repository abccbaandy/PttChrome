// 閃爍游標 #cursor 的位置決策（純函式，無 DOM／無副作用）。
//
// 為什麼要獨立成一支：這個座標算過三輪都還會復發（cbee3f5 → 865b828 → 把 #cursor
// 搬進 `.main`），每一輪拆掉的都是一個「補償項」。最後一層補償是**算術模型本身**——
// 舊版直接寫 `cur_y * chh`，那是「這一列**應該**在哪」；使用者看到的則是瀏覽器
// layout 算出來的「這一列**實際**在哪」。兩者之間沒有任何守門，於是只要有任何一列
// 的 line box 被撐大（標註、inline-block 的 baseline、`#mainContainer` 多了 padding、
// 字型還沒落地…）游標就整批偏移，症狀就是「推文時游標戳出反白輸入匡」。
//
// 這裡的規則：**有真實列節點就以它為錨**（`rowOffsetTop/Left` 由呼叫端量測，
// offsetParent 是 `.main`，與 #cursor 同一個座標系）；量不到才退回舊算術。
// 垂直自此結構性正確；水平仍是 `cur_x * chw`（沒有逐格節點可錨），由等寬字型契約
// 保護（ASCII advance 0.5em、全形走 .wpadding 強制 chh px）。
//
// 守護：tests/unit/cursor_anchor.test.js、tests/e2e/offline/cursor_shape.offline.spec.js

// row: { offsetTop, offsetLeft } | null（null ＝ 這一幀沒有可錨的列節點）
// 回傳 { visible, left, top }。visible=false 時 left/top 無意義，呼叫端**必須把游標
// 藏起來**，不可以原地留著上一次的座標（舊版 early-return 就是留在原地 ⇒ 游標仍然
// 可見卻停在過期位置，term_view 原註解自承「sometimes cur_x is 80」）。
export function cursorOffsets({ row, cur_x, cur_y, cols, rows, chw, chh }) {
  if (
    !(cur_x >= 0) || !(cur_y >= 0) ||
    !(cols > 0) || !(rows > 0) ||
    cur_x >= cols || cur_y >= rows
  )
    return { visible: false, left: 0, top: 0 };

  const anchored = !!row && isFinite(row.offsetTop) && isFinite(row.offsetLeft);
  return {
    visible: true,
    left: (anchored ? row.offsetLeft : 0) + cur_x * chw,
    top: anchored ? row.offsetTop : cur_y * chh,
    anchored,
  };
}

export default cursorOffsets;
