// 背景通知（水球 / deep link 交接共用）—— TermView 的三個方法。
//
// 用 prototype call + 假 this 測（同 easy_reading_send_gate 的風格）：真正要守的是
// **降級與 null-safety**，那跟渲染完全無關。
//
// 兩個既有隱患順帶被守起來（抽 helper 之前就存在）：
//   a) 全專案從未呼叫 Notification.requestPermission（現在只在 PrefModal 勾選時
//      問），所以權限多半是 'default' ⇒ 系統通知不會出現，實際在運作的一直是標題
//      閃爍。那條路不能因為「沒有通知」就整個不做。
//   b) 舊的 App focus handler 無條件 `view.notif.close()` ⇒ 只要出現「有 titleTimer
//      但沒有 notif」（＝沒權限，也就是常態）就 TypeError。

import { TermView } from "../../src/js/term_view";

const call = (name, ctx, ...args) => TermView.prototype[name].call(ctx, ...args);

function ctxFor({ site = "wsstelnet://ws.ptt.cc/bbs", notify = true } = {}) {
  return {
    bbscore: { connectedUrl: { site } },
    deepLinkHandoffNotify: notify,
    titleTimer: null,
    notif: null,
    _flashBaseTitle: null,
    // 三個方法會互相呼叫（notifyDeepLinkHandoff → showBackgroundNotification →
    // stopTitleFlash / _createNotification），假 this 上要備齊真的那份。
    stopTitleFlash: TermView.prototype.stopTitleFlash,
    showBackgroundNotification: TermView.prototype.showBackgroundNotification,
    _createNotification: TermView.prototype._createNotification,
    hints: [],
    flashListHint(msg, ms) {
      this.hints.push({ msg, ms });
    }
  };
}

// 假 Notification 建構子。permission 由呼叫端決定。
function installNotification({ permission = "granted", throws = false } = {}) {
  const made = [];
  const Ctor = function(title, options) {
    if (throws) throw new Error("NotAllowedError");
    this.title = title;
    this.options = options;
    this.closed = false;
    this.close = () => {
      this.closed = true;
    };
    made.push(this);
  };
  Ctor.permission = permission;
  globalThis.Notification = Ctor;
  return made;
}

afterEach(() => {
  delete globalThis.Notification;
  vi.useRealTimers();
});

describe("_createNotification（永遠不可 throw）", () => {
  test("瀏覽器沒有 Notification（非 secure context）→ 回 null，不炸", () => {
    delete globalThis.Notification;
    expect(call("_createNotification", ctxFor(), { title: "t" })).toBeNull();
  });

  test("權限還沒給（default）／被封鎖（denied）→ 回 null", () => {
    installNotification({ permission: "default" });
    expect(call("_createNotification", ctxFor(), { title: "t" })).toBeNull();
    installNotification({ permission: "denied" });
    expect(call("_createNotification", ctxFor(), { title: "t" })).toBeNull();
  });

  test("建構子自己 throw（舊 Safari 等）→ 回 null，不炸", () => {
    installNotification({ throws: true });
    expect(() =>
      call("_createNotification", ctxFor(), { title: "t" })
    ).not.toThrow();
  });

  test("有權限 → 建出通知，點擊會把瀏覽器切到本分頁", () => {
    // 這是**唯一**能切分頁的路：通知的 click handler 帶有 user activation，
    // 背景分頁自己呼叫 window.focus() 是無效的。
    const made = installNotification();
    const focus = vi.fn();
    const orig = globalThis.window;
    globalThis.window = { focus };
    try {
      const n = call("_createNotification", ctxFor(), {
        title: "t",
        body: "b",
        tag: "x"
      });
      expect(made).toHaveLength(1);
      expect(n.options.body).toBe("b");
      n.onclick();
      expect(focus).toHaveBeenCalledTimes(1);
      expect(n.closed).toBe(true);
    } finally {
      globalThis.window = orig;
    }
  });
});

