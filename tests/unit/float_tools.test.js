// @unit-env browser
// 文章頁浮動工具「⋯」（render/merge_buttons.js#createFloatingTools）。
// 收合／展開由 main.css 的真樣式決定（以 ?raw 注入），hover 走 Playwright 真滑鼠。
//   - 預設收合：只看得到圓鈕，面板不可見（手機上不蓋文章字的前提）。
//   - 桌機滑鼠移上去自動展開；移開收合。
//   - 點圓鈕展開（觸控）；點了面板裡的工具 ⇒ 工具照常觸發，面板收合。
//   - 拖曳：位移超過門檻 ⇒ 移動＋存位置，且那一下不算點擊。
//   - 圓鈕在視窗下半 ⇒ 面板往上展開，且展開不會推動圓鈕（hover 不閃）。
// real-input: tests/e2e/offline/lights_on.offline.spec.js
import { userEvent } from "vitest/browser";
import mainCss from "../../src/css/main.css?raw";
import { createFloatingTools } from "../../src/render/merge_buttons";
import { setupI18n } from "../../src/js/i18n";
import {
  FLOAT_TOOLS_POS_STORAGE_KEY,
  FLOAT_TOOLS_DEFAULT_POS,
} from "../../src/js/mobile_layout";

let style;
const mounted = [];
beforeAll(() => {
  setupI18n();
  style = document.createElement("style");
  style.textContent = mainCss;
  document.head.appendChild(style);
});
afterAll(() => style.remove());
afterEach(() => {
  while (mounted.length) mounted.pop().remove();
});

const memStorage = () => {
  const mem = new Map();
  return {
    mem,
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, v),
  };
};

function mountTools(storage = memStorage()) {
  const t = createFloatingTools(storage);
  const calls = [];
  const tool = document.createElement("button");
  tool.id = "someTool";
  tool.type = "button";
  tool.textContent = "工具";
  tool.addEventListener("click", () => calls.push("tool"));
  t.setTools([tool]);
  document.body.appendChild(t.el);
  mounted.push(t.el);
  return { t, tool, calls, storage };
}

const visible = (node) => getComputedStyle(node).display !== "none";

test("預設收合：圓鈕可見、面板不可見", () => {
  const { t } = mountTools();
  expect(visible(t.fab)).toBe(true);
  expect(visible(t.panel)).toBe(false);
  expect(t.fab.getAttribute("aria-expanded")).toBe("false");
});

test("桌機滑鼠移上去自動展開、移開收合", async () => {
  const { t } = mountTools();
  await userEvent.hover(t.fab);
  expect(visible(t.panel)).toBe(true);
  await userEvent.unhover(t.fab);
  expect(visible(t.panel)).toBe(false);
});

