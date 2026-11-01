// 列表忙時點的那一下（src/js/list_pending_click.js，P47）：交易結束、那篇還在原處才替使用者開；
// 認不出就作廢、一個 byte 都不送（認不出 ⇒ 原生）。
// real-input: tests/e2e/offline/easy-reading-list.offline.spec.js（真滑鼠點凍結中的列表）
import { canQueueListClick, pendingClickDecision, PENDING_CLICK_MS } from "../../src/js/list_pending_click";

describe("canQueueListClick：只記「還在這個列表、畫面凍著」的交易", () => {
  test("凍結交易（到底／跳號／補頁接合／原地重整）與 cursor-sync 那一小段 ⇒ 記", () => {
    expect(canQueueListClick("functionMode", "frozen")).toBe(true);
    expect(canQueueListClick("functionMode", "buffer")).toBe(true);
    expect(canQueueListClick("active", "frozen")).toBe(true);
  });
  test("開文中、讀文章中、原生鏡像 ⇒ 不記（不是很快會回到同一份列表）", () => {
    expect(canQueueListClick("opening", "frozen")).toBe(false);
    expect(canQueueListClick("suspended", "frozen")).toBe(false);
    expect(canQueueListClick("functionMode", "native")).toBe(false);
    expect(canQueueListClick("idle", "native")).toBe(false);
  });
});

describe("pendingClickDecision", () => {
  const identity = { author: "alice", subject: "[閒聊] 測試" };
  const pending = { num: 1234, identity, board: "Test", at: 1000 };
  const done = { pending, state: "active", renderMode: "buffer", now: 2000, board: "Test", rowIdentity: identity };

  test("沒有記著的 ⇒ none", () => {
    expect(pendingClickDecision({ ...done, pending: null }).action).toBe("none");
  });
  test("交易還沒結束 ⇒ 等", () => {
    expect(pendingClickDecision({ ...done, state: "functionMode", renderMode: "frozen" }).action).toBe("wait");
  });
  test("交易結束、同一板、同編號那一列還是同作者同主題 ⇒ 開", () => {
    expect(pendingClickDecision(done).action).toBe("open");
    // 列表標題被截斷（…）也認
    expect(pendingClickDecision({ ...done, rowIdentity: { author: "alice", subject: "[閒聊] 測…" } }).action).toBe("open");
  });
  test("同編號換人了（快照之後刪文／搬文）⇒ 作廢，不開別篇", () => {
    expect(pendingClickDecision({ ...done, rowIdentity: { author: "bob", subject: "[閒聊] 測試" } })).toEqual({
      action: "drop",
      reason: "moved",
    });
    expect(pendingClickDecision({ ...done, rowIdentity: { author: "alice", subject: "[問卦] 別的" } }).reason).toBe("moved");
  });
  // 同一人同一串連續幾篇身分一樣（主題剝掉 Re:）：交易（原地重整、補頁接合）換掉緩衝時前面
  // 刪掉一篇，同一個編號落到同身分的另一篇，光看那一列認不出 ⇒ 舊碼替使用者開錯篇。
  // 緩衝裡同身分兩列以上時，點下去當時 ±1 的鄰居要跟現在一樣。
  test("同身分兩列以上 ⇒ 鄰居跟點下去時不一樣就作廢", () => {
    const carol = { author: "carol", subject: "[問題] 前一篇" };
    const bob = { author: "bob", subject: "[閒聊] 後一篇" };
    const p = { ...pending, neighbors: { prev: carol, next: identity } };
    const base = { ...done, pending: p, sameIdentityCount: 2 };
    // 前面刪掉一篇：前一號變成同身分的那一篇、後一號是 bob。
    expect(pendingClickDecision({ ...base, neighborsNow: { prev: identity, next: bob } })).toEqual({ action: "drop", reason: "moved" });
    // 沒移動 ⇒ 開。
    expect(pendingClickDecision({ ...base, neighborsNow: { prev: carol, next: identity } }).action).toBe("open");
    // 鄰居都讀不出來（被刪、不在緩衝）⇒ 分不出，作廢。
    expect(pendingClickDecision({ ...base, neighborsNow: { prev: null, next: null } }).reason).toBe("moved");
    // 只有一列同身分 ⇒ 身分就夠，不看鄰居。
    expect(pendingClickDecision({ ...base, sameIdentityCount: 1, neighborsNow: { prev: identity, next: bob } }).action).toBe("open");
  });
  test("那個編號已經不在畫得出來的列表上 ⇒ 作廢", () => {
    expect(pendingClickDecision({ ...done, rowIdentity: null }).reason).toBe("moved");
  });
  test("換了看板（交易是離板）⇒ 作廢", () => {
    expect(pendingClickDecision({ ...done, board: "Other" }).reason).toBe("board");
    expect(pendingClickDecision({ ...done, board: null }).reason).toBe("board");
  });
  test("交易收成原生鏡像、離開列表、開了別篇 ⇒ 作廢", () => {
    expect(pendingClickDecision({ ...done, state: "functionMode", renderMode: "native" }).reason).toBe("left");
    expect(pendingClickDecision({ ...done, state: "idle", renderMode: "native" }).reason).toBe("left");
    expect(pendingClickDecision({ ...done, state: "opening", renderMode: "frozen" }).reason).toBe("left");
  });
  test("等太久（使用者早就不記得點過）⇒ 作廢，就算交易剛好結束也不開", () => {
    expect(pendingClickDecision({ ...done, now: 1000 + PENDING_CLICK_MS + 1 }).reason).toBe("expired");
    expect(
      pendingClickDecision({ ...done, state: "functionMode", renderMode: "frozen", now: 1000 + PENDING_CLICK_MS + 1 }).reason
    ).toBe("expired");
  });
});
