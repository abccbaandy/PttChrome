// React root 管理：把舊 ReactDOM.render / unmountComponentAtNode（React 18 起
// 已移除）集中到一處。React 對「同一 container 重複 createRoot」會發警告，且本
// app 多個 modal 共用同一個 #reactAlert 容器，所以必須 cache root per container。
//
// React 19 起 React/react-dom 改為 bundled（UMD build 已移除），故顯式
// import：createRoot 在 react-dom/client（19 不再從 react-dom re-export），
// flushSync 仍在 react-dom。
//
// unmount 後從 cache 移除：unmount 過的 root 不可再 render，移除後同一容器下次
// renderInto 會取得乾淨的新 root（DeveloperModeAlert → ConnectionAlert →
// PasteShortcutAlert 依序重用 #reactAlert 即靠這條保證）。
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

const roots = new WeakMap();

export function renderInto(container, element) {
  let root = roots.get(container);
  if (!root) {
    root = createRoot(container);
    roots.set(container, root);
  }
  // flushSync 還原 React 16 ReactDOM.render 的同步 commit 契約：React 18 起 root.render()
  // 預設非同步排程，但本 app 多處依賴「render 後 DOM/ref 立即就緒」——term_view 在
  // _renderScreenLines 後同步呼叫 setHighlightedRow（需 Screen ref.current 已 commit），
  // 好讀模式在 render 後量測 scrollTop/高度。這些呼叫點皆來自 websocket/DOM/init handler
  // 而非 React event，flushSync 安全；且 React 16 本就同步渲染，無效能回退。
  flushSync(() => {
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
