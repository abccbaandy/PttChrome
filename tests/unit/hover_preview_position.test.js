// 懸停預覽的座標守護。
//
// 症狀（live e2e 主控台）：`NaN` is an invalid value for the `left` css style
// property。ScreenController 的 `_hoverPos` 初值是 { left: undefined, top:
// undefined }，只有 `_onContainerMouseMove` 會填；而 `onHyperLinkMouseOver` 當下
// 就會渲染一次預覽 ⇒ 滑進連結後、第一次 mousemove 之前那一幀 `left` 是 undefined
// ⇒ `undefined + 20` = NaN，React 拒畫該屬性並噴 console 錯誤。
//
// 兩層守護：
//  1. controller 在 mouseover 當下就從事件記下 clientX/clientY（第一幀就有正確座標）；
//  2. OnHover 對非有限座標退回 0（任何其他呼叫路徑都不會再算出 NaN）。

import React from "react";
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { row, link } from "./helpers/screen_fixtures";
import { ImagePreviewer } from "../../src/components/ImagePreviewer";
import { renderInto, unmountFrom } from "../../src/js/react_root";

const HREF = "https://i.imgur.com/hover.jpg";
const LINES = [row(link(HREF))];

let errors;
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

function mountWithHover() {
  return mountScreen({
    lines: LINES,
    enableLinkHoverPreview: true,
    enhance: {
      blacklist: new Set(),
      titleBlacklist: [],
      pageState: 3,
      easyReading: false,
      articleId: "hover-1",
    },
  });
}

describe("hover preview positioning", () => {
  // 只有 mouseover、沒有 mousemove —— 正是 bug 發生的那一幀。
  test("mouseover 當幀就用事件座標定位，不會算出 NaN", () => {
    const mounted = mountWithHover();
    const a = mounted.container.querySelector("a");
    expect(a).toBeTruthy();

    a.dispatchEvent(
      new MouseEvent("mouseover", {
        bubbles: true,
        clientX: 100,
        clientY: 50,
      }),
    );

    const spinner = mounted.container.querySelector(".previewSpinner");
    expect(spinner).toBeTruthy();
    expect(spinner.style.left).toBe("120px"); // clientX + 20
    expect(spinner.style.top).toBe("50px");
    expect(errors.join("\n")).not.toMatch(/NaN/);
  });

  // 之後的 mousemove 照常更新位置（原本的行為不可被防呆吃掉）。
  test("後續 mousemove 更新座標", () => {
    const mounted = mountWithHover();
    const a = mounted.container.querySelector("a");
    a.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, clientX: 10, clientY: 10 }),
    );
    mounted.container.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 200, clientY: 80 }),
    );

    const spinner = mounted.container.querySelector(".previewSpinner");
    expect(spinner.style.left).toBe("220px");
    expect(spinner.style.top).toBe("80px");
    expect(errors.join("\n")).not.toMatch(/NaN/);
  });

  // 第二層：座標真的沒有時（任何非 DOM 事件驅動的呼叫路徑）也不可算成 NaN。
  test("OnHover 座標未定時退回 0，不噴 NaN", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    renderInto(
      host,
      React.createElement(ImagePreviewer.OnHover, {
        left: undefined,
        top: undefined,
        value: undefined,
        error: undefined,
      }),
    );
    const spinner = host.querySelector(".previewSpinner");
    expect(spinner).toBeTruthy();
    expect(spinner.style.left).toBe("20px");
    expect(spinner.style.top).toBe("0px");
    expect(errors.join("\n")).not.toMatch(/NaN/);
    unmountFrom(host);
    host.remove();
  });
});
