// 离线重放 helper：把「真实 PTT 录下来的 byte cassette」在真浏览器里离线重放，
// 不连真实 PTT 也能确定性重现一篇文章的好读累积画面。原理：
//   1) installReplay() 在 app 任何脚本前覆写 window.WebSocket 为 stub
//      （不连网、吞掉所有 send、自身不吐 data）→ app 照常 connect()/onConnect()，
//      但完全无网络。
//   2) replayCassette() 把 cassette 每页 recv 喂回 App.onData（= 真实 parser→termBuf→
//      Screen 渲染路径），并以好读状态机自己送出的 \x1b[6~（向下翻页）/ \x1b[4~（End）
//      作为「放下一页」的门控 —— 逐页节奏与 live 完全一致。
// 见 docs/offline-replay-testing.md。注入点出处：src/js/websocket.js:4、
// src/js/pttchrome.js:252（App.onData）、src/js/easy_reading.js:82,318（_send）。
const fs = require('fs');
const path = require('path');

const CASSETTE_DIR = path.join(__dirname, '..', 'cassettes');

// 读 cassette JSON；不存在回 null（offline spec 据此 skip，直到录制过一次）。
function loadCassette(name) {
  const file = path.join(CASSETTE_DIR, name.endsWith('.json') ? name : name + '.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// 扫描 cassettes 目录，回传所有 meta.mode 符合的 cassette（各含 __file 档名）。
// offline spec 用它「捡到什么用什么」——不写死档名，使用者录任意名都能被吃到。
function findCassettes(mode) {
  if (!fs.existsSync(CASSETTE_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(CASSETTE_DIR).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(CASSETTE_DIR, f), 'utf8'));
      if (c && c.meta && c.meta.mode === mode) out.push(Object.assign({ __file: f }, c));
    } catch (e) {}
  }
  return out;
}

// 第一个符合 mode 的 cassette；无则 null。
function findCassette(mode) {
  return findCassettes(mode)[0] || null;
}

// addInitScript：必须在 page.goto 之前呼叫，覆写 window.WebSocket。
async function installReplay(page) {
  await page.addInitScript(() => {
    class StubWebSocket {
      constructor(url) {
        this.url = url;
        this.binaryType = 'arraybuffer';
        this.readyState = 0; // CONNECTING
        this._listeners = {};
        window.__stubWS = this;
        // 异步 fire open，让 App.onConnect 在事件回圈里跑（与原生 WS 行为一致）。
        setTimeout(() => {
          this.readyState = 1; // OPEN
          this._emit('open', {});
        }, 0);
      }
      addEventListener(type, fn) {
        (this._listeners[type] = this._listeners[type] || []).push(fn);
      }
      removeEventListener(type, fn) {
        const a = this._listeners[type];
        if (a) this._listeners[type] = a.filter((f) => f !== fn);
      }
      _emit(type, ev) {
        ev = ev || {};
        ev.type = type;
        (this._listeners[type] || []).slice().forEach((f) => f(ev));
        const on = this['on' + type];
        if (typeof on === 'function') on(ev);
      }
      // 吞掉 telnet 协商 / NAWS / 一切键盘送出 —— 离线重放不需要真的送回 server。
      // 但把送出的 bytes 转回 latin1 字串交给 window.__stubWSSent（若测试装了）：
      // list 重放的门控在「WS 送出层」而非 er._send —— 这样 CommandQueue 的机器键
      // 和使用者键盘键（都走 conn→WS）用同一个 hook 就全捕捉得到。
      send(data) {
        if (window.__stubWSSent) {
          let s = data;
          if (typeof s !== 'string') {
            try {
              s = String.fromCharCode.apply(String, new Uint8Array(s));
            } catch (e) {
              s = '';
            }
          }
          window.__stubWSSent(s);
        }
      }
      close() {
        this.readyState = 3; // CLOSED
        this._emit('close', {});
      }
    }
    StubWebSocket.CONNECTING = 0;
    StubWebSocket.OPEN = 1;
    StubWebSocket.CLOSING = 2;
    StubWebSocket.CLOSED = 3;
    window.WebSocket = StubWebSocket;
  });
}

// 等 app 离线「连上」（onConnect 把 connectState 设 1）。
async function waitConnected(page, timeout = 20000) {
  await page.waitForFunction(
    () => !!(window.__app && window.__app.isConnected && window.__app.isConnected()),
    null,
    { timeout }
  );
}

