// 終端機尺寸與版面位移 —— 純函式，零 DOM、零狀態。
//
// 消費端只有 term_view（`calcTermSizeFromFont` / `setTermFontSize`），抽出來是
// 因為這兩條全是算術、卻沒有任何測試守護，而其中兩條規則一旦被順手改掉就是
// 靜默的行為退步（見下方 LOCKED 註記）。守護：tests/unit/term_size.test.js。

// PTT 的畫面協定固定 80 欄：文章內文本來就只有 ~78 欄，看板／文章列表的欄位
// 起始位置也是照 80 欄排的（本專案的欄位解析、黑名單比對、mouse_regions 的
// 區域表全依賴它）。server 端雖然吃 80..200 欄的 NAWS（`mbbsd/term.c:56`），
// 但加寬只會讓列表標題欄變長（`bbs.c:745` 的 `t_columns-34`）＋右側整片留白，
// 對閱讀沒有任何收益，卻要賠上一整層未驗證的欄位解析風險。
// **LOCKED**：欄數恆 80，不要改回「依視窗寬反推」。
export const TERM_COLS = 80;

// 列數的上下界照抄 server：`mbbsd/term.c:55` `MAX(24, MIN(100, h))`。送超出
// 範圍的 NAWS 只會讓兩邊對 rows 的認知分歧（client 畫 120 列、server 只認 100）。
export const MIN_ROWS = 24;
export const MAX_ROWS = 100;

// 「固定字體大小」模式：字級是自變數，列數由視窗高度反推（欄數見上，恆 80）。
// 字級先無條件進位到偶數 —— 半形格寬是 chh/2，奇數字級會讓格寬帶 .5px，
// 等寬格線在整數裝置像素上就對不齊了（同 fixedResize 的 DPR 對齊理由）。
export function calcTermSize({ height, fontSizePx }) {
  const px = Math.floor((fontSizePx + 1) / 2) * 2;
  return {
    cols: TERM_COLS,
    rows: Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.floor(height / px)))
  };
}

// `.main` 在視窗裡的**垂直**位移。單位 px，呼叫端自己接 'px'。
// `margin` ＝ pref bbsMargin。
//
// **LOCKED：這裡不算水平位移。** 終端機的水平置中已經有人做了 ——
// `pttchrome.jsx` 建構子的 `BBSWin.setAttribute("align", "center")`（Chrome 算成
// `text-align: -webkit-center`，那個值會連 **block 子元素**一起置中，等同給
// `.main` 一組 margin auto）。在這裡再寫一次 marginLeft 就是**雙重置中**：實測
// 1280px 視窗、終端機寬 1210px 時，box 會落在 52.5px 而不是 35px（先吃掉自己寫的
// 35，剩下的 35 再被 -webkit-center 平分）。
//
// 縮放模式（pref fontFitWindowWidth）**同樣依賴那個置中**：`mouse_geometry.gridOriginX`
// 用 `(innerWidth - chw*cols*scaleX)/2` 推格線原點，成立的前提就是 layout box
// 置中 ＋ `transform-origin: center`。把水平位移改成「貼左」會讓退出提示帶整條
// 跑掉。所以那個 deprecated 的 align 屬性**不是可以順手刪的遺跡**，守護在
// tests/e2e/offline/term_size.offline.spec.js。
export function termLayoutOffsets({ innerHeight, chh, rows, margin = 0 }) {
  const contentHeight = chh * rows;
  return {
    marginTop:
      contentHeight < innerHeight
        ? (innerHeight - contentHeight) / 2 + margin
        : margin
  };
}
