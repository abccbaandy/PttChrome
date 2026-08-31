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

// 這一幀畫出去的 srow 是不是 buf 的列號。
//
// srow ＝ 傳給 <Screen> 的 lines index，而 term_view 的七條 render 分支餵的來源不同：
//   buf.lines（原生／文章好讀 functionMode 鏡像／防黑守門鏡像／列表好讀的
//     windowLines==null fallback）── srow **就是** buf 列號；
//   列表好讀視窗（header 快取 3 列＋整段序列 ≤300 列＋footer，全是 cloneRow 快照）
//   與好讀累積長頁（buf.pageLines）── **不是**，拿 buf.cur_y 去反查會撈到一列毫無
//   關係的節點（列表好讀那條還躲在 .listBodyView 的捲動視口裡，通常已捲出視野 ⇒
//   rect.top 是大負數 ⇒ #t 被寫到視窗外，OS 候選字清單跟著跑掉）。
//
// 判準刻意是**逐列參考相等**，不是「宣告自己是哪種模式」：模式旗標
//（buf.listRenderMode／_functionMode）一律「先設、後 _forceRedraw()」，用它解讀
// 上一幀留下來的 DOM 必有窗口期會說謊（list_session._enterFunctionMode 先設
// 'native' → showCursor() → 才 _forceRedraw()）。長度相等時（剛 seed 的列表視窗
// 恰好也是 24 列）唯一擋得住的就是逐列比對。
//
// 誤判方向是安全的：false negative 只是退回 _cellClientRect 的 `.main` 左下角
// fallback；false positive 需要每一列都是同一個物件，那就真的是 buf 的格線。
export function paintedRowsAreBufRows(lines, bufLines, rows) {
  if (!lines || !bufLines || !(rows > 0) || lines.length !== rows) return false;
  for (let i = 0; i < rows; ++i) if (lines[i] !== bufLines[i]) return false;
  return true;
}

export default cursorOffsets;
