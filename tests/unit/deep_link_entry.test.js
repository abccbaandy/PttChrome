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
  const app = { deepLinkController: { request: t => requests.push(t) } };
  return { app, requests };
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

test("launchQueue 拿到不是 deep link 的網址 → 忽略", () => {
  const { app, requests } = setup(BASE);
  let consumer = null;
  win.launchQueue = { setConsumer: fn => (consumer = fn) };
  installDeepLink(app, win);
  consumer({ targetURL: BASE });
  consumer({});
  expect(requests).toEqual([]);
});
