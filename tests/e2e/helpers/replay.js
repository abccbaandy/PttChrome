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
const {
  beginImageRequest,
  endImageRequest,
  fulfillImageRequest,
  imageScenarioFor,
  resolveImageProfile,
  setPageImageProfile,
  slowImageDelayMs,
} = require('./offline_images');

const CASSETTE_DIR = path.join(__dirname, '..', 'cassettes');
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');

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

// stub 只接管 **BBS 那一条** WebSocket，其余（Vite dev server 的 HMR socket）
// 一律放行给原生 WebSocket。
//
// 踩过的坑（偶发红的根因，别再拿掉）：installReplay 覆写的是**全域**
// window.WebSocket ⇒ 连 Vite HMR client 的 socket 也被接管，它送出的
// `vite:forward-console` JSON 被记进 window.__sent / __replay.sent，混进
// 「app 送给 PTT 的 bytes」里。症状：long_push.offline 期望 sentText === 'X'
// 却拿到 'X{"type":"custom","event":"vite:forward-console",...}'。页面里冒出任何
// console error / unhandled rejection 才触发转发 ⇒ 偶发而非必现，而且哪个 spec
// 中枪取决于当下页面吐了什么（mouse.offline 也中过）。
// 连带修掉：window.__stubWS 之前会被后建立的 HMR socket 覆盖，
// ui_behavior.offline.spec.js 的 __stubWS.close() 就关不到 BBS 连线。
//
// 判准：URL 的 path 结尾是 /bbs —— dev 走本机 proxy ws://localhost:8080/bbs、
// prod 走 wss://ws.ptt.cc/bbs（vite.config.mjs 的 DEFAULT_SITE + pttchrome.jsx
// #connect 的 wstelnet/wsstelnet → ws/wss 转换）。Vite HMR 是 ws://host:port/?token=…
// ⇒ pathname '/' ⇒ 不攔。
// 纯函式守护：tests/unit/offline_ws_stub_url.test.js。
function isBbsSocketUrl(raw) {
  if (typeof raw !== 'string' && !(raw && typeof raw.toString === 'function')) return false;
  let url;
  try {
    url = new URL(String(raw));
  } catch (e) {
    return false;
  }
  return /(^|\/)bbs$/.test(url.pathname);
}

