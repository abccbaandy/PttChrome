// 監聽者故障隔離（src/js/event.js 檔頭、docs/feature-isolation.md；架構 review A1）。
//
// 症狀：TermBuf 的 screenSettled 掛了二十幾個功能，派發是沒有 try/catch 的迴圈 ⇒ 任何一個
// 週邊功能丟例外，排在它後面的（含指令佇列的完成通知）這一幀全部不跑，畫面停在「處理中」。
// 這裡鎖：
//   1. 正式版（非 strict）：後面的監聽者照跑、例外交給 onError；登記了 disable 的功能這次
//      連線停用（收乾淨、之後跳過），enableAllListeners 恢復；沒登記的每幀照樣再試。
//   2. dev build／測試（strict）：照樣往外丟，跟以前一樣（測試不能變鈍）。
//   3. 沒有 isolate 的物件（連線層）不受影響；TermBuf 有 isolate。
//   4. 有登記的功能：小卡、導覽軸的 disable 真的把自己收起來；導覽軸停用後別的入口叫不回來。
//   5. CI 的 e2e 打包版（DEVELOPER_MODE）也是 strict。
import fs from "node:fs";
import path from "node:path";
import { Event, setListenerErrorPolicy, runIsolated } from "../../src/js/event";
import { WhatsNew } from "../../src/js/whats_new";
import { ArticleNav } from "../../src/js/article_nav";

function makeBus(isolate) {
  function Bus() {}
  Event.mixin(Bus.prototype, isolate ? { isolate: true } : undefined);
  return new Bus();
}

let prev;
afterEach(() => {
  if (prev) setListenerErrorPolicy(prev);
  prev = null;
});

describe("正式版（非 strict）", () => {
  test("一個監聽者丟例外 ⇒ 後面的照跑，例外交給 onError", () => {
    const errors = [];
    prev = setListenerErrorPolicy({ strict: false, onError: (info) => errors.push(info) });
    const bus = makeBus(true);
    const ran = [];
    bus.addEventListener("screenSettled", () => ran.push("a"));
    bus.addEventListener("screenSettled", () => {
      throw new Error("boom");
    });
    bus.addEventListener("screenSettled", () => ran.push("c"));
    bus.dispatchEvent({ type: "screenSettled" });
    expect(ran).toEqual(["a", "c"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: "screenSettled", feature: null, disabled: false });
    expect(errors[0].error.message).toBe("boom");
  });

  test("沒登記停用方式 ⇒ 下一幀照樣再試（不知道怎麼收的功能不半套停用）", () => {
    prev = setListenerErrorPolicy({ strict: false, onError: () => {} });
    const bus = makeBus(true);
    let calls = 0;
    bus.addEventListener("screenSettled", () => {
      ++calls;
      throw new Error("boom");
    });
    bus.dispatchEvent({ type: "screenSettled" });
    bus.dispatchEvent({ type: "screenSettled" });
    expect(calls).toBe(2);
  });

  test("登記了 disable ⇒ 收乾淨一次、這次連線跳過；enableAllListeners 恢復", () => {
    const errors = [];
    prev = setListenerErrorPolicy({ strict: false, onError: (info) => errors.push(info) });
    const bus = makeBus(true);
    let calls = 0;
    let fail = true;
    const disable = vi.fn();
    bus.addEventListener(
      "screenSettled",
      () => {
        ++calls;
        if (fail) throw new Error("boom");
      },
      { feature: "showWhatsNew", disable }
    );
    bus.dispatchEvent({ type: "screenSettled" });
    bus.dispatchEvent({ type: "screenSettled" });
    expect(calls).toBe(1);
    expect(disable).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([expect.objectContaining({ feature: "showWhatsNew", disabled: true })]);

    fail = false;
    bus.enableAllListeners();
    bus.dispatchEvent({ type: "screenSettled" });
    expect(calls).toBe(2);
  });

  test("disable 自己也丟例外 ⇒ 照樣停用、這一幀照跑完", () => {
    prev = setListenerErrorPolicy({ strict: false, onError: () => {} });
    const bus = makeBus(true);
    const ran = [];
    bus.addEventListener(
      "screenSettled",
      () => {
        throw new Error("boom");
      },
      {
        feature: "x",
        disable: () => {
          throw new Error("disable boom");
        },
      }
    );
    bus.addEventListener("screenSettled", () => ran.push("after"));
    bus.dispatchEvent({ type: "screenSettled" });
    bus.dispatchEvent({ type: "screenSettled" });
    expect(ran).toEqual(["after", "after"]);
  });

  test("沒有 isolate 的物件（連線層）照原樣丟出", () => {
    prev = setListenerErrorPolicy({ strict: false, onError: () => {} });
    const bus = makeBus(false);
    bus.addEventListener("data", () => {
      throw new Error("conn");
    });
    expect(() => bus.dispatchEvent({ type: "data" })).toThrow("conn");
  });
});

