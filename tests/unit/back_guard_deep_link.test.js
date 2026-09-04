// 回歸鎖：**瀏覽器返回不可以把使用者導回剛剛那篇文章**（2026-09-05 實機回報）。
//
// 機制（兩個功能交會處，各自都沒錯）：
//  1. 「網址列跟著現在在讀哪一篇走」（deep_link_controller._syncAddressBar）用
//     replaceState 把**當前 entry** 的網址改成 `.../#Board/AID`。而我們平常站著
//     的那一層就是 history_back_guard 的 sentinel ⇒ sentinel 這一格帶著文章網址。
//  2. guard 接住返回之後用 history.forward() 走回 sentinel（traversal 不建立
//     entry，才不會被 Chrome 的 intervention 標成可跳過）。traversal 讓網址的
//     fragment 變了 ⇒ **hashchange** ⇒ deep_link_entry 把它當成「使用者又貼了
//     一條連結」⇒ aid-search + aid-open ⇒ 畫面被拉回那篇文章。
//
// 修法：guard 自己造成的 traversal 期間標記 self-navigation，deep link 不消費。
// 這兩支模組單獨測都是綠的，所以鎖必須下在它們的交會處。
import { installDeepLink } from "../../src/js/deep_link_entry";
import { installHistoryBackGuard } from "../../src/js/history_back_guard";
import { resetSelfNavigation } from "../../src/js/self_navigation";

// self_navigation 的旗標是 page-lifetime 的模組狀態 ⇒ 跨 test 會殘留
// （test 沒把 guard 的計時器排乾時，靜音窗口就永遠關不掉）。
beforeEach(resetSelfNavigation);

const BASE = "https://example.github.io/pttchrome/";
const ARTICLE = BASE + "#Stock/1gchySHu";

// 假 window：history 的 traversal 真的會改網址並派發 popstate + hashchange
// （真實瀏覽器在 same-document traversal 上兩者都會發）。
function makeWin(href) {
  const listeners = {};
  const w = {
    location: { href },
    calls: [],
    // stack[index] = { url, state }
    stack: [{ url: href, state: null }],
    index: 0,
    history: {
      get state() {
        return w.stack[w.index].state;
      },
      pushState(state, title, url) {
        w.calls.push(["push", state]);
        w.stack = w.stack.slice(0, w.index + 1);
        w.stack.push({ url: url || w.location.href, state });
        w.index = w.stack.length - 1;
        w.location.href = w.stack[w.index].url;
      },
      replaceState(state, title, url) {
        w.calls.push(["replace", state]);
        w.stack[w.index] = { url: url == null ? w.location.href : url, state };
        w.location.href = w.stack[w.index].url;
      },
      forward() {
        w.calls.push(["forward"]);
        w._go(1);
      },
      back() {
        w.calls.push(["back"]);
        w._go(-1);
      },
      go(n) {
        w.calls.push(["go", n]);
        w._go(n);
      },
    },
    // 真實順序無關的寫法：popstate 與 hashchange 都發，測試不依賴誰先誰後。
    _go(delta) {
      const from = w.stack[w.index];
      const next = w.index + delta;
      if (next < 0 || next >= w.stack.length) return;
      w.index = next;
      const to = w.stack[w.index];
      w.location.href = to.url;
      w.fire("popstate", { state: to.state });
      if (frag(from.url) !== frag(to.url)) w.fire("hashchange", {});
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
    fire(type, e) {
      (listeners[type] || []).slice().forEach((fn) => fn(e));
    },
  };
  return w;
}

const frag = (u) => {
  const i = String(u).indexOf("#");
  return i < 0 ? "" : u.slice(i);
};

function setup({ sent = true } = {}) {
  const win = makeWin(BASE);
  const requests = [];
  const keys = [];
  const app = {
    connectState: 1,
    deepLinkController: { request: (t) => requests.push(t) },
    mouseGates: () => ({ backNav: 1 }),
    sendNavKeyAsUser: (k) => {
      keys.push(k);
      return sent;
    },
    view: { flashListHint: () => {} },
  };
  installDeepLink(app, win);
  const timers = [];
  installHistoryBackGuard(app, win, {
    now: () => 1000,
    setTimeout: (fn) => timers.push(fn),
  });
  return { win, app, requests, keys, timers };
}

test("返回之後補回 sentinel，不可以被自己的 traversal 當成新的 deep link", () => {
  const t = setup();
  // 第一次 user activation ⇒ 疊 sentinel（此時網址還是站台根）。
  t.win.fire("pointerdown", {});
  // 使用者讀了一篇文章 ⇒ 網址列鏡像把**當前 entry**（＝sentinel）改成文章網址。
  t.win.history.replaceState(t.win.history.state, "", ARTICLE);
  expect(t.win.location.href).toBe(ARTICLE);

  // 使用者按側鍵／Alt+← ／觸控板左滑。
  t.win.history.back();

  // 送出退出用的左方向鍵，而且**沒有**被當成 deep link 拉回文章。
  expect(t.keys).toEqual(["ArrowLeft"]);
  expect(t.requests).toEqual([]);
  // 補回 sentinel 用的仍是 traversal（不新增 entry，見 F11）。
  expect(t.win.calls.filter((c) => c[0] === "forward")).toHaveLength(1);
  expect(t.win.stack).toHaveLength(2);
});

test("靜音窗口關掉之後，使用者真的貼一條新連結照樣跳", () => {
  const t = setup();
  t.win.fire("pointerdown", {});
  t.win.history.replaceState(t.win.history.state, "", ARTICLE);
  t.win.history.back();
  t.timers.splice(0).forEach((fn) => fn()); // 靜音窗口到期
  t.requests.length = 0;

  // 使用者在網址列貼上另一篇 ⇒ hashchange（不是我們造成的）。
  t.win.location.href = BASE + "#Gossiping/1abcdefg";
  t.win.fire("hashchange", {});
  expect(t.requests).toHaveLength(1);
  expect(t.requests[0].aid).toBe("1abcdefg");
});

test("網址列鏡像不可以洗掉 sentinel 的 state（洗掉就認不出自己那一層）", () => {
  const t = setup();
  t.win.fire("pointerdown", {});
  const id = t.win.history.state && t.win.history.state.pttchromeBackGuard;
  expect(id).toBeTruthy();
  // 這是 deep_link_controller._replaceState 實際會做的事（保留 state）。
  t.win.history.replaceState(t.win.history.state, "", ARTICLE);
  expect(t.win.history.state.pttchromeBackGuard).toBe(id);

  // 使用者按「下一頁」回到 sentinel 那一層 ⇒ 不算一次往外退，不得送鍵。
  t.win.history.back();
  t.timers.splice(0).forEach((fn) => fn());
  t.keys.length = 0;
  t.win.history.forward();
  expect(t.keys).toHaveLength(0);
});