// 直接把一段 latin1 bytes 喂进 App.onData（= parser.feed），供 harness smoke 用。
async function feedRaw(page, latin1) {
  await page.evaluate((s) => window.__app.onData(s), latin1);
}

// 重放一卷 cassette。
//   opts.easyReading（预设 true）：进好读、逐页累积（翻页回归 / End→原生 / 行内开图 / 楼层 / 黑名单 / pusher）。
//   opts.easyReading=false：静态单页（看板列表黑名单 / 作者栏），只喂 start step、不进好读。
async function replayCassette(page, cassette, opts = {}) {
  const easyReading = opts.easyReading !== false;
  await page.evaluate(
    ({ cassette, easyReading }) => {
      const app = window.__app;
      const steps = cassette.steps || [];
      let idx = 0;
      window.__replay = { done: false, fed: 0, total: steps.length };
      // done = 自动翻页部分（start + pagedown）全喂完；'end' step 不计入「done」，
      // 它专等测试稍后手动触发 End（switchToNativeAtBottom 送 \x1b[4~）才喂。
      const markDoneIfPaged = () => {
        if (idx >= steps.length || steps[idx].on === 'end') window.__replay.done = true;
      };
      const feed = () => {
        const step = steps[idx++];
        app.onData(atob(step.recv)); // atob → latin1 bytes string（每 char = 1 byte）
        window.__replay.fed = idx;
        markDoneIfPaged();
      };
      // 先喂掉所有开头的 start step（文章第一页 / 列表画面）。
      while (idx < steps.length && steps[idx].on === 'start') feed();
      markDoneIfPaged();

      if (!easyReading) {
        window.__replay.done = true;
        return;
      }

      // 以好读自己送出的翻页序列作为门控：每送一次对应键，喂下一 step。
      const er = app.easyReading;
      const origSend = er._send.bind(er);
      er._send = (data) => {
        origSend(data); // 进 stub WS，无副作用
        if (idx < steps.length) {
          const next = steps[idx];
          if (
            (next.on === 'pagedown' && data.indexOf('\x1b[6~') >= 0) ||
            (next.on === 'end' && data.indexOf('\x1b[4~') >= 0)
          ) {
            feed();
          }
        }
      };
      // 启动好读：对刚喂进的第一页重画 + 踢出自动翻页回圈（= live 在 settle edge 做的事）。
      // 注意：必须先经 applyPrefs 写 enableEasyReading=true 到 localStorage，否则
      // _onChanged 读到 pref off 会立刻 exitEasyReading（见 easy_reading.js:182）。
      er.enterEasyReading();
    },
    { cassette, easyReading }
  );

  // 等所有 step 喂完（逐页翻页跨 timer tick 推进）；逾时不抛，交给断言抓问题。
  try {
    await page.waitForFunction(() => window.__replay && window.__replay.done, null, {
      timeout: 30000,
    });
  } catch (e) {
    const st = await page.evaluate(() => window.__replay).catch(() => null);
    console.log('replayCassette 未喂完所有 step（可能 cassette 与当前逻辑不符）：', JSON.stringify(st));
  }
  await page.waitForTimeout(300); // 让最后一页 settle/render flush
}

