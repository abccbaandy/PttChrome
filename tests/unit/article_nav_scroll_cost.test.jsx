// @unit-env browser
// real-input: tests/e2e/offline/mobile_article_nav.offline.spec.js
// 文章導覽軸在捲動時的每幀成本（docs/handoff/android-battery-drain.md「實機捲動 trace」U8）。
//
// 症狀：好讀文章捲動時，導覽軸每幀①重量所有標記的像素位置（_measure 掛在 .main 的 scroll 上，
// 每個標記一次 offsetTop 走訪）②經 React state 改滑塊位置 ⇒ 整個軸連同最多上千個標記重新
// render。實機約 2.5 ms／幀，是 165Hz 每幀預算的四成，捲動時的耗電主因之一。
// 這裡鎖：
//   1. 捲動不觸發重量標記；內容尺寸變了（圖片載入、閉塊換成實測高度）、閉塊捲近變成照常渲染
//      （塊高不變）照樣會重量。
//   2. 捲動不讓 ArticleNav 元件重新 render；滑塊位置與 aria-valuenow 照樣跟著捲動走。
//   3. 手機「醒著」只在進出醒著的那一刻 render，不是每一幀。
import { Profiler } from "react";
import { render, act } from "@testing-library/react";
import { ArticleNav as NavController } from "../../src/js/article_nav";
import { ArticleNav as NavView } from "../../src/components/ArticleNav";
import { setupI18n } from "../../src/js/i18n";
import { CHUNK_CLASS, CHUNK_NEAR_CLASS } from "../../src/render/screen_chunk";

const ROW_H = 20;
const live = [];
afterEach(() => {
  while (live.length) live.pop().remove();
});

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const frames = async (n) => {
  for (let i = 0; i < n; ++i) await frame();
};

function scroller() {
  const disp = document.createElement("div");
  disp.style.cssText = "position:fixed;left:0;top:0;height:300px;width:400px;overflow-y:auto";
  const mc = document.createElement("div");
  disp.appendChild(mc);
  document.body.appendChild(disp);
  live.push(disp);
  return { disp, mc };
}

function rowNode(parent, tall) {
  const s = document.createElement("span");
  s.setAttribute("type", "bbsrow");
  s.style.cssText = `display:block;height:${ROW_H + (tall || 0)}px`;
  parent.appendChild(s);
  return s;
}

function setup({ mobile = false, chunked = false } = {}) {
  const { disp, mc } = scroller();
  let parent = mc;
  if (chunked) {
    parent = document.createElement("div");
    parent.className = CHUNK_CLASS;
    mc.appendChild(parent);
  }
  const lines = ["作者 someone 看板 Test", "https://i.imgur.com/abcdefg.jpg", "推 abc: 好 10/23 12:34"];
  for (let i = 0; i < 40; ++i) lines.push("內文 " + i);
  lines.push("推 def: 也好 10/23 12:35");
  const nodes = lines.map((_, i) => rowNode(parent, i === 1 ? 1000 : 0));
  const listeners = {};
  const core = {
    mobile,
    buf: {
      pageState: 3,
      cols: 80,
      pageLines: lines,
      getRowText: (r, s, e, acc) => String((acc || lines)[r]),
      addEventListener: (name, fn) => (listeners[name] = fn),
    },
    easyReading: { _enabled: true, _functionMode: false },
    view: {
      mainDisplay: disp,
      mainContainer: mc,
      componentScreen: { rowNode: (r, l) => (l === lines ? nodes[r] || null : undefined) },
    },
  };
  const nav = new NavController(core);
  core.articleNav = nav;
  return { nav, core, disp, nodes, chunk: parent, settle: () => listeners.screenSettled() };
}

async function scrollTo(disp, top) {
  disp.scrollTop = top;
  disp.dispatchEvent(new Event("scroll"));
  await frames(2);
}

