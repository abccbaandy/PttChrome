// @unit-env browser
// real-input: tests/e2e/offline/mobile_toolbar.offline.spec.js
//   （真觸控 tap 走同一個 pointerdown 委派；本檔手捏 PointerEvent 只測分支）
// 按下的波紋回饋（src/js/ripple.js）。鎖：
//  1. 只處理 .pttRipple；**#mainContainer 內一律跳過**（核心畫面的單一寫入路徑）；
//  2. reduced-motion 不畫；disabled 不畫；
//  3. 波紋跑完自己移除。
import { installRipple, rippleHost, RIPPLE_MS } from "../../src/js/ripple";

let uninstall = null;
afterEach(() => {
  if (uninstall) uninstall();
  uninstall = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function mount(html) {
  document.body.innerHTML = html;
}
const down = (el) =>
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }));

test("rippleHost：只認 .pttRipple，#mainContainer 內與 disabled 不算", () => {
  mount(
    '<button class="pttRipple" id="a"><span id="in">x</span></button>' +
      '<div id="mainContainer"><button class="pttRipple" id="core">y</button></div>' +
      '<button class="pttRipple" id="off" disabled>z</button><button id="plain">p</button>',
  );
  const $ = (id) => document.getElementById(id);
  expect(rippleHost($("in"))).toBe($("a"));
  expect(rippleHost($("core"))).toBe(null);
  expect(rippleHost($("off"))).toBe(null);
  expect(rippleHost($("plain"))).toBe(null);
});

test("按下插一個波紋、跑完移除；核心畫面不插", () => {
  vi.useFakeTimers();
  uninstall = installRipple(document, window);
  mount(
    '<button class="pttRipple" id="a">x</button>' +
      '<div id="mainContainer"><button class="pttRipple" id="core">y</button></div>',
  );
  down(document.getElementById("a"));
  expect(document.querySelectorAll("#a .pttRippleWave")).toHaveLength(1);
  down(document.getElementById("core"));
  expect(document.querySelectorAll("#mainContainer .pttRippleWave")).toHaveLength(0);
  vi.advanceTimersByTime(RIPPLE_MS);
  expect(document.querySelectorAll(".pttRippleWave")).toHaveLength(0);
});

test("prefers-reduced-motion：不畫", () => {
  const win = { matchMedia: () => ({ matches: true }), setTimeout };
  uninstall = installRipple(document, win);
  mount('<button class="pttRipple" id="a">x</button>');
  down(document.getElementById("a"));
  expect(document.querySelectorAll(".pttRippleWave")).toHaveLength(0);
});
