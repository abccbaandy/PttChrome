// 游標底色的快路徑（src/render/screen.js#setCursorHighlight）。
//
// 舊 React 版把游標底色放在 useState，每動一次就 re-render 整個 <Screen>（靠逐列
// 元素快取才沒有重建每一列）。滑鼠瀏覽時游標列每移動一格就觸發一次，是原生模式
// 最頻繁的更新來源。純 JS 版對「整列底色」只做 class 搬家、完全不重畫。
//
// 這條測試鎖的是**行為**：
//   1. col 0（整列底色，絕大多數情形）→ 一個 DOM 節點都不換，class 正確搬家
//   2. col > 0（防誤觸的部分底色，包在 wrapper span 裡）→ 只有相關的列被換掉
//   3. 快路徑不可以讓快取與 DOM 失步：之後的 append 重繪要看得到正確的底色
import { ScreenController } from "../../src/render/screen";
import { row, seg, color } from "./helpers/screen_fixtures";

const LINES = [
  row(seg("第一列")),
  row(seg("第二列")),
  row(seg("第三列")),
  row(seg("第四列")),
];

const ENHANCE = {
  blacklist: new Set(),
  titleBlacklist: [],
  pageState: 2,
  easyReading: false,
  articleId: "a1",
};

function mount(lines = LINES, extra) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const controller = new ScreenController(root);
  controller.update({
    lines,
    forceWidth: 20,
    enableLinkInlinePreview: false,
    enableLinkHoverPreview: false,
    enhance: Object.assign({}, ENHANCE, extra),
  });
  return { root, controller };
}

const rowNodes = (c) =>
  Array.from(c.container.querySelectorAll('span[type="bbsrow"]'));
const highlighted = (c) =>
  Array.from(c.container.querySelectorAll('[data-type="bbsline"].b2')).map((n) =>
    Number(n.getAttribute("data-row")),
  );

