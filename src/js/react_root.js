// React 18 root 管理：把舊 ReactDOM.render / unmountComponentAtNode（React 18
// 已移除）集中到一處。React 18 對「同一 container 重複 createRoot」會發警告，且本
// app 多個 modal 共用同一個 #reactAlert 容器，所以必須 cache root per container。
//
// ReactDOM 為 CDN UMD 全域（webpack externals 映射，見 webpack.config.js），React 18
// UMD 仍在 ReactDOM.createRoot 暴露 createRoot，與舊有 ReactDOM.render 用法一致，免 import。
//
// unmount 後從 cache 移除：unmount 過的 root 不可再 render，移除後同一容器下次
// renderInto 會取得乾淨的新 root（DeveloperModeAlert → ConnectionAlert →
// PasteShortcutAlert 依序重用 #reactAlert 即靠這條保證）。
const roots = new WeakMap();

export function renderInto(container, element) {
  let root = roots.get(container);
  if (!root) {
    root = ReactDOM.createRoot(container);
    roots.set(container, root);
  }
  // flushSync 還原 React 16 ReactDOM.render 的同步 commit 契約：React 18 root.render()
  // 預設非同步排程，但本 app 多處依賴「render 後 DOM/ref 立即就緒」——term_view 在
  // _renderScreenLines 後同步呼叫 setHighlightedRow（需 Screen ref.current 已 commit），
  // 好讀模式在 render 後量測 scrollTop/高度。這些呼叫點皆來自 websocket/DOM/init handler
  // 而非 React event，flushSync 安全；且 React 16 本就同步渲染，無效能回退。
  ReactDOM.flushSync(() => {
    root.render(element);
  });
  return root;
}

export function unmountFrom(container) {
  const root = roots.get(container);
  if (root) {
    root.unmount();
    roots.delete(container);
  }
}
