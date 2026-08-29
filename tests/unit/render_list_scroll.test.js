// 列表好讀的 body 捲動視口（平滑捲動的次列位移）。
//
// golden（render_dom_equivalence 的 list_easy_reading_scrolled）鎖的是靜態結構；
// 這一支鎖的是 golden 序列化不到、但一壞就是「畫面不動／列跑到 header 上面」的
// 動態部分：scrollTop 的寫入點、切回其他畫面時視口要收掉、以及快路徑
// （setListScrollOffset）不重畫也能捲。
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { row, seg, listRow } from "./helpers/screen_fixtures";

afterEach(() => unmountAll());

const LINES = (() => {
  const out = [
    row(seg("看板《Test》")),
    row(seg("  編號     日 期  作 者        文  章  標  題")),
    row(seg("")),
  ];
  for (let i = 0; i < 20; ++i) out.push(listRow("someone", "□ [心得] 第 " + i + " 篇"));
  out.push(row(seg(" 文章選讀  (y)回應(X)推文")));
  out.push(listRow("someone", "□ [心得] 露出一小條的下一列"));
  return out;
})();

const listScroll = (over) => ({
  bodyStart: 3,
  bodyRows: 20,
  viewportPx: 400,
  offsetPx: over.offsetPx,
  overscan: over.overscan,
});

const props = (offsetPx, overscan) => ({
  lines: overscan ? LINES : LINES.slice(0, 24),
  enableLinkInlinePreview: false,
  enableLinkHoverPreview: false,
  enhance: {
    pageState: 2,
    listEasyReading: true,
    easyReading: true,
    listScroll: listScroll({ offsetPx, overscan }),
  },
});

describe("列表好讀 body 捲動視口", () => {
  test("body 列住進視口、header/footer 留在容器；視口高度＝body 高度", () => {
    const m = mountScreen(props(7, true));
    const view = m.container.querySelector(".listBodyView");
    expect(view).not.toBeNull();
    expect(view.style.height).toBe("400px");
    // header 3 列 + 視口 + footer 1 列 ＝ 容器的 5 個直系子節點
    const kids = Array.from(m.container.children);
    expect(kids.indexOf(view)).toBe(3);
    const rowOf = (n) => n.querySelector("[data-row]").getAttribute("data-row");
    expect(kids.slice(0, 3).map(rowOf)).toEqual(["0", "1", "2"]);
    expect(rowOf(kids[4])).toBe("23"); // footer 仍是 data-row 23（外部契約）
    // 視口裡是 body 20 列 + overscan（data-row 24，排在最後）
    const inView = Array.from(view.children).map(rowOf);
    expect(inView.length).toBe(21);
    expect(inView[0]).toBe("3");
    expect(inView[19]).toBe("22");
    expect(inView[20]).toBe("24");
  });

  test("offsetPx 就是視口的 scrollTop（次列位移的唯一表達）", () => {
    const m = mountScreen(props(7, true));
    const view = m.container.querySelector(".listBodyView");
    // jsdom 沒有版面 ⇒ scrollTop 寫得進去但會被夾成 0；驗「有寫」即可。
    const writes = [];
    Object.defineProperty(view, "scrollTop", {
      configurable: true,
      get: () => 0,
      set: (v) => writes.push(v),
    });
    m.update(props(13, true));
    expect(writes).toContain(13);
    // 快路徑：不重畫也捲得動（滾輪動畫每幀都走這條）
    m.controller.setListScrollOffset(21);
    expect(writes).toContain(21);
  });

  test("對齊時（offset 0、無 overscan）視口裡就是 20 列，畫面仍是 24 列", () => {
    const m = mountScreen(props(0, false));
    const view = m.container.querySelector(".listBodyView");
    expect(view.children.length).toBe(20);
    expect(m.container.querySelectorAll('[data-type="bbsline"]').length).toBe(24);
  });

  test("切回非列表畫面：視口收掉，列回到容器直系子層", () => {
    const m = mountScreen(props(7, true));
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
});