describe("游標底色快路徑", () => {
  test("整列底色（col 0）搬家：不換任何 DOM 節點", () => {
    const { root, controller } = mount();
    const before = rowNodes(controller);

    controller.setCursorHighlight({ row: 1, cls: "b2", col: 0 });
    expect(highlighted(controller)).toEqual([1]);
    expect(rowNodes(controller)).toEqual(before);

    controller.setCursorHighlight({ row: 2, cls: "b2", col: 0 });
    expect(highlighted(controller)).toEqual([2]);
    expect(rowNodes(controller)).toEqual(before);

    // 收掉底色也走快路徑。
    controller.setCursorHighlight({ row: -1, cls: null, col: 0 });
    expect(highlighted(controller)).toEqual([]);
    expect(rowNodes(controller)).toEqual(before);

    controller.destroy();
    root.remove();
  });

  test("同一個狀態重複套用不做事", () => {
    const { root, controller } = mount();
    controller.setCursorHighlight({ row: 1, cls: "b2", col: 0 });
    const before = rowNodes(controller);
    controller.setCursorHighlight({ row: 1, cls: "b2", col: 0 });
    expect(rowNodes(controller)).toEqual(before);
    controller.destroy();
    root.remove();
  });

  // 「整列提亮」與「整列底色」是兩個可以同時開的樣式 ⇒ cls 會是**多個 class**
  // （cursor_highlight.cursorHighlightClasses）。舊版 _toggleRowClass 直接
  // classList.add(cls)，DOMTokenList 不吃含空白的 token ⇒ InvalidCharacterError，
  // 整條游標標示鏈就地掛掉。空字串同樣會噴。
  test("多個 class（提亮＋底色疊加）走快路徑：兩個都搬、不換節點", () => {
    const { root, controller } = mount();
    const before = rowNodes(controller);
    const lineAt = (r) =>
      controller.container.querySelector(
        '[data-type="bbsline"][data-row="' + r + '"]',
      );

    controller.setCursorHighlight({ row: 1, cls: "cursorBrighten b2", col: 0 });
    expect(lineAt(1).classList.contains("cursorBrighten")).toBe(true);
    expect(lineAt(1).classList.contains("b2")).toBe(true);
    expect(rowNodes(controller)).toEqual(before);

    // 搬到第 2 列：舊列**兩個** class 都要拔掉。
    controller.setCursorHighlight({ row: 2, cls: "cursorBrighten b2", col: 0 });
    expect(lineAt(1).classList.contains("cursorBrighten")).toBe(false);
    expect(lineAt(1).classList.contains("b2")).toBe(false);
    expect(lineAt(2).classList.contains("cursorBrighten")).toBe(true);
    expect(lineAt(2).classList.contains("b2")).toBe(true);
    expect(rowNodes(controller)).toEqual(before);

    controller.destroy();
    root.remove();
  });

  test("只有提亮（預設樣式）：那一列不得出現任何 bN 背景 class", () => {
    const BG_CLASSES = Array.from({ length: 15 }, (_, i) => "b" + (i + 1));
    const { root, controller } = mount();
    controller.setCursorHighlight({ row: 1, cls: "cursorBrighten", col: 0 });
    const line = controller.container.querySelector(
      '[data-type="bbsline"][data-row="1"]',
    );
    expect(line.classList.contains("cursorBrighten")).toBe(true);
    expect([...line.classList].some((c) => BG_CLASSES.includes(c))).toBe(false);
    controller.destroy();
    root.remove();
  });

  test("空 cls 不丟 InvalidCharacterError（兩種樣式都關掉的狀態）", () => {
    const { root, controller } = mount();
    expect(() =>
      controller.setCursorHighlight({ row: 1, cls: "", col: 0 }),
    ).not.toThrow();
    controller.destroy();
    root.remove();
  });

  test("部分底色（col > 0）只重建相關的列", () => {
    const { root, controller } = mount();
    const before = rowNodes(controller);

    controller.setCursorHighlight({ row: 1, cls: "b2", col: 3 });
    const after = rowNodes(controller);
    // 底色改掛在一個從該欄包到行尾的 wrapper span 上，bbsline 本身不上色
    // （那是 block 級元素，掛上去就是滿版）。
    const wrap = controller.container.querySelector(".cursorHighlight");
    expect(wrap).not.toBeNull();
    expect(wrap.classList.contains("b2")).toBe(true);
    expect(highlighted(controller)).toEqual([]);

    // 只有第 1 列換了節點，其餘三列原封不動。
    const changed = after.filter((n, i) => n !== before[i]);
    expect(changed.length).toBe(1);
    expect(changed[0].getAttribute("srow")).toBe("1");

    controller.destroy();
    root.remove();
  });

  test("快路徑之後的重繪仍看得到正確底色（快取不失步）", () => {
    // 好讀累積長頁：stableRows 讓逐列節點快取生效，快路徑改過的列必須被正確沿用。
    const first = [row(seg("推 a: 1", color(2, 0))), row(seg("推 b: 2", color(2, 0)))];
    const { root, controller } = mount(first, {
      pageState: 3,
      easyReading: true,
      dropHidden: true,
      stableRows: true,
    });
    controller.setCursorHighlight({ row: 0, cls: "b2", col: 0 });
    expect(highlighted(controller)).toEqual([0]);

    // append 一頁（前綴是同一批列物件 → 走增量路徑）。
    controller.update({
      lines: first.concat([row(seg("推 c: 3", color(2, 0)))]),
      forceWidth: 20,
      enableLinkInlinePreview: false,
      enableLinkHoverPreview: false,
      enhance: Object.assign({}, ENHANCE, {
        pageState: 3,
        easyReading: true,
        dropHidden: true,
        stableRows: true,
      }),
    });
    expect(highlighted(controller)).toEqual([0]);

    controller.destroy();
    root.remove();
  });
});
