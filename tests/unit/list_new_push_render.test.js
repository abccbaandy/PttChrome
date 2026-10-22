// @unit-env browser
// 文章列表的「+N」（new_comments.listNewPush）在兩種列上的畫法：原生／桌機列疊在列尾的留白上
// （放不下就不畫、不撐寬格線）；手機卡片放在標題前面。字都在 ::after（不會被複製）。
import "../../src/css/main.css";
import { buildRow } from "../../src/render/row";
import { buildListCard } from "../../src/render/list_card";
import { listRow, row, seg } from "./helpers/screen_fixtures";

let host;
afterEach(() => {
  if (host) host.remove();
  host = null;
});

function mount(node) {
  host = document.createElement("div");
  host.id = "mainContainer";
  host.style.cssText = "font: 16px monospace; position: absolute; left: 0; top: 0; white-space: pre;";
  host.appendChild(node);
  document.body.appendChild(host);
  return node;
}

describe("原生列", () => {
  test("列尾留白夠 ⇒ 疊在列尾，不撐寬、不進文字", () => {
    const chars = listRow("someone", "□ [心得] 短標題");
    const plain = mount(buildRow({ chars, row: 5, forceWidth: 16 }).node);
    const w0 = plain.getBoundingClientRect().width;
    const text0 = plain.textContent;
    host.remove();
    const node = mount(buildRow({ chars, row: 5, forceWidth: 16, listNewPush: 3 }).node);
    const badge = node.querySelector('[data-type="bbsline"] > .listNewPush');
    expect(badge).not.toBeNull();
    expect(badge.getAttribute("data-new-push")).toBe("+3");
    expect(getComputedStyle(badge, "::after").content).toBe('"+3"');
    expect(node.textContent).toBe(text0);
    expect(node.getBoundingClientRect().width).toBe(w0);
    // 落在列的右半（列尾），而且沒有超出列的右緣
    const line = node.querySelector('[data-type="bbsline"]').getBoundingClientRect();
    const b = badge.getBoundingClientRect();
    expect(b.left).toBeGreaterThan(line.left + line.width / 2);
    expect(b.right).toBeLessThanOrEqual(line.right + 0.5);
  });

  test("標題寫到最後幾格 ⇒ 不畫（不蓋字）", () => {
    const chars = row(seg(" 350024 + 2 6/14 someone      □ " + "x".repeat(80)));
    const node = mount(buildRow({ chars, row: 5, forceWidth: 16, listNewPush: 3 }).node);
    expect(node.querySelector(".listNewPush")).toBeNull();
  });

  test("沒有 listNewPush ⇒ 輸出跟原本一模一樣（golden 不受影響）", () => {
    const chars = listRow("someone", "□ [心得] 短標題");
    const a = buildRow({ chars, row: 5, forceWidth: 16 }).node.outerHTML;
    const b = buildRow({ chars, row: 5, forceWidth: 16, listNewPush: undefined }).node.outerHTML;
    expect(b).toBe(a);
  });
});

describe("手機卡片", () => {
  test("標題行最前面一個徽章，標題文字不變", () => {
    const chars = listRow("someone", "□ [心得] 手機卡片測試");
    const plain = buildListCard({ chars, row: 5, kind: "article", forceWidth: 16 }).node;
    const node = buildListCard({ chars, row: 5, kind: "article", forceWidth: 16, listNewPush: 12 }).node;
    const main = node.querySelector(".listCardTitle .listCardMain");
    expect(main.firstChild.className).toBe("listNewPush");
    expect(main.firstChild.getAttribute("data-new-push")).toBe("+12");
    expect(node.textContent).toBe(plain.textContent);
  });

  test("看板列表的卡片不畫", () => {
    const chars = listRow("someone", "□ [心得] 手機卡片測試");
    const node = buildListCard({ chars, row: 5, kind: "board", forceWidth: 16, listNewPush: 2 }).node;
    expect(node.querySelector(".listNewPush")).toBeNull();
  });
});
