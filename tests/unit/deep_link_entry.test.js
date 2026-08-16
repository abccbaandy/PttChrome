// Unit tests for installDeepLink (src/js/deep_link_entry.js): 三條進來的路徑
// （開站網址 / hashchange / PWA launchQueue）都要餵到 controller，而且用過的
// 網址參數必須清掉。假的 window 物件即可 —— 這層只碰 location/history。

import { installDeepLink } from "../../src/js/deep_link_entry";

const BASE = "https://example.github.io/pttchrome/";
const AID = "1gIeu-3A";

function makeWin(href) {
  const listeners = {};
  const w = {
    location: { href },
    history: {
      replaced: [],
      replaceState(state, title, url) {
        this.replaced.push(url);
        // 真實行為：網址真的變了，而且**不會**觸發 hashchange
        w.location.href = url;
      }
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    fire(type) {
      (listeners[type] || []).forEach(fn => fn());
    }
  };
  return w;
}

let win;
function setup(href) {
  win = makeWin(href);
  const requests = [];
  const calls = [];
  const app = {
    connectState: 1,
    deepLinkController: {
      request: (t, opts) => {
        requests.push(t);
        calls.push({ target: t, opts });
      }
    }
  };
  return { app, requests, calls };
}

// 把一個假的 BroadcastChannel 掛上假 window，讓 serveHandoff 真的接得到訊息。
// 規範：不會把訊息送回給發送端自己，所以這裡直接 _deliver 模擬「另一個分頁送來」。
function installChannel(w) {
  const listeners = [];
  const port = {
    posted: [],
    addEventListener: (type, fn) => type === "message" && listeners.push(fn),
    removeEventListener: () => {},
    postMessage: data => port.posted.push(data),
    _deliver: data => listeners.slice().forEach(fn => fn({ data }))
  };
  w.BroadcastChannel = function() {
    return port;
  };
  return port;
}

test("開站網址帶 deep link → 送進 controller", () => {
  const { app, requests } = setup(BASE + "#Gossiping/" + AID);
  installDeepLink(app, win);
  expect(requests).toEqual([{ board: "Gossiping", aid: AID }]);
});

test("消費後把網址清乾淨（F5 不該再跳一次）", () => {
  const { app } = setup(BASE + "#Gossiping/" + AID);
  installDeepLink(app, win);
  expect(win.history.replaced).toEqual([BASE]);
  expect(win.location.href).toBe(BASE);
});

test("沒有 deep link → 不碰網址、不打擾 controller", () => {
  const { app, requests } = setup(BASE);
  expect(installDeepLink(app, win)).toBeNull();
  expect(requests).toEqual([]);
  expect(win.history.replaced).toEqual([]);
});

test("hashchange：同一個分頁再貼一次連結", () => {
  const { app, requests } = setup(BASE);
  installDeepLink(app, win);
  win.location.href = BASE + "#movie/2AbCdEf0";
  win.fire("hashchange");
  expect(requests).toEqual([{ board: "movie", aid: "2AbCdEf0" }]);
  expect(win.location.href).toBe(BASE);
});

test("replaceState 失敗（file:// 之類）不擋跳轉", () => {
  const { app, requests } = setup(BASE + "#Gossiping/" + AID);
  win.history.replaceState = () => {
    throw new Error("SecurityError");
  };
  expect(() => installDeepLink(app, win)).not.toThrow();
  expect(requests).toHaveLength(1);
});

test("PWA launchQueue：focus-existing 不重載頁面，只走這條", () => {
  const { app, requests } = setup(BASE);
  let consumer = null;
  win.launchQueue = { setConsumer: fn => (consumer = fn) };
  installDeepLink(app, win);
  expect(requests).toEqual([]);
  consumer({ targetURL: BASE + "#C_Chat/" + AID });
  expect(requests).toEqual([{ board: "C_Chat", aid: AID }]);
});

// 接手是**唯一**「使用者眼睛不在這個分頁」的來源，controller 得靠這個旗標才知道
// 要不要主動出聲（標題閃爍／系統通知／頁內橫幅）。
test("別的分頁交接過來 → 帶 source:'handoff' 呼叫 controller", () => {
  const { app, calls } = setup(BASE);
  const port = installChannel(win);
  installDeepLink(app, win);
  port._deliver({ t: "claim", id: "c1", target: { board: "movie", aid: AID } });
  expect(calls).toEqual([
    { target: { board: "movie", aid: AID }, opts: { source: "handoff" } }
  ]);
});

test("使用者自己在這個分頁開的連結不帶 handoff（不該通知他自己剛做的事）", () => {
  const { app, calls } = setup(BASE + "#Gossiping/" + AID);
  installDeepLink(app, win);
  win.location.href = BASE + "#movie/2AbCdEf0";
  win.fire("hashchange");
  expect(calls.map(c => c.opts)).toEqual([undefined, undefined]);
});

test("launchQueue 拿到不是 deep link 的網址 → 忽略", () => {
  const { app, requests } = setup(BASE);
  let consumer = null;
  win.launchQueue = { setConsumer: fn => (consumer = fn) };
  installDeepLink(app, win);
  consumer({ targetURL: BASE });
  consumer({});
  expect(requests).toEqual([]);
});
