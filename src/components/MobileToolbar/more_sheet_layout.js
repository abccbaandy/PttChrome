// 手機「更多」的版面（P40，docs/mobile.md「更多」）：常用的排成最上面的圖示格（圖示＋短字，
// 跟長按推文那排 P37 同一種樣子，一排 4 格），不捲就點得到；少用的（文章導覽、上傳紀錄、
// 設定、登出）留在下面清單。純資料：哪些算常用、排序、什麼時候才收（MobileToolbar 畫）。
// 項目本身（出現條件、handler）仍在 MobileToolbar —— 這裡只重新分組。

// 圖示格的項目與順序（只收這一刻看得到的）。
export const MORE_GRID_KEYS = [
  "__unreadJump",
  "__followOnly",
  "__markAllRead",
  "__share",
  "__select",
  "__selectAll",
  "__uploadImage",
  "__help",
];

// 少於這個數就不收（主功能表只剩「選取模式」一兩顆，圖示反而比文字難懂）。
export const MORE_GRID_MIN = 3;

// 短字（完整的字放 aria-label／title）。
export const MORE_GRID_LABEL_KEYS = {
  __unreadJump: "mobileMoreShort_unreadJump",
  __followOnly: "mobileMoreShort_followOnly",
  __markAllRead: "mobileMoreShort_markAllRead",
  __share: "mobileMoreShort_share",
  __select: "mobileMoreShort_select",
  __selectAll: "mobileMoreShort_selectAll",
  __uploadImage: "mobileMoreShort_uploadImage",
  __help: "mobileMoreShort_help",
};

// visibleKeys（這一刻要出現的項目，照清單順序）→ { grid, list }。不收時 grid 是空的、list 原封不動。
export function splitMoreGrid(visibleKeys) {
  const grid = MORE_GRID_KEYS.filter((k) => visibleKeys.includes(k));
  if (grid.length < MORE_GRID_MIN) return { grid: [], list: visibleKeys.slice() };
  return { grid, list: visibleKeys.filter((k) => !grid.includes(k)) };
}

// sheet 開著時畫面 context 變了（例：開機還沒第一次 screenSettled 就開了「更多」）：已經畫出來的
// 項目留在原本那一區，不在圖示格與清單之間搬家 —— 搬家＝按鈕節點換掉，手指按下到放開之間被換掉
// Chromium 就不發 click（同 #152）。新出現的：圖示格已經有東西才進圖示格，否則進清單；消失的照樣拿掉。
// prev＝這次開著時上一次的分組（剛打開傳 null ⇒ 等於 splitMoreGrid）。
export function stableMoreSplit(visibleKeys, prev) {
  if (!prev) return splitMoreGrid(visibleKeys);
  const toGrid = (k) =>
    prev.grid.includes(k) ||
    (!prev.list.includes(k) && prev.grid.length > 0 && MORE_GRID_KEYS.includes(k));
  const grid = MORE_GRID_KEYS.filter((k) => visibleKeys.includes(k) && toGrid(k));
  return { grid, list: visibleKeys.filter((k) => !grid.includes(k)) };
}