describe("stopTitleFlash（null-safe）", () => {
  test("REGRESSION：有 titleTimer 但沒有 notif（＝沒權限，常態）不能炸", () => {
    const ctx = ctxFor();
    ctx.titleTimer = { cancel: vi.fn() };
    ctx._flashBaseTitle = "PttChrome";
    document.title = "有人敲你";
    expect(() => call("stopTitleFlash", ctx)).not.toThrow();
    expect(ctx.titleTimer).toBeNull();
    expect(document.title).toBe("PttChrome");
  });

  test("什麼都沒有時是 no-op，不可以動別人設的標題", () => {
    document.title = "PttChrome";
    expect(() => call("stopTitleFlash", ctxFor())).not.toThrow();
    expect(document.title).toBe("PttChrome");
  });

  test("有通知就一起關掉", () => {
    const ctx = ctxFor();
    let closed = false;
    ctx.notif = {
      close() {
        closed = true;
      }
    };
    call("stopTitleFlash", ctx);
    expect(closed).toBe(true);
    expect(ctx.notif).toBeNull();
  });
});

describe("showBackgroundNotification", () => {
  // REGRESSION：閃爍的基準必須是**當下的標題**，不是 connectedUrl.site。
  // 全 app 從來沒把 document.title 設成連線位址過（index.html 的 <title> 一路
  // 留著），舊的水球版本拿 site 當基準 ⇒ 第一次 tick 就把標題換成
  // `wsstelnet://…`，停下來之後也還原成那串而不是原本的標題。
  test("標題在原本的標題與訊息之間交替，停止後還原成原本的", () => {
    vi.useFakeTimers();
    const ctx = ctxFor();
    document.title = "PttChrome";
    call("showBackgroundNotification", ctx, {
      title: "t",
      titleText: "有人敲你",
      body: "b",
      tag: "x"
    });
    vi.advanceTimersByTime(1500);
    expect(document.title).toBe("有人敲你");
    vi.advanceTimersByTime(1500);
    expect(document.title).toBe("PttChrome");
    vi.advanceTimersByTime(1500);
    expect(document.title).toBe("有人敲你");
    call("stopTitleFlash", ctx);
    expect(document.title).toBe("PttChrome");
  });

  test("第二則會先停掉第一則（兩個 interval 會互搶 document.title）", () => {
    vi.useFakeTimers();
    const ctx = ctxFor();
    document.title = "PttChrome";
    call("showBackgroundNotification", ctx, { titleText: "A" });
    const first = ctx.titleTimer;
    vi.advanceTimersByTime(1500);
    call("showBackgroundNotification", ctx, { titleText: "B" });
    expect(ctx.titleTimer).not.toBe(first);
    // 第二則的基準仍是原本的標題（不是被第一則換上去的 "A"）
    expect(document.title).toBe("PttChrome");
    vi.advanceTimersByTime(1500);
    expect(document.title).toBe("B");
    call("stopTitleFlash", ctx);
    expect(document.title).toBe("PttChrome");
  });

  test("沒有通知權限時：仍然閃標題（那是唯一還有效的通道）", () => {
    vi.useFakeTimers();
    installNotification({ permission: "default" });
    const ctx = ctxFor();
    document.title = "PttChrome";
    expect(
      call("showBackgroundNotification", ctx, { titleText: "有東西在等你" })
    ).toBe(false);
    expect(ctx.titleTimer).not.toBeNull();
    vi.advanceTimersByTime(1500);
    expect(document.title).toBe("有東西在等你");
  });
});

describe("notifyDeepLinkHandoff", () => {
  const TARGET = { board: "movie", aid: "1gIeu-3A" };

  test("頁內橫幅不受 pref 控制（切回來後唯一看得到的痕跡）", () => {
    const ctx = ctxFor({ notify: false });
    call("notifyDeepLinkHandoff", ctx, TARGET);
    expect(ctx.hints).toHaveLength(1);
    expect(ctx.hints[0].msg).toContain("#1gIeu-3A (movie)");
    // pref 關掉 → 不閃標題、不發系統通知
    expect(ctx.titleTimer).toBeNull();
  });

  test("pref 開著：橫幅 + 標題閃爍都要有", () => {
    vi.useFakeTimers();
    const ctx = ctxFor({ notify: true });
    call("notifyDeepLinkHandoff", ctx, TARGET);
    expect(ctx.hints).toHaveLength(1);
    expect(ctx.titleTimer).not.toBeNull();
  });

  test("沒有 flashListHint（早期 boot）也不能炸", () => {
    const ctx = ctxFor({ notify: false });
    delete ctx.flashListHint;
    expect(() => call("notifyDeepLinkHandoff", ctx, TARGET)).not.toThrow();
  });
});
