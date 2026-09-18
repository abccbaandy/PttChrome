// 好讀模式的送鍵閘門（EasyReading._send）。
//
// CommandQueue 的整個設計前提是「同時只有一個鍵在線上，回應由畫面內容判定」。
// 使用者的鍵盤早就被 term_view/pttchrome 的入口擋掉了；漏掉的是好讀**狀態機
// 自己送的鍵** —— 它繞過 queue 直接送。deep link 把兩者湊在一起就爆了。
//
// 兩個實測症狀（2026-08-16），同一個根因：
//   a) `#Steam/<aid>`（有進板畫面的看板）跳轉卡死：進板畫面是 pmore，與一篇
//      文章同形，好讀把公告當文章累積並送 PageDown → 餵掉進板畫面收尾的
//      pressanykey（mbbsd/bbs.c:4470-4477）→ 導航的 ← 永遠等不到它要的畫面。
//   b) 「複製本篇連結」複製完就跳出文章：落地後好讀正把文章自動翻到底，它的
//      PageDown 先關掉了 Q 資訊框、又把 pager 翻到 100%，於是 dismissPostInfo
//      送的空白鍵成了 pmore 的「離開」。
//
// 只擋 aidNavigation.active 不夠（b 不在導航中），只進 functionMode 也不夠：
// _onViewUpdated 處理 sendCommandAfterUpdate 那段沒有看 functionMode，進入鏡像
// 模式**之前**就排好的 PageDown 照樣送得出去。

import { EasyReading } from "../../src/js/easy_reading";

function harness({ active = false, inFlightKind = null, longPushBusy = false } = {}) {
  const sent = [];
  return {
    ctx: {
      _core: {
        aidNavigation: { active },
        commandQueue: { inFlightKind },
        longPush: { busy: longPushBusy }
      },
      _view: { _send: d => sent.push(d) },
      _wireBusy: EasyReading.prototype._wireBusy
    },
    sent
  };
}

const send = (ctx, data) => EasyReading.prototype._send.call(ctx, data);

test("AID 導航進行中：好讀送出的鍵一律吞掉", () => {
  const h = harness({ active: true });
  send(h.ctx, "\x1b[6~"); // 自動翻頁
  send(h.ctx, ":42\r"); // gap 自癒的跳行
  expect(h.sent).toEqual([]);
});

test("REGRESSION：queue 有指令在飛就不送（複製連結的 Q／關框交易）", () => {
  // 這條就是「複製完跳出文章」的守護：active 是 false，但 deeplink-copy-info
  // 正在等它自己那一幀。
  const h = harness({ inFlightKind: "deeplink-copy-info" });
  send(h.ctx, "\x1b[6~");
  expect(h.sent).toEqual([]);
});

test("關框交易在飛時也不送", () => {
  const h = harness({ inFlightKind: "aid-post-info-dismiss" });
  send(h.ctx, "\x1b[6~");
  expect(h.sent).toEqual([]);
});

// 長推文有兩段「queue 空著、但畫面還是它的」的空窗：冷卻倒數（最長 240 秒）與
// armed（探完路、使用者在輸入框打字）。armed 這段特別危險：探路收尾按 ⏎ 回文章
// 那一幀會讓 functionMode 退出 ⇒ 自動翻頁重新打開，而那時 inFlightKind 是 null。
test("長推文還握著畫面（冷卻倒數／探完路等使用者打字）：照樣吞掉", () => {
  const h = harness({ longPushBusy: true });
  send(h.ctx, "[6~");
  expect(h.sent).toEqual([]);
});

test("沒有交易在飛：照常送出（好讀的翻頁動力不能被誤殺）", () => {
  const h = harness();
  send(h.ctx, "\x1b[6~");
  expect(h.sent).toEqual(["\x1b[6~"]);
});

test("沒有 aidNavigation / commandQueue（測試替身）也不能炸", () => {
  const sent = [];
  const ctx = {
    _core: {},
    _view: { _send: d => sent.push(d) },
    _wireBusy: EasyReading.prototype._wireBusy
  };
  send(ctx, "\x1b[6~");
  expect(sent).toEqual(["\x1b[6~"]);
});

// ---------------------------------------------------------------------------
// 閘門是「延後」不是「丟棄」（2026-08-17 回報：進文章後好讀卡 1~2 秒才開始翻頁）
//
// 症狀根因：文章落地的那一個 settle 上，順序是
//   pageStateSettled → easyReading 開好讀並送出第一個 PageDown
//   → screenSettled → easyReading（同頁 sig，wait）
//   → **最後**才是 list_session → queue.onSettle → open-enter 完成 → flush
// （pttchrome.jsx「ORDER MATTERS」刻意保證的順序）。所以好讀送第一個 PageDown 時
// `inFlightKind === 'open-enter'` 必然還在 → 被閘門吞掉。而舊碼在 _send **之前**就
// 已寫好 _inFlightSig/_inFlightSentAt 並 armWatchdog ⇒ 留下一筆假的 in-flight，只能
// 等 watchdog 的 620ms 才 retry。term_buf 的 settle timer 只由 server activity 重新
// arm，中間不會有任何東西補送 ⇒ 每篇文章固定多出 620ms 死時間。
//
// 更糟：PAGE_DOWN_MAX_RETRIES = 1，那次 retry 若又撞上別的 in-flight 就直接 giveup
// ⇒ 整篇卡在第一頁直到使用者自己按 PgDn。
const FIRST_PAGE_ROW =
  "  瀏覽 第 1/2 頁 ( 45%)  目前顯示: 第 1~23 行  (y)回應(X%)推文(h)說明(←)離開 ";

