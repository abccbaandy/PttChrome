// 純 JS 渲染鏈的測試掛載器。
//
// 取代舊的 @testing-library/react `render(<Screen/>)` / `render(<Row/>)`：核心畫面
// 2026-08 去 React 化後，渲染鏈是 src/render/ 的 ScreenController + buildRow，
// 沒有 React 樹可以 render。斷言的目標（class / data-* / DOM 結構）不變，只有掛載
// 方式換掉。
//
// 兩者都回傳一個**已經接進 document** 的容器：ScreenController 會量 offsetHeight
// 並用 closest('.main') 找捲動容器，detached 節點上量不到。
import { ScreenController } from "../../../src/render/screen";
import { buildRow } from "../../../src/render/row";

const mounted = [];

// 一個完整畫面。props 與 term_ui.renderScreen 交給 controller 的那份同形。
export function mountScreen(props) {
  const root = document.createElement("div");
  root.className = "main";
  document.body.appendChild(root);
  const controller = new ScreenController(root);
  controller.update(Object.assign({ forceWidth: 20 }, props));
  const entry = {
    root,
    controller,
    get container() {
      return controller.container;
    },
    // 換一批 props 重畫（好讀 append／改設定／換文章）。
    update(next) {
      controller.update(Object.assign({ forceWidth: 20 }, next));
    },
  };
  mounted.push(entry);
  return entry;
}

// 單獨一列。回傳的 container 是一個包住 bbsrow 的 div，讓既有測試的
// container.querySelector(...) 寫法原樣可用。
export function mountRow(props) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const built = buildRow(Object.assign({ row: 0, forceWidth: 20 }, props));
  root.appendChild(built.node);
  const entry = { root, container: root, node: built.node, slots: built.slots };
  mounted.push(entry);
  return entry;
}

// 每個測試收尾都要跑：controller 持有 IntersectionObserver / ResizeObserver /
// ImagePreviewer 的 React root，不收會跨測試互相污染。
export function unmountAll() {
  while (mounted.length) {
    const entry = mounted.pop();
    if (entry.controller) entry.controller.destroy();
    else if (entry.slots) entry.slots.forEach((s) => s.destroy());
    entry.root.remove();
  }
}
