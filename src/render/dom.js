// 純 JS 渲染鏈的建節點小工具。
//
// 語意刻意對齊 React，因為這條鏈是從 <Screen>/<Row> 逐字改寫過來的，產物必須與
// 舊版一模一樣（tests/unit/fixtures/screen_golden/ 逐字比對）：
//   - class 為 undefined/null → **不輸出** class 屬性
//   - class 為 ""（cx 全部落空）→ 輸出 class=""（React 就是這樣，golden 有記錄）
//   - 其餘屬性值為 undefined/null → 不輸出；其餘一律 String() 後 setAttribute
//     （React 對 data-floor 這種 JSX 布林簡寫輸出的是 data-floor="true"）
//   - style 物件：`--` 開頭走 setProperty（CSS 自訂屬性），其餘直接指派；數值一律
//     補 px（React 對非 unitless 屬性就是這樣做，golden 裡的 `width: 240px;` 即是）

// 子節點可以是 Node、字串、false/null/undefined（跳過）、或以上的巢狀陣列
// （對齊 React 的 children 攤平語意——ColorSegmentBuilder.build() 回的就是陣列，
// 其中第一格常常是 NullObject 的 false）。
function appendChildren(node, children) {
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) {
    for (let i = 0; i < children.length; ++i) appendChildren(node, children[i]);
    return;
  }
  if (typeof children === "string" || typeof children === "number") {
    node.appendChild(document.createTextNode(String(children)));
    return;
  }
  node.appendChild(children);
}

export function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const name in attrs) {
      const value = attrs[name];
      if (value === undefined || value === null) continue;
      if (name === "style") {
        applyStyle(node, value);
        continue;
      }
      node.setAttribute(name, String(value));
    }
  }
  appendChildren(node, children);
  return node;
}

// React 不會替這些屬性補 px（值本來就是無單位的）。這裡只列渲染鏈實際會用到的。
const UNITLESS = new Set([
  "zIndex",
  "opacity",
  "flex",
  "flexGrow",
  "order",
  "lineHeight",
]);

export function applyStyle(node, style) {
  for (const prop in style) {
    const value = style[prop];
    if (value === undefined || value === null) continue;
    if (prop.charCodeAt(0) === 45 /* '-' */) {
      node.style.setProperty(prop, String(value));
      continue;
    }
    node.style[prop] =
      typeof value === "number" && value !== 0 && !UNITLESS.has(prop)
        ? `${value}px`
        : String(value);
  }
}