test("展開不推動圓鈕（面板 absolute，圓鈕在 hover 時不會跑掉）", async () => {
  const { t } = mountTools();
  const before = t.fab.getBoundingClientRect();
  await userEvent.hover(t.fab);
  const after = t.fab.getBoundingClientRect();
  expect(after.top).toBe(before.top);
  expect(after.left).toBe(before.left);
  // 預設位置在視窗下半 ⇒ 面板在圓鈕上方
  expect(t.panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(after.top);
  await userEvent.unhover(t.fab);
});

// 回歸：工具 label 點完變短（「開燈（顯示隱藏文字）」→「關燈」）⇒ 靠右的按鈕往右縮，
// 游標落到面板外、:hover 掉了，面板在游標底下收起來（offline e2e 的 lights_on 實錄）。
test("桌機 hover 展開中點工具、label 變短 ⇒ 面板仍展開，可以再點一次", async () => {
  const { t, tool, calls } = mountTools();
  tool.textContent = "開燈（顯示隱藏文字）很長很長的標籤";
  tool.addEventListener("click", () => {
    tool.textContent =
      tool.textContent === "關" ? "開燈（顯示隱藏文字）很長很長的標籤" : "關";
  });
  await userEvent.hover(t.fab);
  await userEvent.click(tool);
  expect(tool.textContent).toBe("關");
  expect(visible(t.panel)).toBe(true);
  await userEvent.click(tool);
  expect(calls).toEqual(["tool", "tool"]);
  await userEvent.unhover(t.el);
  expect(visible(t.panel)).toBe(false);
  expect(t.panel.style.minWidth).toBe("");
});

test("點圓鈕展開；點面板裡的工具 ⇒ 工具觸發且面板收合", () => {
  const { t, tool, calls } = mountTools();
  t.fab.click();
  expect(t.el.hasAttribute("data-open")).toBe(true);
  expect(visible(t.panel)).toBe(true);
  expect(t.fab.getAttribute("aria-expanded")).toBe("true");
  tool.click();
  expect(calls).toEqual(["tool"]);
  expect(t.el.hasAttribute("data-open")).toBe(false);
  expect(visible(t.panel)).toBe(false);
});

test("再點一次圓鈕收合", () => {
  const { t } = mountTools();
  t.fab.click();
  t.fab.click();
  expect(t.el.hasAttribute("data-open")).toBe(false);
});

test("setActive ⇒ data-active（收合時看得出有工具作用中）", () => {
  const { t } = mountTools();
  t.setActive(true);
  expect(t.el.hasAttribute("data-active")).toBe(true);
  t.setActive(false);
  expect(t.el.hasAttribute("data-active")).toBe(false);
});

test("預設位置＝FLOAT_TOOLS_DEFAULT_POS；存過的位置會被讀回來", () => {
  const { t } = mountTools();
  expect(t.el.style.right).toBe(FLOAT_TOOLS_DEFAULT_POS.right + "px");
  expect(t.el.style.bottom).toBe(FLOAT_TOOLS_DEFAULT_POS.bottom + "px");
  const st = memStorage();
  st.setItem(FLOAT_TOOLS_POS_STORAGE_KEY, JSON.stringify({ right: 40, bottom: 200 }));
  const { t: t2 } = mountTools(st);
  expect(t2.el.style.right).toBe("40px");
  expect(t2.el.style.bottom).toBe("200px");
});

const pointer = (type, x, y) =>
  new PointerEvent(type, { pointerId: 7, clientX: x, clientY: y, bubbles: true });

test("拖曳超過門檻 ⇒ 移動並存位置，放開後那一下不算點擊", () => {
  const { t, storage } = mountTools();
  t.fab.dispatchEvent(pointer("pointerdown", 500, 500));
  t.fab.dispatchEvent(pointer("pointermove", 470, 400));
  t.fab.dispatchEvent(pointer("pointerup", 470, 400));
  t.fab.click();
  expect(t.el.hasAttribute("data-open")).toBe(false);
  const saved = JSON.parse(storage.mem.get(FLOAT_TOOLS_POS_STORAGE_KEY));
  expect(saved).toEqual({
    right: FLOAT_TOOLS_DEFAULT_POS.right + 30,
    bottom: FLOAT_TOOLS_DEFAULT_POS.bottom + 100,
  });
  // 下一次點擊恢復正常
  t.fab.click();
  expect(t.el.hasAttribute("data-open")).toBe(true);
});

test("位移小於門檻 ⇒ 仍是點擊、不存位置", () => {
  const { t, storage } = mountTools();
  t.fab.dispatchEvent(pointer("pointerdown", 500, 500));
  t.fab.dispatchEvent(pointer("pointermove", 503, 502));
  t.fab.dispatchEvent(pointer("pointerup", 503, 502));
  t.fab.click();
  expect(t.el.hasAttribute("data-open")).toBe(true);
  expect(storage.mem.has(FLOAT_TOOLS_POS_STORAGE_KEY)).toBe(false);
});

test("圓鈕被拖到視窗上半 ⇒ 面板往下展開", () => {
  const st = memStorage();
  st.setItem(
    FLOAT_TOOLS_POS_STORAGE_KEY,
    JSON.stringify({ right: 16, bottom: window.innerHeight - 60 }),
  );
  const { t } = mountTools(st);
  t.fab.click();
  expect(t.el.getAttribute("data-vdir")).toBe("down");
  expect(t.panel.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    t.fab.getBoundingClientRect().bottom,
  );
});