// 重放一卷「list 多 step」cassette（tools/record-cassette.spec.js 的
// RECORD_LIST_SCRIPT 产物）。与 replayCassette 的差异：门控不在 er._send，而在
// stub WS 的送出层（见 StubWebSocket.send）——list 好读 v4 的机器键由 CommandQueue
// 送、导航键由使用者键盘送，都汇流到 conn→WS，同一个 hook 全包。
// 门控 map：依 step.on 匹配送出的 bytes，按 cassette 顺序逐步喂。
//   pageup/pagedown: 翻页键     jump: 整串「数字+\r」（跳号开文第一段）
//   open/cancel: 单独 '\r'      back: ←    slash: '/'
// 送出的所有 bytes 也记进 window.__replay.sent，供「本地导航不送键」类断言用。
async function replayListCassette(page, cassette) {
  await page.evaluate(
    ({ cassette }) => {
      const app = window.__app;
      const steps = cassette.steps || [];
      let idx = 0;
      window.__replay = { done: false, fed: 0, total: steps.length, sent: [] };
      const feed = () => {
        const step = steps[idx++];
        app.onData(atob(step.recv));
        window.__replay.fed = idx;
        if (idx >= steps.length) window.__replay.done = true;
      };
      while (idx < steps.length && steps[idx].on === 'start') feed();
      if (idx >= steps.length) window.__replay.done = true;

      // v5：跳号交易尾附 \f（Ctrl+L 确定性收尾，protocol §6）——比对前剥掉，
      // cassette 的 num 门控语义不变（录制侧同样附 \f，recv 已含全幅重绘）。
      const stripFF = (d) => (d.charAt(d.length - 1) === '\x0c' ? d.slice(0, -1) : d);
      const jumpMatch = (d, step) => {
        const b = stripFF(d);
        return step.num != null ? b === String(step.num) + '\r' : /^\d+\r$/.test(b);
      };
      const PATTERNS = {
        pageup: (d) => d.indexOf('\x1b[5~') >= 0,
        pagedown: (d) => d.indexOf('\x1b[6~') >= 0,
        // jump 只在「序号完全一致」时喂：锚定预读/开文都会送「数字+\r」，若不比
        // 对目标，跑到别处的跳号会吃错 step、后续全歪（宁可让不匹配的跳号
        // timeout —— runtime 把它当良性到边）。旧 cassette 没记 num 时退回宽松。
        jump: jumpMatch,
        jumpsame: jumpMatch,
        open: (d) => d === '\r',
        back: (d) => d.indexOf('\x1b[D') >= 0,
        // 置底文开启序列（list_session._beginOpenPinned）：jump 最大序号 →
        // End 锚定最后一页 → ↑ 逐列走到目标置底列（内容定位，非盲数步数）。
        jumpmax: jumpMatch,
        end: (d) => d.indexOf('\x1b[4~') >= 0,
        up: (d) => d === '\x1b[A',
        slash: (d) => d === '/',
        cancel: (d) => d === '\r',
      };
      // 冪等 jump 重播：真 server 對「跳同一序號」永遠回同一畫面。demand 的
      // 隱藏列（刪除文）會讓錨定鏈多消耗一個 jump step，之後開文的 open-jump
      // 跳同一序號時，重喂已消耗的 jump 回應（不推進 step 指標）＝與真 server
      // 行為一致。只登記有 num 的絕對定位步（jump/jumpsame/jumpmax）。
      const servedJumps = new Map();
      window.__stubWSSent = (data) => {
        window.__replay.sent.push(data);
        if (idx < steps.length) {
          const next = steps[idx];
          const match = PATTERNS[next.on];
          if (match && match(data, next)) {
            if (
              (next.on === 'jump' || next.on === 'jumpsame' || next.on === 'jumpmax') &&
              next.num != null
            )
              servedJumps.set(String(next.num) + '\r', next.recv);
            feed();
            return;
          }
          // 鏈式預讀（list_session._enqueuePrefetch chained）：同方向連補時
          // runtime 省略錨定 jump 直送 PgUp/PgDn（server 游標位置已知）。
          // cassette 是兩腿協定錄的：若下一步是帶 num 的 jump、下下步是與
          // 本次按鍵相符的翻頁，視為「同位置錨定被省略」——jump step 只登記
          // 進 servedJumps（供之後真正跳同序號的開文重播）、**跳過不餵**：
          // v5 的 jump recv 尾附 \f 全幅重繪＝clean-list 且游標未動，餵進去
          // 會被翻頁腿的 expect 誤讀成「游標未動＝到邊」（假邊界）。鏈上
          // server 游標本來就在該位置，略過它畫面語義不變；直接餵翻頁回應。
          const after = steps[idx + 1];
          if (
            (next.on === 'jump' || next.on === 'jumpsame') &&
            next.num != null &&
            after &&
            (after.on === 'pageup' || after.on === 'pagedown') &&
            PATTERNS[after.on](data)
          ) {
            servedJumps.set(String(next.num) + '\r', next.recv);
            idx++; // skip the jump step (not fed)
            window.__replay.fed = idx;
            feed(); // the page-turn response
            return;
          }
        }
        const replayed = servedJumps.get(stripFF(data));
        if (replayed) app.onData(atob(replayed));
      };
    },
    { cassette }
  );
}

// offline spec 共用：装 stub WS、开页、关掉 Developer modal、等离线连上。
async function bootOffline(page, ptt) {
  await installReplay(page);
  await page.goto('/');
  await ptt.dismissDeveloperModeAlert(page);
  await waitConnected(page);
}

module.exports = {
  CASSETTE_DIR,
  loadCassette,
  findCassette,
  findCassettes,
  installReplay,
  waitConnected,
  feedRaw,
  replayCassette,
  replayListCassette,
  bootOffline,
};
