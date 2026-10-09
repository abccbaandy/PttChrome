// 終端機尺寸與版面位移 —— 純函式，零 DOM、零狀態。
//
// 消費端只有 term_view（`calcTermSizeFromFont` / `setTermFontSize`），抽出來是
// 因為這兩條全是算術、卻沒有任何測試守護，而其中兩條規則一旦被順手改掉就是
// 靜默的行為退步（見下方 LOCKED 註記）。守護：tests/unit/term_size.test.js。

// PTT 的畫面協定固定 80 欄：文章內文本來就只有 ~78 欄，看板／文章列表的欄位
// 起始位置也是照 80 欄排的（本專案的欄位解析、黑名單比對、mouse_regions 的
// 區域表全依賴它）。server 端雖然吃 80..200 欄的 NAWS（`include/config.h`
// `VALID_TERM_COLS`），但加寬只會讓列表標題欄變長（`bbs.c` 的 `t_columns-34`）＋
// 右側整片留白，對閱讀沒有任何收益，卻要賠上一整層未驗證的欄位解析風險。
// upstream 已放寬到最少 20 欄（portrait mode），但畫面層仍照 80 欄排，窄欄同樣
// 不採用（手機窄版面走 client 端 reflow／卡片），見 docs/terminal-size.md §3。
// **LOCKED**：欄數恆 80，不要改回「依視窗寬反推」。
export const TERM_COLS = 80;

// 列數的上下界照抄 server：`include/config.h` `VALID_TERM_ROWS`（24..100；upstream
// 已放寬上限到 150，ptt.cc 部署未確認前維持 100）。送超出範圍的 NAWS 只會讓兩邊
// 對 rows 的認知分歧（client 畫 120 列、server 只認 100）。
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
//
// `bottomInset` ＝手機軟鍵盤蓋住的底部高度（mobile_layout.keyboardInset，0 ＝沒有）。
// 置中改在「沒被蓋住的那一段」裡做；放不下時**底對齊**可視區（頂端幾列被推出畫面），
// 因為這時使用者正在打字，而 PTT 的輸入列幾乎都在底列（vtuikit.c 的 b_lines）。
//
// `topInset` ＝手機頂部 App Bar（＋瀏海 safe area）蓋住的高度。可視區從它下面算起，
// 所有分支都以它為原點；0 ＝與以前完全相同（桌機零改動）。
export function termLayoutOffsets({ innerHeight, chh, rows, margin = 0, bottomInset = 0, topInset = 0 }) {
  const contentHeight = chh * rows;
  const inset = bottomInset > 0 ? bottomInset : 0;
  const top = topInset > 0 ? topInset : 0;
  const avail = innerHeight - inset - top;
  if (contentHeight < avail) return { marginTop: top + (avail - contentHeight) / 2 + margin };
  if (inset > 0) return { marginTop: top + avail - contentHeight };
  return { marginTop: top + margin };
}