describe("runIsolated（onPrefChange／onClose 用）", () => {
  test("正式版：例外交給 onError（type＝label），呼叫端接著做下一個", () => {
    const errors = [];
    prev = setListenerErrorPolicy({ strict: false, onError: (info) => errors.push(info) });
    const ran = [];
    runIsolated("close:a", () => {
      throw new Error("boom");
    });
    runIsolated("close:b", () => ran.push("b"));
    expect(ran).toEqual(["b"]);
    expect(errors).toEqual([expect.objectContaining({ type: "close:a", feature: null, disabled: false })]);
  });
  test("strict：照樣丟出", () => {
    expect(() =>
      runIsolated("close:a", () => {
        throw new Error("boom");
      })
    ).toThrow("boom");
  });
});

describe("dev build／測試（strict）", () => {
  test("預設就是 strict：照樣往外丟，跟以前一樣", () => {
    const bus = makeBus(true);
    const ran = [];
    bus.addEventListener("screenSettled", () => {
      throw new Error("boom");
    });
    bus.addEventListener("screenSettled", () => ran.push("c"));
    expect(() => bus.dispatchEvent({ type: "screenSettled" })).toThrow("boom");
  });
});

describe("接線", () => {
  test("TermBuf 的事件是 isolate 的（screenSettled 那條鏈）", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../src/js/term_buf.js"), "utf8");
    expect(src).toMatch(/Event\.mixin\(TermBuf\.prototype,\s*\{\s*isolate:\s*true\s*\}\)/);
  });

  test("新功能小卡出錯 ⇒ 這次連線收起、不再接 settle", () => {
    prev = setListenerErrorPolicy({ strict: false, onError: () => {} });
    const bus = makeBus(true);
    bus.getRowText = () => {
      throw new Error("boom");
    };
    bus.cols = 80;
    const wn = new WhatsNew({ buf: bus }, { loadReadme: () => Promise.resolve("") });
    wn._set({ visible: true, items: [{ name: "x", desc: "y" }] });
    bus.dispatchEvent({ type: "screenSettled" });
    expect(wn.state.visible).toBe(false);
  });

  test("e2e 打包版（DEVELOPER_MODE）也是 strict：CI offline／adverse 的 pageerror 斷言不能被吞", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../src/js/event.js"), "utf8");
    const m = src.match(/strict:\s*([^\n]+),\n/);
    expect(m).not.toBeNull();
    expect(m[1]).toMatch(/import\.meta\.env\.DEV/);
    expect(m[1]).toMatch(/process\.env\.DEVELOPER_MODE/);
  });

  test("導覽軸出錯停用 ⇒ resize／推文列這類入口也叫不回來；新連線恢復", () => {
    prev = setListenerErrorPolicy({ strict: false, onError: () => {} });
    const bus = makeBus(true);
    const lines = ["作者 someone 看板 Test", "內文", "推 abc: 好 10/23 12:34"];
    let boom = false;
    Object.defineProperty(bus, "pageLines", {
      get() {
        if (boom) throw new Error("boom");
        return lines;
      },
    });
    bus.pageState = 3;
    bus.cols = 80;
    bus.getRowText = (r, s, e, acc) => String((acc || lines)[r]);
    const core = {
      mobile: false,
      buf: bus,
      easyReading: { _enabled: true, _functionMode: false, scrollToArticleRow: () => true },
      view: {
        mainDisplay: {
          getBoundingClientRect: () => ({ left: 0, right: 800, top: 0, bottom: 600, width: 800 }),
          scrollHeight: 2000,
          clientHeight: 600,
          scrollTop: 0,
        },
      },
    };
    vi.stubGlobal("window", {
      innerHeight: 600,
      innerWidth: 800,
      addEventListener: () => {},
      getComputedStyle: () => ({ display: "block" }),
    });
    try {
      const nav = new ArticleNav(core);
      bus.dispatchEvent({ type: "screenSettled" });
      expect(nav.state.visible).toBe(true);
      boom = true;
      bus.dispatchEvent({ type: "screenSettled" });
      expect(nav.state.visible).toBe(false);
      boom = false;
      nav.refresh(); // resize／推文列 onChange 走的入口
      expect(nav.state.visible).toBe(false);
      bus.enableAllListeners();
      bus.dispatchEvent({ type: "screenSettled" });
      expect(nav.state.visible).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("導覽軸登記了停用方式（收起軸）", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../src/js/article_nav.js"), "utf8");
    expect(src).toMatch(/feature:\s*'enableArticleNav',\s*disable:\s*\(\)\s*=>\s*self\._set\(\{\s*visible:\s*false\s*\}\)/);
  });
});