describe("捲動時導覽軸不重量標記（U8）", () => {
  test("捲動 ⇒ 不呼叫 _measure；內容長高 ⇒ 照樣重量", async () => {
    const { nav, disp, nodes, settle } = setup();
    settle();
    await frames(3);
    const spy = vi.spyOn(nav, "_measure");
    for (let y = 50; y <= 500; y += 50) await scrollTo(disp, y);
    expect(spy).not.toHaveBeenCalled();

    // 圖片載入：那一列長高 ⇒ ResizeObserver 觸發重量，「推」的像素比例跟著變。
    const before = nav.state.marks.find((m) => m.kind === "comments").f;
    nodes[1].style.height = ROW_H + 3000 + "px";
    await frames(4);
    expect(spy).toHaveBeenCalled();
    const after = nav.state.marks.find((m) => m.kind === "comments").f;
    expect(after).toBeCloseTo((ROW_H * 2 + 3000) / disp.scrollHeight, 4);
    expect(after).not.toBeCloseTo(before, 3);
  });

  test("閉塊捲近變成照常渲染（塊高不變）⇒ 塊內標記從序位估換成真位置", async () => {
    const { nav, disp, chunk, settle } = setup({ chunked: true });
    settle();
    await frames(3);
    const est = nav.state.marks.find((m) => m.kind === "comments").f;
    const real = (ROW_H * 2 + 1000) / disp.scrollHeight;
    expect(est).not.toBeCloseTo(real, 2);
    chunk.classList.add(CHUNK_NEAR_CLASS);
    await frames(4);
    expect(nav.state.marks.find((m) => m.kind === "comments").f).toBeCloseTo(real, 4);
  });
});

describe("捲動時 ArticleNav 元件不重新 render（U8）", () => {
  beforeAll(() => setupI18n());

  async function mount(opts) {
    const s = setup(opts);
    s.settle();
    await frames(3);
    let commits = 0;
    const r = render(
      <Profiler id="nav" onRender={() => ++commits}>
        <NavView pttchrome={{ articleNav: s.nav, view: s.core.view }} />
      </Profiler>,
    );
    await act(async () => {
      await frames(3);
    });
    const el = document.getElementById("articleNav");
    return Object.assign(s, { r, el, commits: () => commits, reset: () => (commits = 0) });
  }

  test("滑塊與 aria-valuenow 跟著捲動，但 0 次 render", async () => {
    const m = await mount();
    expect(m.el).not.toBeNull();
    const thumb = m.el.querySelector(".articleNavThumb");
    const y0 = thumb.getBoundingClientRect().top;
    m.reset();
    const bottom = m.disp.scrollHeight - m.disp.clientHeight;
    await act(async () => {
      for (let y = 100; y <= bottom; y += 100) await scrollTo(m.disp, y);
      await scrollTo(m.disp, bottom);
    });
    expect(m.commits()).toBe(0);
    const y1 = thumb.getBoundingClientRect().top;
    const navRect = m.el.getBoundingClientRect();
    // 捲到底 ⇒ 滑塊下緣貼著軸的下緣（同一把尺：scrollTop / scrollHeight）。
    expect(y1).toBeGreaterThan(y0);
    expect(thumb.getBoundingClientRect().bottom).toBeCloseTo(navRect.bottom, 0);
    expect(Number(m.el.getAttribute("aria-valuenow"))).toBe(Math.round((bottom / m.disp.scrollHeight) * 100));
    m.r.unmount();
  });

  test("手機：連續捲動只在醒來那一刻 render 一次，閒置後收起再一次", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const m = await mount({ mobile: true });
      // 開文那一刻醒著 IDLE_MS（現行行為），之後收起。
      await act(async () => {
        vi.advanceTimersByTime(1600);
      });
      expect(m.el.className).toContain("articleNav--idle");
      m.reset();
      await act(async () => {
        for (let y = 50; y <= 600; y += 50) await scrollTo(m.disp, y);
      });
      expect(m.el.className).not.toContain("articleNav--idle");
      expect(m.commits()).toBe(1);
      await act(async () => {
        vi.advanceTimersByTime(1600);
      });
      expect(m.el.className).toContain("articleNav--idle");
      expect(m.commits()).toBe(2);
      m.r.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
