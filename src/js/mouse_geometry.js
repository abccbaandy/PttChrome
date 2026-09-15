// 終端機格子與畫面座標的換算 —— 純函式，零 DOM、零狀態。
//
// 存在理由：文章左側的「點這裡離開」提示帶（#exitHintBand）必須**剛好**蓋住
// EXIT_COL_END 欄，否則帶子亮著卻點不到、或點得到卻沒亮。提示帶的幾何**只能**與
// App.clientToPos（pttchrome.jsx，決定「點到第幾格」）同源，所以把 clientToPos 的
// 欄位數學抽到這裡，讓 clientToPos 與帶子共用同一份實作。
//
// 歷史：專案曾有第二套原點公式 TermView.convertMN2XYEx（畫 #cursor／#t 用，多了
// +10 與 bbsViewMargin，兩者差幾個到十幾個像素）。它已刪除 —— #cursor 與 #t 現在
// 都錨在「該列真正被畫出來的節點」，不再有任何格線原點公式。**不要再加回來。**
// 回歸鎖見 tests/unit/mouse_geometry.test.js（帶子右緣 -ε 是第 6 欄、+ε 是第 7 欄）。

import { EXIT_COL_END } from './mouse_regions';

export { EXIT_COL_END };

// scale ≠ 1 時（fontFitWindowWidth：整個 .main 被 CSS transform 縮放）原點改由
// 「視窗寬減掉縮放後的終端機寬，左右均分」推得；否則直接用 DOM 量到的第一格左緣。
// 這個分支條件與 clientToPos 逐字相同，改一邊就要改另一邊 —— 所以才共用。
export function isScaled(geom) {
  const g = geom || {};
  return g.scaleX !== 1 || g.scaleY !== 1;
}

export function cellWidth(geom) {
  const g = geom || {};
  return g.chw * (g.scaleX == null ? 1 : g.scaleX);
}

export function gridOriginX(geom) {
  const g = geom || {};
  if (isScaled(g)) {
    return (g.innerWidth - g.chw * g.cols * g.scaleX) / 2;
  }
  return parseFloat(g.firstGridLeft) || 0;
}

// 畫面 x（client 座標）→ 第幾欄。與 clientToPos 同樣 clamp 進 [0, cols-1]。
export function colFromClientX(clientX, geom) {
  const g = geom || {};
  const w = cellWidth(g);
  if (!(w > 0)) return 0;
  let col = Math.floor((clientX - gridOriginX(g)) / w);
  if (col < 0) col = 0;
  else if (col >= g.cols - 1) col = g.cols - 1;
  return col;
}

// 提示帶的幾何。高度由 CSS 給（top:0; height:100%），這裡只算水平方向。
export function exitBandRect(geom) {
  const w = cellWidth(geom);
  return {
    left: gridOriginX(geom),
    width: w > 0 ? EXIT_COL_END * w : 0
  };
}

export function rowHeight(geom) {
  const g = geom || {};
  return g.chh * (g.scaleY == null ? 1 : g.scaleY);
}

// 垂直方向的原點。**分支條件與 App.clientToPos 逐字相同**（那裡呼叫這一支），
// 理由同 gridOriginX：帶子與「點到第幾格」必須同源，否則帶子亮著卻點不到。
export function gridOriginY(geom) {
  const g = geom || {};
  if (isScaled(g)) {
    return (g.innerHeight - g.chh * g.rows * g.scaleY) / 2;
  }
  return parseFloat(g.firstGridTop) || 0;
}

// 畫面 y（client 座標）→ 第幾列。clamp 與 App.clientToPos 相同（它就是呼叫這一支）。
//
// **列表好讀的 body 區不走這裡**：那一段是捲動視口，列號是「整段序列」的 index，
// 由 clientToPos 自己換算。反過來說，邊緣翻頁區在列表好讀底下要的正是這裡的
// **螢幕列號**（視口與 24 列畫面同高，header 3 列／body／footer 的版面逐列對齊
// 原生列表），否則右緣上下半的分界會落在幾千列的序列 index 上。
export function rowFromClientY(clientY, geom) {
  const g = geom || {};
  const h = rowHeight(g);
  if (!(h > 0)) return 0;
  let row = Math.floor((clientY - gridOriginY(g)) / h);
  if (row < 0) row = 0;
  else if (row >= g.rows - 1) row = g.rows - 1;
  return row;
}

// 邊緣翻頁提示帶（#edgeHintBand）的幾何。吃 resolveMouseRegion 回傳的
// `hintBand`（格子空間的半開矩形），吐 CSS 的四邊。null ⇒ null（不畫）。
export function edgeBandRect(band, geom) {
  if (!band) return null;
  const w = cellWidth(geom);
  const h = rowHeight(geom);
  if (!(w > 0) || !(h > 0)) return null;
  return {
    left: gridOriginX(geom) + band.colStart * w,
    width: (band.colEnd - band.colStart) * w,
    top: gridOriginY(geom) + band.rowStart * h,
    height: (band.rowEnd - band.rowStart) * h
  };
}
