// @unit-env browser
// 開站載入提示（index.html #bootLoading＋src/js/boot_loading.js）。
// 守的事：
//   1) 這塊不准帶任何外部資源：它的目的就是快取沒命中時給畫面，若自己再發請求，
//      會跟主程式搶頻寬、讓最慢的那段更慢。
//   2) 分段推進／失敗訊息／拆除的行為。
//   3) main.jsx 一定會拆掉它：它是 fixed 全螢幕、疊在 #BBSWindow 上面，忘了拆＝整個
//      終端機被蓋住、點不到。
import indexHtml from "../../index.html?raw";
import mainSrc from "../../src/js/main.jsx?raw";
import {
  setBootStage,
  failBootLoading,
  finishBootLoading
} from "../../src/js/boot_loading";

const doc = new DOMParser().parseFromString(indexHtml, "text/html");

function mount() {
  document.getElementById("bootLoading")?.remove();
  const node = doc.getElementById("bootLoading").cloneNode(true);
  // 測試只要結構；inline script 由瀏覽器解析 index.html 時跑，這裡不重跑。
  node.querySelectorAll("script").forEach(s => s.remove());
  document.body.appendChild(node);
  return node;
}

const q = part => document.querySelector('#bootLoading [data-boot="' + part + '"]');

afterEach(() => document.getElementById("bootLoading")?.remove());

describe("index.html 的載入提示", () => {
  test("存在且在 body 最前面（主程式下載期間就要看得到）", () => {
    expect(doc.body.firstElementChild.id).toBe("bootLoading");
  });

  test("不帶任何外部資源", () => {
    const root = doc.getElementById("bootLoading");
    expect(root.querySelectorAll("[src],[href],img,link,iframe").length).toBe(0);
    const css = [...doc.querySelectorAll("style")]
      .map(s => s.textContent)
      .filter(t => t.includes("#bootLoading"));
    expect(css.length).toBeGreaterThan(0);
    for (const t of css) expect(t).not.toMatch(/url\(|@import|@font-face/);
  });
});

describe("boot_loading", () => {
  test("分段推進：進度條變長、文字更新", () => {
    mount();
    const initial = parseFloat(q("bar").style.width || "0");
    setBootStage("resources");
    const mid = parseFloat(q("bar").style.width);
    setBootStage("starting");
    const late = parseFloat(q("bar").style.width);
    expect(mid).toBeGreaterThan(initial);
    expect(late).toBeGreaterThan(mid);
    expect(q("label").textContent).not.toBe("");
  });

  test("失敗：顯示錯誤訊息並標記", () => {
    const root = mount();
    failBootLoading();
    expect(root.hasAttribute("data-failed")).toBe(true);
    expect(q("label").textContent).toMatch(/重新整理|reload/i);
  });

  test("finish 拆掉整塊", () => {
    mount();
    finishBootLoading();
    expect(document.getElementById("bootLoading")).toBeNull();
  });

  test("元素不存在（已拆、或嵌入別的頁面）時不丟例外", () => {
    expect(() => {
      setBootStage("resources");
      failBootLoading();
      finishBootLoading();
    }).not.toThrow();
  });

  test("main.jsx 會拆掉它，也會在資源載入失敗時改顯示錯誤", () => {
    expect(mainSrc).toMatch(/finishBootLoading\(\)/);
    expect(mainSrc).toMatch(/failBootLoading\(\)/);
  });
});
