// 通知的兩道閘門（純函式，無 DOM/React 耦合）：什麼時候該「問權限」、什麼時候
// 該「閉嘴」。兩者都是實測回報的 bug 修復，測試就是它們的規格書。
//
// 1) ensureNotifyPermission —— 權限請求時機。原本只在 PrefModal 勾選 checkbox 的
//    當下問，但兩個通知 pref 的預設值都是 true ⇒ 使用者不會去勾一個已經勾好的框
//    ⇒ 權限永遠停在 'default' ⇒ 系統通知永遠不出現。
// 2) isDocumentForeground —— 分頁就在眼前時不該出聲。**不只是省一則通知**：
//    stopTitleFlash 掛在 window 'focus' 與 'visibilitychange' 上，分頁本來就在前景
//    的話這兩個事件都不會再來，標題會一直閃到使用者切走再切回來為止。

import {
  ensureNotifyPermission,
  isDocumentForeground
} from "../../src/js/notification_gate";

// 假 Notification：只需要 permission 與 requestPermission 兩個靜態成員。
function installNotification({ permission = "default", request } = {}) {
  const calls = [];
  const Ctor = function() {};
  Ctor.permission = permission;
  Ctor.requestPermission = (...args) => {
    calls.push(args);
    if (request) return request(...args);
    return Promise.resolve(permission);
  };
  globalThis.Notification = Ctor;
  return calls;
}

const fakeDoc = (visibilityState, hasFocus) => {
  const doc = { visibilityState };
  if (hasFocus !== undefined) doc.hasFocus = () => hasFocus;
  return doc;
};

afterEach(() => {
  delete globalThis.Notification;
});

describe("ensureNotifyPermission（權限請求時機）", () => {
  test("開關為開且權限還沒問過（default）→ 送出請求", async () => {
    const calls = installNotification({ permission: "default" });
    const seen = [];
    expect(ensureNotifyPermission(true, (r) => seen.push(r))).toBe(true);
    expect(calls).toHaveLength(1);
    await Promise.resolve();
    expect(seen).toEqual(["default"]);
  });

  test("已授權（granted）→ 不再打擾使用者，只回報現況", () => {
    const calls = installNotification({ permission: "granted" });
    const seen = [];
    expect(ensureNotifyPermission(true, (r) => seen.push(r))).toBe(false);
    expect(calls).toHaveLength(0);
    expect(seen).toEqual(["granted"]);
  });

  // 被封鎖後再問也叫不出彈窗（瀏覽器直接回 denied），只會白白吃掉一次 user
  // activation。呼叫端要拿這個結果去顯示「已被瀏覽器封鎖」的提示。
  test("已封鎖（denied）→ 不送請求，回報 denied", () => {
    const calls = installNotification({ permission: "denied" });
    const seen = [];
    expect(ensureNotifyPermission(true, (r) => seen.push(r))).toBe(false);
    expect(calls).toHaveLength(0);
    expect(seen).toEqual(["denied"]);
  });

  test("開關是關的 → 完全不碰權限（沒頭沒尾的權限彈窗比少一則通知更糟）", () => {
    const calls = installNotification({ permission: "default" });
    const seen = [];
    expect(ensureNotifyPermission(false, (r) => seen.push(r))).toBe(false);
    expect(calls).toHaveLength(0);
    expect(seen).toEqual([]);
  });

  test("瀏覽器沒有 Notification（非 secure context）→ 回 false，不炸", () => {
    delete globalThis.Notification;
    expect(() => ensureNotifyPermission(true)).not.toThrow();
    expect(ensureNotifyPermission(true)).toBe(false);
  });

  test("沒有 onResult 也不炸（關閉設定頁那條路不需要回報）", () => {
    installNotification({ permission: "granted" });
    expect(() => ensureNotifyPermission(true)).not.toThrow();
  });

  // 舊介面是 callback-only，回 undefined。接 .then 之前一定要先檢查。
  test("callback-only 的舊介面（回 undefined）→ 不炸", () => {
    installNotification({ permission: "default", request: () => undefined });
    expect(() => ensureNotifyPermission(true, () => {})).not.toThrow();
  });

  test("requestPermission 直接 throw（政策封鎖等）→ 不炸，當作 denied", () => {
    installNotification({
      permission: "default",
      request: () => {
        throw new Error("NotAllowedError");
      }
    });
    const seen = [];
    expect(ensureNotifyPermission(true, (r) => seen.push(r))).toBe(false);
    expect(seen).toEqual(["denied"]);
  });

  test("Promise 被 reject → 不留下未處理的 rejection，回報 denied", async () => {
    installNotification({
      permission: "default",
      request: () => Promise.reject(new Error("nope"))
    });
    const seen = [];
    ensureNotifyPermission(true, (r) => seen.push(r));
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(["denied"]);
  });
});

describe("isDocumentForeground（分頁是不是就在眼前）", () => {
  test("可見且有焦點 → 前景", () => {
    expect(isDocumentForeground(fakeDoc("visible", true))).toBe(true);
  });

  test("分頁被切走（hidden）→ 不是前景", () => {
    expect(isDocumentForeground(fakeDoc("hidden", true))).toBe(false);
  });

  // 雙視窗並排：本分頁看得見，但使用者的眼睛在另一個視窗的新分頁上 ⇒ 照發通知。
  // 寧可多通知一則，也不要漏掉真的該出聲的情況。
  test("看得見但焦點在別的視窗 → 不是前景", () => {
    expect(isDocumentForeground(fakeDoc("visible", false))).toBe(false);
  });

  test("沒有 document / 沒有 hasFocus → 保守當作背景（維持原本會通知的行為）", () => {
    expect(isDocumentForeground(fakeDoc("visible", undefined))).toBe(false);
    expect(isDocumentForeground(null)).toBe(false);
    expect(isDocumentForeground(undefined)).toBe(false);
  });

  test("hasFocus 自己 throw 也不炸", () => {
    const doc = {
      visibilityState: "visible",
      hasFocus() {
        throw new Error("boom");
      }
    };
    expect(isDocumentForeground(doc)).toBe(false);
  });
});
