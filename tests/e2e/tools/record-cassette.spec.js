// 一次性录制器（连真实 PTT，guest-only）：把一篇真实文章 / 一个看板列表录成永久素材。
//   产出 1：tests/e2e/cassettes/<name>.json     —— 原始 recv 分页（Layer1 Playwright 离线重放）
//   产出 2：tests/unit/fixtures/replay/<name>.page.json —— 每页文字快照 + golden 累积（Layer2 vitest 纯逻辑）
//
// 用法（PowerShell）：
//   $env:RECORD_MODE="article"; $env:RECORD_BOARD="Stock"; $env:RECORD_NAME="stock-comments"; yarn record:cassette
//   $env:RECORD_MODE="list";    $env:RECORD_BOARD="C_Chat"; $env:RECORD_NAME="cchat-list";    yarn record:cassette
//
// 隐私（CLAUDE.md，公开 fork 必守）：
//  - 凭证优先读 tests/e2e/.ptt-creds.json（gitignored，密码不进聊天/命令列）；无则强制 guest。
//  - capture 是 article-scoped（hook 装在登入后、Enter 前清空 buffer）→ 只含公开文章内容。
//  - 即使用真实帐号登入：写档前对 recv + fixture 文字做「登入帐号等长 redact」+ assertNoLeak 把关，
//    命中即抛错不写。素材里帐号一律遮成 xxxx；meta 不存真实帐号名（只记 guest/account）。
//  - commit 前仍务必 git diff 复查产出档不含本机路径 / OS 使用者名 / PTT 帐号。
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const {
  login,
  gotoBoard,
  sendKey,
  typeLine,
  applyPrefs,
  readScreen,
  attachConsole,
} = require('../helpers/ptt');
// 隐私遮蔽的唯一真相源（src/js/redact.js 是纯 ESM，Playwright 内建 transform 会转成
// CJS —— 同 helpers/ptt.js require src/js/totp 的先例）。
const { scrub } = require('../../../src/js/redact');

const MODE = process.env.RECORD_MODE || 'article';
const BOARD = process.env.RECORD_BOARD || 'Stock';
const NAME = process.env.RECORD_NAME || `${BOARD.toLowerCase()}-${MODE}`;
// 页数上限：回归守门用前若干页即足，且控制素材大小/重放时长。0 = 不限。
const MAX_PAGES = parseInt(process.env.RECORD_MAX_PAGES || '12', 10);

const CASSETTE_DIR = path.join(__dirname, '..', 'cassettes');
const FIXTURE_DIR = path.join(__dirname, '..', '..', 'unit', 'fixtures', 'replay');

// 与 easy-reading.spec.js / comment_parse.js 同源的推文列辨识（raw 文字，无 floor badge）。
const COMMENT_RE = /^(推|噓|→)\s+([0-9A-Za-z]+)\s*:/;

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 0) + '\n', 'utf8');
}

// 凭证来源：tests/e2e/.ptt-creds.json（gitignored，密码不进聊天/命令列）> 既有 env > guest。
function loadCreds() {
  const f = path.join(__dirname, '..', '.ptt-creds.json');
  if (fs.existsSync(f)) {
    try {
      const c = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (c.user) process.env.PTT_USER = c.user;
      if (c.pass) process.env.PTT_PASS = c.pass;
      return true;
    } catch (e) {}
  }
  return !!process.env.RECORD_ALLOW_LOGIN;
}