// addInitScript：必须在 page.goto 之前呼叫，覆写 window.WebSocket。
//
// opts.neverOpen=true：模拟「**从未连上**」（PTT 维护中 / ws.ptt.cc 不可达）——不 fire
//   open，改 fire error + close，与浏览器对失败握手的事件序列一致。这条路径与「先连上
//   再断线」**不同**：App.onConnect 从不执行 ⇒ TermView.setConn 从没被呼叫 ⇒
//   `view.conn === undefined`（见 pttchrome.jsx:263）。用 Playwright 的
//   page.routeWebSocket() 做不到这件事：它会把 mock 的 WebSocket 在页面里**开起来**
//   （types.d.ts「Playwright assumes that WebSocket will be mocked, and opens the
//   WebSocket inside the page」），onConnect 照跑。
async function installReplay(page, opts = {}) {
  const neverOpen = opts.neverOpen === true;
  const isBbsSrc = isBbsSocketUrl.toString();
  await page.addInitScript(({ neverOpen, isBbsSrc }) => {
    // 判准的**唯一来源**是模组里那支纯函式（有 unit 守护）；addInitScript 的
    // callback 会被序列化送进页面、看不到模组作用域，所以把原始码一起带进来。
    const isBbsSocketUrl = new Function('return (' + isBbsSrc + ')')();
    const NativeWebSocket = window.WebSocket;
    class StubWebSocket {
      constructor(url, protocols) {
        // 不是 BBS 那条（Vite HMR…）⇒ 交还给原生 WebSocket，别记进送出纪录。
        // class constructor 回传物件即以该物件为 new 的结果。
        if (!isBbsSocketUrl(url))
          return protocols === undefined
            ? new NativeWebSocket(url)
            : new NativeWebSocket(url, protocols);
        this.url = url;
        this.binaryType = 'arraybuffer';
        this.readyState = 0; // CONNECTING
        this._listeners = {};
        window.__stubWS = this;
        // 异步 fire open，让 App.onConnect 在事件回圈里跑（与原生 WS 行为一致）。
        setTimeout(() => {
          if (neverOpen) {
            this.readyState = 3; // CLOSED
            this._emit('error', {});
            this._emit('close', {});
            return;
          }
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
  }, { neverOpen, isBbsSrc });
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
//   opts.splitFrames=true：把每个 pagedown step 的 recv **拆成两段**分两次喂，模拟
//     真实的半画帧（PTT 一次回应常被拆成多个 WS message；client 的 notify 有 30ms
//     debounce，所以一次翻页回应会跨好几个 redraw frame）。切点取 payload 里最后一个
//     `ESC[24;`——pfterm 以 per-cell dirty 更新，底部状态列的补丁与游标 park
//     (`ESC[24;80H`) 永远排在内容之后（P6），所以切在那里 = 第一段只有内容、状态列
//     还停在**上一页的旧值**、游标也还没 park。这正是掉页 race 的现场。
//   opts.dropSteps=[n,...]：模拟 pttbbs 的 **typeahead 跳绘**（P4，pfterm.c#refresh
//     在 client 还有按键在途时直接 return 不画）。第 n 个 step 的画面**整个不送**，
//     该次 PageDown 直接得到 n+1 的画面 —— server 端确实翻过去了，只是中间那页从来
//     没画出来。这是「※ 发信站 那段消失」的确切现场，也是 harness 平常测不到的：
//     一般重放以 client 送键为门控，重复送键不会有惩罚，跟真实链路不符。
//   opts.answerHome=true：把 Home（\x1b[1~ → pmore#mf_goTop）当成「回到第一页」来
//     回应（重放 start step 并从头再来一轮）。掉页自癒的**最后手段**会送这个键。
//   opts.answerGoto=true：把 goto-line（`:N\r` → pmore.c `case ':'` → mf_goto(N-1)）
//     当成「跳回被吞掉那一页」来回应：清掉 dropSteps 并把喂食游标倒回**第一个被吞的
//     step**，然后喂它。
//     **这里编码了一个假设，不是录到的事实**：掉页自癒送的 N 是 _accEndRow，而依 P1
//     （PageDown == mf_forward(dispedlines-1) ⇒ S' == E）被吞那一页的起始行号**就是**
//     上一页的结束行号，所以「行号 N」与「被吞的 step」一一对应。P1 若被推翻，这个
//     harness 会绿而真实链路会坏。
//   window.__replay.sent：本次重放中 client 送出的所有 bytes（含自动翻页键），
//     window.__replay.sends：[{data, sig}]，sig = 送出当下所在页的状态列签章，
//     供「同一页不得送两次 PageDown」这类断言用。
async function replayCassette(page, cassette, opts = {}) {
  const easyReading = opts.easyReading !== false;
  const splitFrames = opts.splitFrames === true ? true : (opts.splitFrames || false);
  const dropSteps = opts.dropSteps || [];
  const answerHome = !!opts.answerHome;
  const answerGoto = !!opts.answerGoto;
  await page.evaluate(
    ({ cassette, easyReading, splitFrames, dropSteps, answerHome, answerGoto }) => {
      const app = window.__app;
      const steps = cassette.steps || [];
      let idx = 0;
      let pending = 0; // 尚未喂完的「后半段」数
      window.__replay = {
        done: false, fed: 0, total: steps.length, sent: [], sends: [], split: 0
      };
      window.__stubWSSent = (s) => window.__replay.sent.push(s);
      // done = 自动翻页部分（start + pagedown）全喂完；'end' step 不计入「done」，
      // 它专等测试稍后手动触发 End（switchToNativeAtBottom 送 \x1b[4~）才喂。
      const markDoneIfPaged = () => {
        if (pending > 0) return;
        if (idx >= steps.length || steps[idx].on === 'end') window.__replay.done = true;
      };
      const dropped = new Set(dropSteps);
      const feed = () => {
        // typeahead 跳绘（P4）：被标记的 step 整个画面不送，直接跳到下一个 step 的
        // 画面 —— server 端翻过去了，但中间那页 client 永远收不到。
        while (dropped.has(idx) && idx + 1 < steps.length) {
          window.__replay.dropped = (window.__replay.dropped || 0) + 1;
          idx++;
        }
        const step = steps[idx++];
        const bytes = atob(step.recv); // atob → latin1 bytes string（每 char = 1 byte）
        window.__replay.fed = idx;
        // 半画帧合成：只拆 pagedown（start 是全屏首绘、end 是 End 键，不在 race 路径上）。
        // splitFrames === true → 切在**状态列补丁之前**（第一个 ESC[24;）：第一段只有
        //   内容列，状态列还是上一页的旧值，游标也还没 park。
        // splitFrames === <0..1 数值> → 切在该比例的 byte 位置：让第一段只画到画面
        //   中途，其余列还留着**上一页的内容**（pfterm 只送 dirty cell，未送到的位置
        //   自然维持旧画面）。这才是内容列本身被撕开的现场。
        let cut = -1;
        if (splitFrames && step.on === 'pagedown') {
          cut =
            typeof splitFrames === 'number'
              ? Math.floor(bytes.length * splitFrames)
              : bytes.indexOf('\x1b[24;');
        }
        if (cut > 0) {
          window.__replay.split++;
          pending++;
          app.onData(bytes.slice(0, cut)); // 只有内容列；状态列还是上一页的
          setTimeout(() => {
            app.onData(bytes.slice(cut)); // 状态列补丁 + 游标 park
            pending--;
            markDoneIfPaged();
          }, 80); // > term_buf 的 30ms notify debounce，确保中间那帧真的被 render 到
        } else {
          app.onData(bytes);
        }
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
        // 记下这一次送键是**从哪一页**送出的（状态列 "第 S~E 行" 签章）。翻页是
        // request/response 交易，同一个签章被送两次 = 重复 PageDown（P4 会让中间
        // 那页永远画不出来），所以断言要按签章分组，不能只数总数。
        // t：送键的 wall clock。重放的门控就在这里（送键 → 喂下一页），所以相邻两次
        // 送键的间隔 ≈「收到一页 → 重绘整份累积页 → 送下一个 PageDown」的成本，正是
        // 使用者回报「越读越慢」量到的那条曲线（实录 55ms → 1196ms）。
        window.__replay.sends.push({
          data,
          sig: er._currentPageSignature(),
          t: performance.now(),
        });
        origSend(data); // 进 stub WS，无副作用
        // 掉页自癒送的 Home（pmore KEY_HOME → mf_goTop）：回到文章第一页，从头再翻。
        if (answerHome && data.indexOf('\x1b[1~') >= 0) {
          window.__replay.home = (window.__replay.home || 0) + 1;
          dropped.clear(); // 被吞的那页这次会正常送达
          idx = 0;
          while (idx < steps.length && steps[idx].on === 'start') feed();
          return;
        }
        // goto-line：`:N\r`。见函式头 answerGoto 的假设说明。
        const goto = /^:(\d+)\r$/.exec(data);
        if (answerGoto && goto) {
          window.__replay.gotos = window.__replay.gotos || [];
          window.__replay.gotos.push(Number(goto[1]));
          const first = dropSteps.length ? Math.min.apply(null, dropSteps) : idx;
          dropped.clear(); // 这次不再吞
          idx = first;
          feed();
          return;
        }
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
    { cassette, easyReading, splitFrames, dropSteps, answerHome, answerGoto }
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
        // 'v' 已读设定（2026-07-10 起为 passthrough 代送，bytes 不变）。
        mark: (d) => d === 'v',
        // query：搜寻关键字提交。passthrough 后关键字是「原生逐键打字」送出
        //（一键一个 send，convSend 逐字 Big5），不再是旧交易的整串 kw+\r——
        // 门控改为在 step 上累积，累到 \r 结尾且（有记录 query 时）与其 Big5
        // 相符才喂。录制侧 recv 不变，只是匹配层聚合。
        query: (d, step) => {
          step.__acc = (step.__acc || '') + d;
          if (step.__acc.charAt(step.__acc.length - 1) !== '\r') return false;
          if (step.query == null) return step.__acc.length > 1;
          const want = step.query + '\r';
          const acc = step.__acc;
          step.__acc = '';
          // ASCII 关键字直接比；非 ASCII（送出的是 Big5 bytes，与录制的 UTF-16
          // query 无法在此层直接比对）验到 \r 即喂——顺序门控已保证语境正确。
          return /^[\x00-\x7f]*$/.test(want) ? acc === want : true;
        },
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

// ---------------------------------------------------------------------------
// 离线网路：把「行内开图」会打的**外部**请求全部拦在本地。
//
// 为什么必要（踩过的坑，别再拿掉）：stub WebSocket 只挡掉 PTT 连线，行内预览
// （ImagePreviewer）拿到的是 cassette 里**真实文章的真实图床网址**，浏览器照样
// 会去连 i.imgur.com / pbs.twimg.com / i.urusai.cc。于是「离线重放」其实依赖公网：
//   - 名不副实：无网 / CI 出口受限时整批预览测秒挂。
//   - 顺序相依的 flake：连跑整个 spec 会把同一图床打好几轮 → 变慢/被限流，
//     `waitForSelector` 预设 state:'visible' 而 FallbackImage 在 onLoad 前是
//     display:none ⇒ 载不动就永远等不到 → 单跑绿、整档跑红。
//   - 素材会腐烂：stock-huang 的 i.imgur.com/L976tXr 现在 .webp 回 404（0.6~4.2s
//     抖动）、.png 直接 hang（>15s）。之前会绿纯粹是因为 imgur 的 404 页身也是一张
//     可解码的 PNG（<img> 不看 HTTP status，只要 body 能 decode 就 onLoad）——
//     等于测试早就在测「imgur 的错误图」而不是我们的渲染路径。
//
// 故一律回本地固定回应：图片 → tests/e2e/fixtures/preview.png（800×600，会被
// .easyReadingImg 的 max-height:19em 收敛成固定视觉高度 ⇒ layout 确定性）。
// 影片副档名**刻意不给** fixture（现有 cassette 无直连影片）：日后录到影片素材时
// 会以「video 不 loaded」红出来，而不是静默假绿——那时补一支最小 mp4 fixture 即可。
// 尾綴含 `:`——twitter 的原图是 `<id>.jpg:orig` / `:large`（ImagePreviewer 的 twimg
// resolver 就是这样组 srcset 的），漏掉它会让 twimg 掉进 'blocked' → 四个候选全 404
// → previewError，正是本来要修的症状换个方式重现。
const IMAGE_EXT_RE = /\.(?:jpe?g|png|gif|webp|bmp|apng|avif)(?:$|[?#:])/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
// 「這筆請求是不是本機的」——與 classifyOfflineRequest 共用 LOCAL_HOSTS，避免兩套規則漂移。
// 非 http(s)（data:／blob:）一律不算外部。
function isLocalRequestUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch (e) {
    return true;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  return LOCAL_HOSTS.has(url.hostname);
}

// 纯分类：URL → 该给什么离线回应。抽出来是为了能在 tests/unit 守护
//（tests/unit/offline_network_route.test.js），e2e 只负责把它接到 page.route。
//   'passthrough' 本机 dev server / 非 http(s) → 照常走
//   'image'       图片副档名 → fixture PNG
//   'imgur-album' / 'flickr' → 各自的假 JSON
//   'blocked'     其余（iframe embed、未知 host）→ 404 空身
function classifyOfflineRequest(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch (e) {
    return 'passthrough';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'passthrough';
  // app 自己的 bundle / conv 转码表等一律放行（dev server 在本机）。
  if (LOCAL_HOSTS.has(url.hostname)) return 'passthrough';
  if (url.hostname === 'api.imgur.com') return 'imgur-album';
  if (url.hostname === 'api.flickr.com') return 'flickr';
  if (IMAGE_EXT_RE.test(url.pathname + url.search)) return 'image';
  return 'blocked';
}

// 本次 page 被离线规则接住的外部请求（供「不得有请求逃出去」的守门断言用）。
const servedByPage = new WeakMap();
function offlineServedUrls(page) {
  return servedByPage.get(page) || [];
}

// 本次 page **實際發出**的所有非本機請求（含沒進攔截層的那些）。
// 與 servedByPage 的差集＝逃出 page.route 的請求。
//
// 為什麼要另外記一份：`route.fulfill` 吐出的 301，瀏覽器會跟隨，但那一跳**不再經過
// page.route** ⇒ served 裡看不到它，光靠 served 無法證明「零外流」。2026-08-28 的事故
//（offline e2e 每輪都真的去打自架 imgur Worker，見 helpers/offline_images.js 的
// GONE_ORIGIN 註解）正是這樣躲過所有守門的。
const requestedByPage = new WeakMap();
function offlineExternalUrls(page) {
  return requestedByPage.get(page) || [];
}

// opts.profile（'cache' | 'slow' | 'broken' | 'mixed'，预设由 project 名／env 推导）
// 决定**图片**要回什么 —— 见 helpers/offline_images.js。API 类（imgur 相簿 / flickr）
// 与 blocked 类**不受 profile 影响**：那不是图片，把它们也弄坏只会让失败原因变模糊。
async function installOfflineNetwork(page, opts = {}) {
  const served = [];
  servedByPage.set(page, served);
  // 記錄頁面實際發出的每一筆非本機請求（route 接住的、以及沒接住的都算）。
  const external = [];
  requestedByPage.set(page, external);
  page.on('request', (r) => {
    const u = r.url();
    if (!isLocalRequestUrl(u)) external.push(u);
  });
  // 直接呼叫 installOfflineNetwork 的 spec（connect_failure / deep_link / aid_back_ui）
  // 也要走同一條推導，否則它們哪天進了逆境清單會靜默跑在 'cache'。
  const profile = offlineImageProfile(opts.profile);
  setPageImageProfile(page, profile);
  const delayMs = slowImageDelayMs(process.env);
  // 用**述词**过滤而非 '**/*' + route.continue()：Vite dev server 一页要发好几百个
  // module 请求，全部拉进 Playwright 的拦截层再 continue()（等于每一笔都重发一次）
  // 会把整批 offline e2e 拖到不稳（实测会出现整轮大面积逾时，且与被测 code 无关）。
  // 述词回 false 的请求根本不进拦截层 → 本机流量零开销。
  await page.route(
    (url) => classifyOfflineRequest(url.toString()) !== 'passthrough',
    async (route) => {
      const raw = route.request().url();
      const kind = classifyOfflineRequest(raw);
      if (kind === 'passthrough') return route.continue();
      served.push(raw);
      switch (kind) {
        // imgur 相簿 API：回两张（走 imgurAlbumMedia → 仍会被 'image' 规则接住）。
        case 'imgur-album':
          return route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
              data: {
                images: [
                  { link: 'https://i.imgur.com/offlineA.png' },
                  { link: 'https://i.imgur.com/offlineB.png' },
                ],
              },
            }),
          });
        case 'flickr':
          return route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
              photo: { farm: 1, server: '1', id: '1', secret: 'offline' },
            }),
          });
        // 图片：依情境回应。'cache'（预设）＝立即回 fixture PNG，与本层引入前逐字相同
        //（content-type 报 image/png，浏览器以内容 sniff 解码，所以 .jpg/.gif/.webp
        // 网址拿到 PNG 身体照样 onLoad）。其余情境见 offline_images.js。
        //
        // in-flight 计数**必须**包住整段 await：'slow' 会真的压住 5 秒，那段期间浏览器
        // 连 onLoad 都还没发生，页面上也还没有任何 .previewLoading 以外的痕迹 ——
        // waitPreviewsSettled 只能靠这个计数知道「还没完」。
        case 'image': {
          const scenario = imageScenarioFor(raw, profile);
          beginImageRequest(page);
          try {
            await fulfillImageRequest(route, { scenario, rawUrl: raw, delayMs });
          } finally {
            endImageRequest(page);
          }
          return;
        }
        // 其余（youtube/twitch embed 之类的 iframe、未知 host）：快速 404，不留 hang。
        // iframe 的 load 事件与 HTTP status 无关，照样触发 → InlineIframe 正常显示。
        default:
          return route.fulfill({ status: 404, contentType: 'text/html', body: '' });
      }
    }
  );
}

// 目前這一輪跑在哪個 Playwright project（offline / offline-slow / …）。
// `test.info()` 在測試以外呼叫會丟，所以包 try —— 讓 helper 在 node 直接 require 時也能用。
function currentProjectName() {
  try {
    return require('@playwright/test').test.info().project.name;
  } catch (e) {
    return null;
  }
}

// 這一輪的圖片載入情境。優先序：明確傳入 > env OFFLINE_IMAGE_PROFILE > project 名 > 'cache'。
// 用 project 名而非 env 當主來源，是為了不引入 cross-env（見 CLAUDE.md 建置鏈決策）。
function offlineImageProfile(explicit) {
  if (explicit) return explicit;
  return resolveImageProfile({ env: process.env, projectName: currentProjectName() });
}

// offline spec 共用：裝 stub WS、擋外部網路、開頁、等離線連上。
//
// 第二個參數 `ptt` 已無作用（Developer Mode modal 移除後不再需要關 modal），保留在
// 簽名上只為了不動 40+ 個 `bootOffline(page, ptt)` 呼叫端；多傳的參數會被忽略。
//
// 第三個參數 opts.imageProfile：強制指定圖片載入情境（`image_load_conditions.offline.spec.js`
// 用它逐條驗各情境的產品行為）。不給就依 project 名／env 推導。
async function bootOffline(page, ptt, opts = {}) {  // eslint-disable-line no-unused-vars
  await installReplay(page);
  await installOfflineNetwork(page, { profile: offlineImageProfile(opts.imageProfile) });
  await page.goto('/');
  await waitConnected(page);
}

// 好讀的自動開圖是**延遲載入**的（src/render/inline_preview_slot.js：捲到附近才解析網址
// 並掛上 <ImagePreviewer>，捲遠了再卸掉釋放已解碼的點陣圖）。所以「replay 完就去
// querySelector('img')」永遠只會量到空的佔位盒 —— 要驗預覽，一律先用這兩個 helper 把
// 目標捲進視野並等它掛好。
//
// 這不是為了配合測試而放寬斷言：延遲載入本來就是使用者可見的行為（超長文 287 張圖
// 全部立即載入且永不釋放＝記憶體吃滿），這裡驗的正是它。
//
// **停止條件是 waitPreviewsSettled，不是固定 sleep**（2026-08-27 改）：舊版靠「預覽數
// 連續 3 輪不變 + 300ms」收工，在 'slow' 情境（圖 5.2 秒才回）下會在圖還沒回來時就
// 判定穩定 —— seekInlineMedia 甚至會一路捲到底都找不到任何媒體而回 found:0，測試以
// 「no inline image rendered」假紅。見 helpers/layout.js。
const PREVIEW_SEL =
  '.previewLoading, .previewError, .easyReadingImg, .easyReadingVideo, img.hyperLinkPreview, video.easyReadingVideo, iframe';

// 把 selector 指到的元素捲到視窗中央，等到它裡面的預覽全部到終局（載到／失敗）。
// 回傳實際掛出來的預覽數。
async function mountLazyPreviewsAt(page, selector, { timeout = 60000 } = {}) {
  const { waitPreviewsSettled } = require('./layout');
  const deadline = Date.now() + timeout;
  let n = -1;
  let stable = 0;
  // 每一輪都重新置中：先掛上的那幾張圖載入後會長高，把同一塊的其餘列推出「接近視野」
  // 的範圍 —— 只捲一次會停在「只掛出第一張」的狀態。
  while (Date.now() < deadline && stable < 2) {
    const found = await page.evaluate(
      ({ selector, PREVIEW_SEL }) => {
        const el = document.querySelector(selector);
        if (!el) return -1;
        el.scrollIntoView({ block: 'center' });
        return el.querySelectorAll(PREVIEW_SEL).length;
      },
      { selector, PREVIEW_SEL }
    );
    if (found < 0) return -1;
    await waitPreviewsSettled(page, { timeout: Math.max(1000, deadline - Date.now()) });
    const cur = await page.evaluate(
      ({ selector, PREVIEW_SEL }) => {
        const el = document.querySelector(selector);
        return el ? el.querySelectorAll(PREVIEW_SEL).length : -1;
      },
      { selector, PREVIEW_SEL }
    );
    if (cur === n) ++stable;
    else stable = 0;
    n = cur;
  }
  return n;
}

// 由上往下掃整份累積頁，停在第一個真的把行內媒體掛出來的捲動位置。
// 給「這篇文章到底有沒有自動開圖」這類不指定位置的斷言用。
async function seekInlineMedia(page, { selector, timeout = 90000 } = {}) {
  const { waitPreviewsSettled } = require('./layout');
  const deadline = Date.now() + timeout;
  const geom = await page.evaluate(() => {
    const scroller = document.querySelector('.main');
    if (!scroller) return null;
    return { step: Math.max(200, scroller.clientHeight * 0.8), height: scroller.scrollHeight };
  });
  if (!geom) return { found: 0, scrollTop: 0 };
  for (let y = 0; y <= geom.height && Date.now() < deadline; y += geom.step) {
    await page.evaluate((top) => {
      const scroller = document.querySelector('.main');
      if (scroller) scroller.scrollTop = top;
    }, y);
    // 捲到位之後等**這一批**全部到終局，再數 —— 'slow' 情境下少了這一步就會掃空。
    await waitPreviewsSettled(page, { timeout: Math.max(1000, deadline - Date.now()) });
    const r = await page.evaluate((sel) => ({
      found: document.querySelectorAll(sel).length,
      scrollTop: document.querySelector('.main').scrollTop,
    }), selector);
    if (r.found > 0) return r;
  }
  return page.evaluate((sel) => ({
    found: document.querySelectorAll(sel).length,
    scrollTop: document.querySelector('.main').scrollTop,
  }), selector);
}

module.exports = {
  mountLazyPreviewsAt,
  offlineImageProfile,
  seekInlineMedia,
  CASSETTE_DIR,
  FIXTURE_DIR,
  installOfflineNetwork,
  classifyOfflineRequest,
  isBbsSocketUrl,
  offlineServedUrls,
  offlineExternalUrls,
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
