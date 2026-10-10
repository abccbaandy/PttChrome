// 右鍵（桌機）／長按（手機）選單開著時，標出選單作用在哪一篇文章（列表那一列／
// 手機卡片），避免對錯的文章做「前已讀後未讀」「加黑名單」「複製文章代碼」。
//
// **刻意不碰 #mainContainer 的節點**（不加 class、不寫屬性），改寫一條動態 CSS 規則：
//   1. 核心渲染鏈只有一條寫入路徑（render/screen.js 檔頭）；
//   2. 列表每幀用 outerHTML 比對沿用舊節點（screen.js#_buildNodes）——節點上多一個
//      class 就永遠比對不上 ⇒ 選單開著的每一幀整列重建；
//   3. 規則用屬性選中列，列被重建也自動套上，不必在 render 收尾對帳。
// 選擇器除了列號（srow）還要求標題／作者相符：選單開著時畫面捲動或換頁，那一列換成
// 別篇 ⇒ 標示自動消失，不會指到錯的文章。
//
// 只標文章列表的列（data-list-author／data-list-title，row.js、list_card.js 的契約）。
// 開關：偏好 highlightMenuTarget（設定→一般→右鍵選單，預設開），由 ContextMenu 現讀。

const STYLE_ID = "menuTargetHighlight";

// 由選單打開時的 event.target 找出那一列；不是文章列 ⇒ null。
export function menuTargetFromElement(target) {
  if (!target || !target.closest) return null;
  const row = target.closest(
    'span[type="bbsrow"][data-list-author], span[type="bbsrow"][data-list-title]',
  );
  if (!row) return null;
  const srow = row.getAttribute("srow");
  if (srow === null || !/^\d+$/.test(srow)) return null;
  return {
    row: Number(srow),
    author: row.getAttribute("data-list-author"),
    title: row.getAttribute("data-list-title"),
  };
}

// CSS 字串跳脫（雙引號包起來的屬性值）。標題是使用者內容，什麼字都可能有。
function cssString(s) {
  return (
    '"' +
    String(s)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/[\n\r\f]/g, (c) => "\\" + c.charCodeAt(0).toString(16) + " ") +
    '"'
  );
}

export function menuTargetSelector(t) {
  if (!t || !Number.isInteger(t.row) || t.row < 0) return "";
  let sel = `#mainContainer span[type="bbsrow"][srow="${t.row}"]`;
  if (t.author != null) sel += `[data-list-author=${cssString(t.author)}]`;
  if (t.title != null) sel += `[data-list-title=${cssString(t.title)}]`;
  return sel;
}

// 只畫外框（使用者要求：不閃爍、不疊底色）。用 inset box-shadow 不佔版面
// （手機卡片高度鎖死，見 main.css .listCard）。
export function menuTargetCss(t) {
  const sel = menuTargetSelector(t);
  if (!sel) return "";
  return `${sel}{box-shadow:inset 0 0 0 2px #a8c7fa;}`;
}

// null ＝ 清掉標示。
export function setMenuTargetHighlight(t) {
  if (typeof document === "undefined") return;
  const css = menuTargetCss(t);
  let style = document.getElementById(STYLE_ID);
  if (!css) {
    if (style) style.textContent = "";
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = css;
}