function pagingHarness({
  active = false,
  inFlightKind = null,
  longPushBusy = false
} = {}) {
  const sent = [];
  const ctx = {
    _enabled: true,
    _functionMode: false,
    _inFlightSig: null,
    _inFlightKeys: null,
    _inFlightSentAt: null,
    _pageDownRetries: 0,
    _deferredPageDownKeys: null,
    _watchdogTimer: null,
    _watchdogSig: null,
    easyReadingReachedPageEnd: false,
    _termBuf: {
      rows: 24,
      cols: 80,
      // P6：完整回應的游標停在右下角
      cur_y: 23,
      cur_x: 79,
      easyReadingHealInFlight: false,
      getRowText: row => (row === 23 ? FIRST_PAGE_ROW : "")
    },
    _core: {
      aidNavigation: { active },
      commandQueue: { inFlightKind },
      longPush: { busy: longPushBusy }
    },
    _view: { _send: d => sent.push(d) },
    _send: EasyReading.prototype._send,
    _wireBusy: EasyReading.prototype._wireBusy,
    _currentPageStatus: EasyReading.prototype._currentPageStatus,
    _armWatchdog: EasyReading.prototype._armWatchdog,
    _clearWatchdog: EasyReading.prototype._clearWatchdog,
    _maybeSendPageDown: EasyReading.prototype._maybeSendPageDown,
    onWireIdle: EasyReading.prototype.onWireIdle
  };
  return { ctx, sent };
}

describe("線路忙時的自動翻頁：延後而非丟棄", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("REGRESSION：被擋下時不得留下假的 in-flight（620ms 死時間的來源）", () => {
    const h = pagingHarness({ inFlightKind: "open-enter" });
    expect(h.ctx._maybeSendPageDown("\x1b[6~")).toBe("blocked");
    expect(h.sent).toEqual([]);
    // 交易狀態三件套必須原封不動，否則下一次判定會走 wait/retry 而不是 send
    expect(h.ctx._inFlightSig).toBe(null);
    expect(h.ctx._inFlightSentAt).toBe(null);
    // retry budget 只有 1，被閘門擋掉不該算一次
    expect(h.ctx._pageDownRetries).toBe(0);
    // watchdog 也不該上膛：真正該做的是等線路空出來，不是等 620ms
    expect(vi.getTimerCount()).toBe(0);
  });

  test("REGRESSION：線路一空就補送，完全不需要等 620ms", () => {
    const h = pagingHarness({ inFlightKind: "open-enter" });
    h.ctx._maybeSendPageDown("\x1b[6~");
    expect(h.sent).toEqual([]);

    h.ctx._core.commandQueue.inFlightKind = null; // open-enter 完成
    h.ctx.onWireIdle();
    // 時間一格都沒前進
    expect(h.sent).toEqual(["\x1b[6~"]);
    expect(h.ctx._inFlightSig).toBe("1~23");
    expect(h.ctx._deferredPageDownKeys).toBe(null);
  });

  test("補送當下仍然忙 → 保留 deferred，等下一次通知（不做重試迴圈）", () => {
    const h = pagingHarness({ active: true });
    h.ctx._maybeSendPageDown("\x1b[6~");
    h.ctx.onWireIdle(); // 導航還沒解鎖
    expect(h.sent).toEqual([]);
    expect(h.ctx._deferredPageDownKeys).toBe("\x1b[6~");

    h.ctx._core.aidNavigation.active = false;
    h.ctx.onWireIdle();
    expect(h.sent).toEqual(["\x1b[6~"]);
  });

  test("沒有待補送時 onWireIdle 是 no-op（不能無中生有送鍵）", () => {
    const h = pagingHarness();
    h.ctx.onWireIdle();
    expect(h.sent).toEqual([]);
  });

  test("好讀已關閉時不補送（離開文章後線路才空的情況）", () => {
    const h = pagingHarness({ inFlightKind: "open-enter" });
    h.ctx._maybeSendPageDown("\x1b[6~");
    h.ctx._enabled = false;
    h.ctx._core.commandQueue.inFlightKind = null;
    h.ctx.onWireIdle();
    expect(h.sent).toEqual([]);
  });

  test("線路空著就照常送（閘門不得誤殺正常翻頁動力）", () => {
    const h = pagingHarness();
    expect(h.ctx._maybeSendPageDown("\x1b[6~")).toBe("send");
    expect(h.sent).toEqual(["\x1b[6~"]);
    expect(h.ctx._inFlightSig).toBe("1~23");
    expect(vi.getTimerCount()).toBe(1); // 這條路才該上膛 watchdog
  });
});

