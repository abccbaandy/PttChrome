// 列表好讀的 body 捲動視口（瀏覽器原生捲動）。
//
// golden（render_dom_equivalence 的 list_easy_reading_scrolled）鎖的是靜態結構；
// 這一支鎖的是 golden 序列化不到、但一壞就是「捲不動／畫面不動／列跑到 header
// 上面」的動態部分：視口的 overflow 開關（frozen 與 pref 靠它吞掉捲動）、
// scroll 事件的接線、以及切回其他畫面時視口要收掉。
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { row, seg, listRow } from "./helpers/screen_fixtures";

afterEach(() => unmountAll());

// header 3 + 40 列 body + footer ＝ 44 列；視口只有 20 列高 ⇒ 有可捲距離。
const BODY_ROWS = 40;
const LINES = (() => {
  const out = [
    row(seg("看板《Test》")),
    row(seg("  編號     日 期  作 者        文  章  標  題")),
    row(seg("")),
  ];
  for (let i = 0; i < BODY_ROWS; ++i)
    out.push(listRow("someone", "□ [心得] 第 " + i + " 篇"));
  out.push(row(seg(" 文章選讀  (y)回應(X)推文")));
  return out;
})();

const props = (scrollable = true, lines = LINES) => ({
  lines,
  enableLinkInlinePreview: false,
  enableLinkHoverPreview: false,
  enhance: {
    pageState: 2,
    listEasyReading: true,
    easyReading: true,
    listScroll: { bodyStart: 3, viewportPx: 400, scrollable },
  },
});

const rowOf = (n) => n.querySelector("[data-row]").getAttribute("data-row");

describe("列表好讀 body 捲動視口", () => {
  test("整段序列住進視口、header/footer 留在容器；視口高度＝body 高度", () => {
    const m = mountScreen(props());
    const view = m.container.querySelector(".listBodyView");
    expect(view).not.toBeNull();
    expect(view.style.height).toBe("400px");

    // header 3 列 + 視口 + footer 1 列 ＝ 容器的 5 個直系子節點
    const kids = Array.from(m.container.children);
    expect(kids.indexOf(view)).toBe(3);
    expect(kids.slice(0, 3).map(rowOf)).toEqual(["0", "1", "2"]);
    // footer 恆是最後一列 ⇒ data-row 隨序列長度走（3 + 40）
    expect(rowOf(kids[4])).toBe(String(3 + BODY_ROWS));

    // 視口裡是整段序列（不是 20 列切片）
    const inView = Array.from(view.children).map(rowOf);
    expect(inView.length).toBe(BODY_ROWS);
    expect(inView[0]).toBe("3");
    expect(inView[BODY_ROWS - 1]).toBe(String(2 + BODY_ROWS));
  });

  test("scrollable ⇒ overflow-y:auto（使用者捲得動）", () => {
    const m = mountScreen(props(true));
    expect(m.container.querySelector(".listBodyView").style.overflowY).toBe("auto");
  });

  test("frozen／pref 關掉 ⇒ overflow-y:hidden（吞掉捲動，但 scrollTop 仍有效）", () => {
    // window 上的 wheel listener 在 Chrome 是 passive ⇒ preventDefault 是 no-op，
    // 「吞掉捲動」只能靠 overflow。hidden 的元素仍是 scroll container。
    const m = mountScreen(props(false));
    const view = m.container.querySelector(".listBodyView");
    expect(view.style.overflowY).toBe("hidden");
    m.controller.setListScrollTop(120);
    expect(m.controller.getListScrollTop()).toBe(120);
  });

  test("scroll 事件轉發給 onListScroll（listener 只掛一次，重畫不重複掛）", () => {
    const m = mountScreen(props());
    const view = m.container.querySelector(".listBodyView");
    const hits = [];
    m.controller.onListScroll = () => hits.push(1);

    view.dispatchEvent(new Event("scroll"));
    expect(hits.length).toBe(1);

    m.update(props());
    expect(m.container.querySelector(".listBodyView")).toBe(view); // 同一個節點
    view.dispatchEvent(new Event("scroll"));
    expect(hits.length).toBe(2); // 不是 3 ⇒ 沒有重複掛
  });

  test("捲動存取一律走 controller（jsdom 沒有 Element.scrollTo）", () => {
    const m = mountScreen(props());
    const view = m.container.querySelector(".listBodyView");
    const writes = [];
    Object.defineProperty(view, "scrollTop", {
      configurable: true,
      get: () => 0,
      set: (v) => writes.push(v),
    });

    m.controller.setListScrollTop(37);
    expect(writes).toContain(37);
    // smooth 在沒有 scrollTo 的環境要退回直接寫，不能整條路徑爆掉
    view.scrollTo = undefined;
    m.controller.scrollListTo(64, "smooth");
    expect(writes).toContain(64);
  });

  test("短板（序列比視口短）：仍是同一套結構，只是沒有可捲距離", () => {
    const short = LINES.slice(0, 3)
      .concat(LINES.slice(3, 3 + 20))
      .concat([LINES[LINES.length - 1]]);
    const m = mountScreen(props(true, short));
    const view = m.container.querySelector(".listBodyView");
    expect(view.children.length).toBe(20);
    expect(m.container.querySelectorAll('[data-type="bbsline"]').length).toBe(24);
  });

  test("切回非列表畫面：視口收掉，列回到容器直系子層", () => {
    const m = mountScreen(props());
    expect(m.container.querySelector(".listBodyView")).not.toBeNull();
    m.update({
      lines: LINES.slice(0, 24),
      enableLinkInlinePreview: false,
      enableLinkHoverPreview: false,
      enhance: { pageState: 3, easyReading: false },
    });
    expect(m.container.querySelector(".listBodyView")).toBeNull();
    expect(m.container.children.length).toBe(24);
  });

  // 視口節點是 controller 上的常駐快取，收掉之後**還在**、只是 detached ——
  // 而 detached 節點的 scrollTop 恆為 0。那是「沒有資訊」不是「捲到最上面」，
  // 所以 ListSession 需要問得出「視口現在還在不在 DOM 上」。
  test("hasListViewport()：視口收掉後為 false，回到列表好讀又為 true", () => {
    const m = mountScreen(props());
    expect(m.controller.hasListViewport()).toBe(true);

    m.update({
      lines: LINES.slice(0, 24),
      enableLinkInlinePreview: false,
      enableLinkHoverPreview: false,
      enhance: { pageState: 3, easyReading: false },
    });
    expect(m.controller.hasListViewport()).toBe(false);
    expect(m.controller.getListScrollTop()).toBe(0); // 節點還在，但量不到東西

    m.update(props());
    expect(m.controller.hasListViewport()).toBe(true);
  });
});