// 额外要遮的 id（env RECORD_REDACT_EXTRA="id1,id2"）：用于「登入帐号 != 文章里出现的自己
// 其他 id」的情形——典型是 Fw 转录文的「※ 转录者: <自己另一个 id>」。
function extraRedactIds() {
  return (process.env.RECORD_REDACT_EXTRA || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

// 对一段文字套用所有遮蔽：登入帐号 + 额外 id + IPv4，全部走 src/js/redact 这个唯一真相源
// （scrub = 逐个 id 套边界式 redactUser，最后套 redactIPs；'guest'/空字串在 redactUser 内
// 就 early return）。**不要在这里另开一份实作** —— 隐私把关拆成两半 = 只修一半时另一半
// 静默失效。守护在 tests/unit/redact.test.js。
function scrubText(str, user) {
  return scrub(str, [user, ...extraRedactIds()]);
}

// 对整卷 cassette 的 recv（base64 latin1）逐段 redact。保留 step 的其余栏位
// （如 list jump step 的 num —— 离线测试要知道跳的目标序号）。
function redactCassette(cassette, user) {
  cassette.steps = cassette.steps.map((s) => Object.assign({}, s, {
    recv: Buffer.from(scrubText(Buffer.from(s.recv, 'base64').toString('latin1'), user), 'latin1').toString('base64'),
  }));
  return cassette;
}

// 对 fixture 的文字（pageScreens / golden）redact。
function redactFixture(fixture, user) {
  if (Array.isArray(fixture.pageScreens))
    fixture.pageScreens = fixture.pageScreens.map((page) => page.map((t) => scrubText(t, user)));
  if (fixture.golden) {
    if (Array.isArray(fixture.golden.comments))
      fixture.golden.comments = fixture.golden.comments.map((t) => scrubText(t, user));
    if (fixture.golden.firstCommentAuthor)
      fixture.golden.firstCommentAuthor = scrubText(fixture.golden.firstCommentAuthor, user);
  }
  return fixture;
}

// 写档前最后把关：解码所有 recv + fixture 文字，确认不含登入帐号（case-insensitive）。
// 命中 → 抛错不写（请改录别篇，或该 id 是你自己公开发的内容时人工确认）。
function assertNoLeak({ cassette, fixture, user }) {
  const ids = [];
  if (user && user !== 'guest') ids.push(user.toLowerCase());
  for (const id of extraRedactIds()) ids.push(id.toLowerCase());
  if (!ids.length) return;
  const hit = (s) => s && ids.some((id) => s.toLowerCase().includes(id));
  for (const s of cassette.steps)
    if (hit(Buffer.from(s.recv, 'base64').toString('latin1')))
      throw new Error(`隐私把关失败：cassette recv 仍含帐号 [${ids.join(', ')}] 之一。请检查 redact / RECORD_REDACT_EXTRA。`);
  const texts = []
    .concat(...(fixture.pageScreens || []))
    .concat((fixture.golden && fixture.golden.comments) || []);
  for (const t of texts)
    if (hit(t)) throw new Error(`隐私把关失败：fixture 文字仍含帐号 [${ids.join(', ')}] 之一。`);
}

test.describe('cassette 录制器', () => {
  test.skip(!process.env.RECORD_CASSETTE, '只在 yarn record:cassette（RECORD_CASSETTE=1）时执行');

  test(`record ${MODE} ${BOARD} → ${NAME}`, async ({ page }) => {
    test.setTimeout(240000);
    // 凭证：有 .ptt-creds.json / RECORD_ALLOW_LOGIN 用真实帐号；否则强制 guest（privacy）。
    const allowLogin = loadCreds();
    if (!allowLogin) {
      delete process.env.PTT_USER;
      delete process.env.PTT_PASS;
    }
    const loginUser = process.env.PTT_USER || 'guest'; // redact/scrub 目标

    const logs = attachConsole(page);
    await page.goto('/');
    console.log(await login(page)); // guest 或真实帐号
    await gotoBoard(page, BOARD);

    if (MODE === 'list') {
      // 看板列表。RECORD_LIST_SCRIPT 未设 → 单页静态（旧行为，pageState 2，仅 start step）。
      // 设了 → 多 step 脚本：每个动作直接 app.conn.send(bytes)（不经键盘映射，边界确定），
      // 等回应静止后 flush 成一个 step —— 与 list 好读 v4 的 CommandQueue「一命令一回应」
      // 模型一一对应（重放时 tests/e2e/helpers/replay.js#replayListCassette 依 on 门控喂）。
      const LIST_SCRIPTS = {
        '': [],
        // 导航卷（对应 v4 锚定预读的「jump 到缓冲边缘 + PgUp」命令对 + 开文 + 返回
        // + 返回后再深卷一对——jump 目标一律取当前画面最上方可读序号，与 runtime
        // bufferEdgeNum(up) 的选择一致，重放门控按 step.num 精确比对）：
        //   fill 对×2 → 开文 jump+Enter → ← 返回 → restore 后 demand 对×1。
        nav: ['jump', 'pageup', 'jump', 'pageup', 'jump', 'open', 'back', 'jumpsame', 'pageup'],
        // prompt 卷：'/' 开标题搜寻 prompt、空 Enter 取消（prompt 误判回归素材）。
        prompt: ['slash', 'cancel'],
        // 置底文开启卷（对应 _beginOpenPinned 的序列化命令）：jump 到画面最大
        // 序号（游标已在底端时单发 End 无回应，先跳号保证每步有回应）→ End →
        // ↑×2（要求看板置底 ≥3 篇；离线测试以 End 停驻列往上数 2 列为目标）
        // → Enter 开文 → ← 返回。
        pinned: ['jumpmax', 'end', 'up', 'up', 'open', 'back'],
        // v 已读设定卷（v5 T2 交易素材）：jump 同步游标（runtime _beginMark 的
        // mark-sync-jump 前置腿——b_mark_read_unread 以 server 游标为基准，W 用
        // 游标文章时间戳当分界，协定 §7）→ 'v' 开 prompt（底 4 列清 + getdata
        // 提示）→ 空 Enter 取消 —— 取消同样 return FULLUPDATE（server 全幅重绘
        // 收尾），一卷同时覆盖 prompt 指纹与确定性收尾，且零副作用（不真改已读记录）。
        mark: ['jump', 'mark', 'cancel'],
        // '/' 搜寻进出对卷（v5 MODE_SELECT 交易素材，协定 §8）：'/' 开 prompt →
        // 键入关键字 + Enter（RECORD_QUERY，默认 'Re'——标题含 Re: 常见，保证命中）
        // → NEWDIRECT 全幅重建搜寻清单 → ← 退出 → NEWDIRECT 回主列表。
        search: ['slash', 'query', 'back'],
      };
      const scriptName = process.env.RECORD_LIST_SCRIPT || '';
      const script = LIST_SCRIPTS[scriptName];
      if (!script)
        throw new Error(
          `未知 RECORD_LIST_SCRIPT="${scriptName}"（可用: ${Object.keys(LIST_SCRIPTS).filter(Boolean).join(' / ')}）`
        );

      await page.waitForTimeout(1500);
      // 装 onData 累积 hook + flush 工具（此时才装：登入/进板 recv 不进素材，article-scoped 同理）。
      await page.evaluate((recordQuery) => {
        const app = window.__app;
        window.__recordQuery = recordQuery;
        window.__rl = { cur: [], steps: [], pageScreens: [] };
        const orig = app.onData.bind(app);
        app.onData = (d) => {
          window.__rl.cur.push(d);
          return orig(d);
        };
        window.__rlFlush = (on, extra) => {
          const recv = window.__rl.cur.join('');
          window.__rl.cur = [];
          const buf = app.buf;
          const rows = [];
          for (let r = 0; r < buf.rows; r++) rows.push(buf.getRowText(r, 0, buf.cols));
          window.__rl.steps.push(Object.assign({ on, recv: btoa(recv) }, extra || {}));
          window.__rl.pageScreens.push(rows);
        };
      }, process.env.RECORD_QUERY || 'Re');

      // start step：Ctrl-L 触发 server 全页重送。
      await page.evaluate(() => {
        window.__rl.cur = [];
        window.__app.conn.send('\x0c');
      });
      await waitRecvQuiet(page);
      await page.evaluate(() => window.__rlFlush('start'));

      // 脚本动作：清 cur → 送 bytes → 等回应静止 → flush 为一个 step。
      let lastJumpNum = null;
      for (const action of script) {
        const info = await page.evaluate(({ action, lastJumpNum }) => {
          const app = window.__app;
          let keys;
          let extra = null;
          if (action === 'pageup') keys = '\x1b[5~';
          else if (action === 'pagedown') keys = '\x1b[6~';
          else if (action === 'end') keys = '\x1b[4~';
          else if (action === 'up') keys = '\x1b[A';
          else if (action === 'back') keys = '\x1b[D';
          else if (action === 'slash') keys = '/';
          else if (action === 'mark') keys = 'v';
          else if (action === 'query') {
            const q = window.__recordQuery || 'Re';
            keys = q + '\r';
            extra = { query: q };
          } else if (action === 'open' || action === 'cancel') keys = '\r';
          else if (action === 'jump' || action === 'jumpsame' || action === 'jumpmax') {
            let num = null;
            if (action === 'jumpmax') {
              // 画面「最下方文章序号」＝最大序号——对齐 _beginOpenPinned 的
              // bufferEdgeNum(down) 锚点选择。
              const buf = app.buf;
              const rowTexts = [];
              for (let r = 0; r < buf.rows; r++) rowTexts.push(buf.getRowText(r, 0, buf.cols));
              const nums = window.__pageArticleNums(rowTexts, buf.cur_y);
              for (let r = buf.rows - 2; r >= 3 && num == null; r--) {
                if (nums[r] != null) num = nums[r];
              }
            } else if (action === 'jumpsame') {
              // 与上一个 jump 同目标（对应 runtime「restore 后 demand-up 的锚点
              // = 缓冲最旧序号 = 开文那篇」）。
              num = lastJumpNum;
            } else {
              // 当前页「最上方文章序号」——用与 runtime 相同的 pageArticleNums
              // （含旧全形 ● 游标列盖头时的邻居回推），对齐 bufferEdgeNum(up) 的选择。
              const buf = app.buf;
              const rowTexts = [];
              for (let r = 0; r < buf.rows; r++) rowTexts.push(buf.getRowText(r, 0, buf.cols));
              const nums = window.__pageArticleNums(rowTexts, buf.cur_y);
              for (let r = 3; r <= buf.rows - 2 && num == null; r++) {
                if (nums[r] != null) num = nums[r];
              }
            }
            if (num == null) throw new Error(action + ': 找不到跳号目标');
            keys = String(num) + '\r';
            extra = { num };
          } else throw new Error('未知 action: ' + action);
          window.__rl.cur = [];
          app.conn.send(keys);
          return { keys, extra };
        }, { action, lastJumpNum });
        if (info.extra && info.extra.num != null) lastJumpNum = info.extra.num;
        await waitRecvQuiet(page);
        await page.evaluate(
          ({ action, extra }) => window.__rlFlush(action, extra),
          { action, extra: info.extra }
        );
        console.log(`[record] list step ${action}${info.extra ? ' num=' + info.extra.num : ''}`);
      }

      const rec = await page.evaluate(() => ({
        steps: window.__rl.steps,
        pageScreens: window.__rl.pageScreens,
        pageState: window.__app.buf.pageState,
      }));
      const meta = {
        mode: 'list',
        board: BOARD,
        recordedAs: loginUser === 'guest' ? 'guest' : 'account',
        recordedAt: new Date().toISOString(),
      };
      if (scriptName) meta.script = scriptName;
      const cassette = { meta, cols: 80, rows: 24, steps: rec.steps };
      const fixture = {
        meta,
        pageState: rec.pageState,
        pageScreens: rec.pageScreens,
        actions: ['start'].concat(script),
      };
      // 列表画面状态列含「我是<id>」→ 真实帐号录制必含登入帐号：redact + 把关。
      redactCassette(cassette, loginUser);
      redactFixture(fixture, loginUser);
      assertNoLeak({ cassette, fixture, user: loginUser });
      writeJson(path.join(CASSETTE_DIR, `${NAME}.json`), cassette);
      writeJson(path.join(FIXTURE_DIR, `${NAME}.page.json`), fixture);
      console.log(
        `[record] list → ${NAME}: ${rec.steps.length} step (${['start'].concat(script).join('/')})`
      );
      return;
    }

    // ---- article 模式：进好读、逐页累积，录 byte 分页 + 每页文字快照 ----
    await applyPrefs(page, { enableEasyReading: true, showFloorNumbers: true });

    // 定位目标文章（装 hook 前先到目标列，避免列表移动 recv 污染第一页）：
    //  - RECORD_SEARCH 设了 → '/' 标题搜寻指定文章（如黃仁勳那篇）；找不到(过期)即抛错。
    //  - 否则 → End 跳到最新一篇。
    if (process.env.RECORD_SEARCH) {
      await sendKey(page, 'Slash');
      await page.waitForTimeout(800);
      await typeLine(page, process.env.RECORD_SEARCH);
      await page.waitForTimeout(1500);
      const s = await readScreen(page);
      if (!s.includes(process.env.RECORD_SEARCH)) {
        throw new Error(
          `找不到文章「${process.env.RECORD_SEARCH}」(可能已过期)。\n--- 当前画面 ---\n${s}\n---`
        );
      }
    } else {
      await sendKey(page, 'End');
      await page.waitForTimeout(800);
    }

    // 装录制 hook（必须在 Enter 之前；Enter 后第一页 recv 才会被完整捕捉）。
    await page.evaluate((maxPages) => {
      const app = window.__app;
      window.__rec = { steps: [], pageScreens: [], cur: [], maxPages, capped: false };
      const snapshot = () => {
        const buf = app.buf;
        const rows = [];
        for (let r = 0; r < buf.rows; r++) rows.push(buf.getRowText(r, 0, buf.cols));
        return rows;
      };
      const origOnData = app.onData.bind(app);
      app.onData = (data) => {
        window.__rec.cur.push(data);
        return origOnData(data);
      };
      window.__recFlush = () => {
        const on = window.__rec.steps.length === 0 ? 'start' : 'pagedown';
        const recv = window.__rec.cur.join('');
        window.__rec.cur = [];
        window.__rec.steps.push({ on, recv: btoa(recv) });
        window.__rec.pageScreens.push(snapshot()); // 此刻 buf = 该页 settled 画面
      };
      const er = app.easyReading;
      const origSend = er._send.bind(er);
      er._send = (d) => {
        if (d.indexOf('\x1b[6~') >= 0) {
          window.__recFlush(); // 翻页前 flush 当前页（此页已 accumulate 进 pageLines）
          if (window.__rec.maxPages && window.__rec.steps.length >= window.__rec.maxPages) {
            window.__rec.capped = true;
            return; // 吞掉这次 page-down → 不再要下一页（无 race：pageLines 停在已 flush 的页）
          }
        }
        return origSend(d);
      };
    }, MAX_PAGES);

    // 清掉 End 造成的列表 recv，再开文章。
    await page.evaluate(() => {
      window.__rec.cur = [];
    });
    await sendKey(page, 'Enter');

    // 等好读累积到底（reachedPageEnd），或页数稳定。
    const deadline = Date.now() + 120000;
    let lastCount = -1;
    let stable = 0;
    while (Date.now() < deadline) {
      const st = await page.evaluate(() => ({
        end: !!window.__app.easyReading.easyReadingReachedPageEnd,
        capped: !!window.__rec.capped,
        steps: window.__rec.steps.length,
        ps: window.__app.buf.pageState,
      }));
      if (st.end || st.capped) break; // 到底 或 触及页数上限
      if (st.steps === lastCount) {
        if (++stable >= 6) break; // ~6×800ms 无新页 → 认定到底
      } else {
        stable = 0;
        lastCount = st.steps;
      }
      await page.waitForTimeout(800);
    }

    // 收尾：到底(reachedPageEnd)时最后一页没有 page-down → 补 flush；触上限(capped)时
    // 最后一页已在 hook 内 flush 过、且已停止翻页（pageLines 与 steps 一致）→ 不再 flush。
    // golden 必须在（可选的）End 切回原生「之前」读 pageLines（exitEasyReading 会清空它）。
    const golden = await page.evaluate(() => {
      const app = window.__app;
      if (!window.__rec.capped) window.__recFlush();
      const buf = app.buf;
      return buf.pageLines.map((_, r) => buf.getRowText(r, 0, buf.cols, buf.pageLines));
    });

    // 可选：录「好读 End→原生跳到底」的 server 回应，存为 'end' step（player 等测试触发 \x1b[4~ 才喂）。
    if (process.env.RECORD_END) {
      await page.evaluate(() => {
        window.__rec.cur = [];
        window.__app.easyReading.switchToNativeAtBottom(); // 送 \x1b[4~ + exitEasyReading
      });
      await page.waitForTimeout(2500);
      await page.evaluate(() => {
        const recv = window.__rec.cur.join('');
        window.__rec.cur = [];
        window.__rec.steps.push({ on: 'end', recv: btoa(recv) });
      });
    }

    const fin = await page.evaluate(() => ({
      steps: window.__rec.steps,
      pageScreens: window.__rec.pageScreens,
    }));
    const rec = { steps: fin.steps, pageScreens: fin.pageScreens, accRows: golden };

    // golden：从累积 pageLines 取推文列（raw 文字）。
    const accComments = rec.accRows.filter((t) => COMMENT_RE.test(t));
    const firstAuthor = accComments.length ? accComments[0].match(COMMENT_RE)[2].toLowerCase() : null;

    const meta = {
      mode: 'article',
      board: BOARD,
      recordedAs: loginUser === 'guest' ? 'guest' : 'account',
      recordedAt: new Date().toISOString(),
      pages: rec.steps.length,
      commentCount: accComments.length,
      firstCommentAuthor: firstAuthor,
    };
    const cassette = { meta, cols: 80, rows: 24, steps: rec.steps };
    const fixture = {
      meta,
      pageScreens: rec.pageScreens, // 每页 24 列 settled 文字（Layer2 重建去重用）
      golden: { comments: accComments, commentCount: accComments.length, firstCommentAuthor: firstAuthor },
    };

    // 真实帐号录制：文章底部「→ 你的id:」输入列可能含登入帐号 → redact + 把关。
    redactCassette(cassette, loginUser);
    redactFixture(fixture, loginUser);
    // golden.firstCommentAuthor 经 redact 后可能变动；若它正好是登入者（你自己推文）会被遮蔽。
    meta.firstCommentAuthor = fixture.golden.firstCommentAuthor;
    assertNoLeak({ cassette, fixture, user: loginUser });

    writeJson(path.join(CASSETTE_DIR, `${NAME}.json`), cassette);
    writeJson(path.join(FIXTURE_DIR, `${NAME}.page.json`), fixture);

    console.log(
      `[record] article → ${NAME}: ${rec.steps.length} 页, ${accComments.length} 推文, 首推=${fixture.golden.firstCommentAuthor}`
    );
    console.log('\n=== console tail ===\n' + logs.slice(-20).join('\n'));

    expect(rec.steps.length).toBeGreaterThan(0);
    expect(accComments.length).toBeGreaterThan(0); // 没推文的文章不适合当素材
  });
});

// 等 list 录制的当前动作回应静止：__rl.cur 累积 byte 数连续 3 次轮询（~1.2s）不再
// 增长即认定回应完毕。内容谓词才是重放侧的完成判定；录制侧只要边界「宽松地晚」——
// 多等无害（recv 不会混入下一动作，因为下一动作 send 前会先 flush）。
async function waitRecvQuiet(page, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    const n = await page.evaluate(() =>
      window.__rl.cur.reduce((a, s) => a + s.length, 0)
    );
    if (n === last && n > 0) {
      if (++stable >= 3) return;
    } else {
      stable = 0;
      last = n;
    }
    await page.waitForTimeout(400);
  }
  console.log('[record] waitRecvQuiet 超时（继续 flush 当前累积）');
}

// 触发整页重画并录下 server 回送的 recv（list 模式用）。Ctrl-L = '\x0c'。
async function captureRedraw(page) {
  await page.evaluate(() => {
    const app = window.__app;
    window.__rl = [];
    const orig = app.onData.bind(app);
    app.onData = (d) => {
      window.__rl.push(d);
      return orig(d);
    };
    app.conn.send('\x0c'); // Ctrl-L 重画
  });
  await page.waitForTimeout(2000);
  return await page.evaluate(() => btoa(window.__rl.join('')));
}