// 長推文放手（disarm）那一刻的補送。
//
// REGRESSION（ptt-debug-20260917-221112）：按 X 叫出長推文輸入框再取消，文章就
// 永遠停在當前頁、不會讀到結尾。錄製檔裡最後三筆全是
// `easyReading.pageDown {action:"blocked", inFlightKind:null}` —— 擋人的不是
// CommandQueue，是 _wireBusy 的 longPush.busy（探路成功後 _armed 一直活著）。
// 而 queue 的 onIdle 早在收尾鍵那一刻就發過了，busy 是**之後**才翻 false ⇒ 沒有
// 第二次 idle 能叫醒好讀，被延後的 PageDown 永遠躺在 _deferredPageDownKeys 裡，
// 畫面也不會再更新（沒送鍵就沒有新幀）⇒ 死結。
describe("長推文放手後的補送（force）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("REGRESSION：長推文 armed 期間被擋下，放手後必須補送", () => {
    const h = pagingHarness({ longPushBusy: true });
    expect(h.ctx._maybeSendPageDown("\x1b[6~")).toBe("blocked");
    expect(h.sent).toEqual([]);

    // 使用者按了取消 → LongPushSession.disarm() → busy 翻 false。
    // 這一刻 queue 早就空了，不會再有 onIdle，只能由放手的人自己通知。
    h.ctx._core.longPush.busy = false;
    h.ctx.onWireIdle({ force: true });
    expect(h.sent).toEqual(["\x1b[6~"]);
    expect(h.ctx._deferredPageDownKeys).toBe(null);
  });

  test("REGRESSION：待補送的鍵已被 _resetPagingState 清掉，force 仍要重新評估", () => {
    // 取消長推文的路徑上，探路收尾會退出文章再 ⏎ 重開 ⇒ 走過一次
    // 「列表(2) → 文章(3)」的邊界 ⇒ _onPageStateSettled 呼叫 _resetPagingState，
    // 把 _deferredPageDownKeys 清成 null。之後未必還有幀來重新延後一次，所以
    // 「只補送 deferred」是不夠的。
    const h = pagingHarness({ longPushBusy: true });
    h.ctx._maybeSendPageDown("\x1b[6~");
    h.ctx._deferredPageDownKeys = null;

    h.ctx._core.longPush.busy = false;
    h.ctx.onWireIdle({ force: true });
    expect(h.sent).toEqual(["\x1b[6~"]);
  });

  test("force 時仍然要看閘門：線路還忙就留著待補送", () => {
    const h = pagingHarness({ longPushBusy: true, inFlightKind: "open-enter" });
    h.ctx._core.longPush.busy = false; // 長推文放手了，但 queue 還有東西在飛
    h.ctx.onWireIdle({ force: true });
    expect(h.sent).toEqual([]);
    expect(h.ctx._deferredPageDownKeys).toBe("\x1b[6~");
  });

  test("force 不得在好讀已關／鏡像原生時送鍵", () => {
    const off = pagingHarness();
    off.ctx._enabled = false;
    off.ctx.onWireIdle({ force: true });
    expect(off.sent).toEqual([]);

    const mirror = pagingHarness();
    mirror.ctx._functionMode = true;
    mirror.ctx.onWireIdle({ force: true });
    expect(mirror.sent).toEqual([]);
  });

  test("force 連叫兩次也只送一個鍵（P4：重複送鍵＝永久掉頁）", () => {
    const h = pagingHarness();
    h.ctx.onWireIdle({ force: true });
    h.ctx.onWireIdle({ force: true });
    expect(h.sent).toEqual(["\x1b[6~"]);
  });
});

// 待補送的鍵是「這一篇」的：換文章時必須丟掉，否則會落到下一篇頭上
// （與 _pendingScrollRestore / _pendingEnableOnArticle 同規）。
test("換文章時清掉待補送的鍵", () => {
  const clears = ctx => {
    EasyReading.prototype._resetPagingState.call(ctx);
    return ctx._deferredPageDownKeys;
  };
  const ctx = {
    _deferredPageDownKeys: "\x1b[6~",
    _inFlightSig: null,
    _pageDownRetries: 0,
    _inFlightKeys: null,
    _inFlightSentAt: null,
    _healGotoCount: 0,
    _healHomeUsed: false,
    ignoreOneUpdate: false,
    sendCommandAfterUpdate: "",
    easyReadingReachedPageEnd: false,
    _termBuf: { easyReadingHealInFlight: false },
    _watchdogTimer: null,
    _watchdogSig: null,
    _clearWatchdog: EasyReading.prototype._clearWatchdog
  };
  expect(clears(ctx)).toBe(null);
});
