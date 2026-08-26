// App.doCopy 對「剪貼簿寫入被拒」的處置（src/js/pttchrome.jsx）。
//
// navigator.clipboard.writeText 在 document 沒有焦點 / 非 secure context /
// 權限被拒時會 reject NotAllowedError。原本的實作是裸呼叫、不接 rejection：
//   - 真實使用者：console 冒出 Uncaught (in promise) NotAllowedError。
//   - 離線 e2e：Vite HMR client 把這顆 unhandled rejection 轉發回 dev server
//     （vite:forward-console），流量又被 stub WebSocket 記成「app 送出的 bytes」
//     → long_push / mouse 這些讀 __sent 的 spec 偶發紅。
// 另外 jsdom / 非 secure context 下 navigator.clipboard 根本不存在，裸呼叫是
// 同步 TypeError，會把呼叫端整條路徑炸斷（長推文取消收尾就走這條）。
import { App } from "../../src/js/pttchrome";

const makeApp = () => Object.create(App.prototype);

const withClipboard = (clip, fn) => {
  const had = Object.prototype.hasOwnProperty.call(navigator, "clipboard");
  const prev = navigator.clipboard;
  Object.defineProperty(navigator, "clipboard", {
    value: clip,
    configurable: true,
    writable: true,
  });
  try {
    return fn();
  } finally {
    if (had)
      Object.defineProperty(navigator, "clipboard", {
        value: prev,
        configurable: true,
        writable: true,
      });
    else delete navigator.clipboard;
  }
};

// 真正的症狀：process 層有沒有冒出 unhandled rejection。
const countUnhandled = async (fn) => {
  const seen = [];
  const on = (r) => seen.push(r);
  process.on("unhandledRejection", on);
  try {
    await fn();
    // unhandledRejection 在 microtask queue 排空後才判定，多等一拍。
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off("unhandledRejection", on);
  }
  return seen;
};

describe("App.doCopy", () => {
  test("writeText reject（NotAllowedError）不得留下 unhandled rejection（REGRESSION）", async () => {
    const err = Object.assign(new Error("Write permission denied."), {
      name: "NotAllowedError",
    });
    // 這裡**不能用 vi.fn**：tinyspy 會替回傳的 promise 掛上追蹤用的 handler，
    // rejection 就不再算「無人接管」⇒ 這條測試永遠綠。用裸函式手動記次數。
    let calls = 0;
    const writeText = () => {
      calls++;
      return Promise.reject(err);
    };
    const seen = await countUnhandled(() =>
      withClipboard({ writeText }, () => {
        makeApp().doCopy("hello");
      })
    );
    expect(calls).toBe(1);
    expect(seen).toEqual([]);
  });

  test("writeText 同步 throw 也不得炸到呼叫端", () => {
    const writeText = () => {
      throw new Error("boom");
    };
    withClipboard({ writeText }, () => {
      expect(() => makeApp().doCopy("hello")).not.toThrow();
    });
  });

  test("沒有 navigator.clipboard（非 secure context）→ 靜靜放棄，不 throw", () => {
    withClipboard(undefined, () => {
      expect(() => makeApp().doCopy("hello")).not.toThrow();
    });
  });

  test("成功時仍然寫進剪貼簿，且走 normalizeCopyText（\n → \r）", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    await withClipboard({ writeText }, async () => {
      await makeApp().doCopy("a\nb");
    });
    expect(writeText).toHaveBeenCalledWith("a\rb");
  });
});
