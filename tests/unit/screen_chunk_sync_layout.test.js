// @unit-env browser
// 長頁分塊的瀏覽器事實：**新塊在第一次 rendering update 之前，同步讀版面拿到的是估計
// 高度，不是真高度**（真 Chromium 量測，2026-10）。
//
// 為什麼要鎖：`content-visibility: auto` 的塊是否照常渲染，由瀏覽器在 rendering update
// （rAF 之後、paint 之前）才判定。render 完、同一個 task 裡立刻量 offsetHeight／
// scrollHeight／getBoundingClientRect，量到的是 `contain-intrinsic-height`（CHUNK_ROWS
// 列）的估計值。這個狀態不會被畫出來（paint 前已修正），但程式讀得到：
//   - `scrollTop = scrollHeight` 會落在估計出來的底部（EasyReading._scrollBottom 的
//     followBottom；End 之後由 bottom_stick 的 ResizeObserver 在 paint 前收尾）；
//   - offline e2e 在 rAF／viewUpdate 量會偶發量到 +2953／-986（已改用
//     helpers/layout.js#installPaintedFrameProbe）。
// 新增「render 之後同步量座標、而且結果會拿去用」的程式碼：先 renderChunksAround(el)，
// 或改在下一幀量。細節見 src/render/screen_chunk.js 檔頭不變量 6。
import mainCss from "../../src/css/main.css?raw";
import { CHUNK_ROWS, CHUNK_CLASS, renderChunksAround } from "../../src/render/screen_chunk";

const STRIPPED = mainCss.replace(/\/\*[\s\S]*?\*\//g, "");
// 只取 main.css 裡塊本身的兩條規則（估計高度、照常渲染），版面其餘部分自備 ⇒ 數字可預期。
const chunkRules = Array.from(STRIPPED.matchAll(/([^{}]*\.screenChunk[^{}]*)\{([^}]*)\}/g))
  .filter((m) => !m[1].includes("#mainContainer"))
  .map((m) => `${m[1]}{${m[2]}}`)
  .join("\n");

const LINE = 20;
const TAIL_ROWS = 30;
const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

let sc, style;
beforeEach(() => {
  style = document.createElement("style");
  style.textContent = `${chunkRules}\n.syncLayoutScroller{height:300px;overflow:auto;line-height:${LINE}px}`;
  document.head.appendChild(style);
  sc = document.createElement("div");
  sc.className = "syncLayoutScroller";
  const head = document.createElement("div");
  head.style.height = "2000px";
  sc.appendChild(head);
  document.body.appendChild(sc);
});
afterEach(() => {
  sc.remove();
  style.remove();
});

function appendChunk(rows) {
  const c = document.createElement("div");
  c.className = CHUNK_CLASS;
  for (let i = 0; i < rows; ++i) {
    const r = document.createElement("div");
    r.textContent = `row ${i}`;
    c.appendChild(r);
  }
  sc.appendChild(c);
  return c;
}

test("前提：main.css 的塊規則有被取到（估計高度＋照常渲染兩條）", () => {
  expect(chunkRules).toContain("content-visibility");
  expect(chunkRules).toContain("contain-intrinsic-height");
  expect(chunkRules).toContain("screenChunkNear");
});

test("新塊同步量到的是估計高度（CHUNK_ROWS 列），貼底也落在估計出來的底部", () => {
  const c = appendChunk(TAIL_ROWS);
  expect(c.offsetHeight).toBe(CHUNK_ROWS * LINE);
  sc.scrollTop = sc.scrollHeight;
  const realBottom = 2000 + TAIL_ROWS * LINE - sc.clientHeight;
  expect(sc.scrollTop).toBeGreaterThan(realBottom);
});

test("過一次 rendering update 之後，視窗內的塊才是真高度", async () => {
  const c = appendChunk(TAIL_ROWS);
  sc.scrollTop = sc.scrollHeight;
  await frame();
  await frame();
  expect(c.offsetHeight).toBe(TAIL_ROWS * LINE);
  expect(sc.scrollTop).toBe(sc.scrollHeight - sc.clientHeight);
});

test("renderChunksAround 之後同一個 task 就量得到真高度（程式要捲到某列前的正確作法）", () => {
  const c = appendChunk(TAIL_ROWS);
  renderChunksAround(c.lastElementChild);
  expect(c.offsetHeight).toBe(TAIL_ROWS * LINE);
  sc.scrollTop = sc.scrollHeight;
  expect(sc.scrollTop).toBe(2000 + TAIL_ROWS * LINE - sc.clientHeight);
});
