// 給 AI agent 用的 PTT 操作工具：agent 不必懂 PTT 的按鍵與畫面，只呼叫
// 「列出看板最新文章」「讀一篇文章」這類語意動作，拿回結構化 JSON。
// 設計與用法見 docs/agent-tools.md。
//
// 工具定義只寫這一份，兩種傳輸共用：
//   - `window.pttAgent.call(name, args)`：任何標準 CDP client 以 Runtime.evaluate
//     呼叫，Chrome 正式版今天就能用；
//   - WebMCP（`document.modelContext.registerTool`）：瀏覽器有這個 API 才註冊。
//
// 高階工具（list／read）一律走產品既有的序列化導航（aid_navigation 的板跳／跳號／
// 開文，每一步依畫面內容驗證），**不在這裡另寫一套按鍵序列**：PTT 邏輯只在那邊。
// 讀全文：好讀模式開著就等它自動翻完（它本來就會把整篇累積進 buf.pageLines）；
// 沒開才自己在原生 pmore 裡 PgDn，兩條路不會同時送鍵。
//
// 低階工具（read_screen／send_keys）是逃生口：送鍵走 view._send／_convSend（使用者
// 來源的 byte），不走 sendMachineBytes。序列化操作在線上時一律拒絕（serializedOpHint）。

import { KeyMap } from './term_keyboard';
import { serializedOpHint } from './serialized_op_gate';
import { isMainMenuRow } from './aid_navigation';
import { parseStatusRow, statusSignature } from './string_util';
import { findPageOverlap } from './comment_parse';
import { parseArticleUrlLine, isCrossPostHeaderLine } from './aid_parse';
import { listEntriesFromScreen, parseArticleLines } from './agent_parse';

const KEY_ALIASES = { Esc: 'Escape', PgUp: 'PageUp', PgDn: 'PageDown', Return: 'Enter' };
const KEY_PAGE_DOWN = KeyMap.PageDown;

// 'abc{Enter}{Ctrl-U}中文' → [{text:'abc'}, {bytes:'\r'}, {bytes:'\x15'}, {text:'中文'}]
// text 段要轉 Big5（_convSend），bytes 段原樣送（_send）。未知的 {Token} 直接 throw：
// 送錯鍵比不送糟（認不出 ⇒ 不動作）。字面大括號用 {LBrace}／{RBrace}。
export function parseKeySpec(spec) {
  if (typeof spec !== 'string' || spec === '') throw new Error('keys 必須是非空字串');
  const parts = [];
  const pushText = (s) => {
    if (!s) return;
    const last = parts[parts.length - 1];
    if (last && last.text !== undefined) last.text += s;
    else parts.push({ text: s });
  };
  const re = /\{([^{}]*)\}/g;
  let at = 0;
  let m;
  while ((m = re.exec(spec))) {
    pushText(spec.slice(at, m.index));
    at = re.lastIndex;
    const name = m[1];
    if (name === 'LBrace') { pushText('{'); continue; }
    if (name === 'RBrace') { pushText('}'); continue; }
    const ctrl = /^Ctrl-([A-Za-z])$/.exec(name);
    if (ctrl) {
      parts.push({ bytes: String.fromCharCode(ctrl[1].toUpperCase().charCodeAt(0) - 64) });
      continue;
    }
    const bytes = KeyMap[KEY_ALIASES[name] || name];
    if (bytes === undefined) throw new Error('未知的按鍵 {' + name + '}');
    parts.push({ bytes });
  }
  const rest = spec.slice(at);
  if (/[{}]/.test(rest)) throw new Error('大括號沒配對；字面大括號請用 {LBrace}／{RBrace}');
  pushText(rest);
  return parts;
}

const PAGE_KINDS = { 1: 'menu', 2: 'list', 3: 'article', 5: 'press-any-key', 6: 'editor' };

export function pageKindOf(pageState) {
  return PAGE_KINDS[pageState] || 'other';
}

function screenRows(buf) {
  const rows = [];
  for (let r = 0; r < buf.rows; r++) rows.push(buf.getRowText(r, 0, buf.cols).replace(/\s+$/, ''));
  return rows;
}

export function readScreen(core) {
  const buf = core.buf;
  return {
    connected: core.connectState === 1,
    page: pageKindOf(buf.pageState),
    rows: screenRows(buf),
    cursor: { row: buf.cur_y, col: buf.cur_x },
    busy: serializedOpHint(core),
  };
}

// 全文的「※ 文章網址」→ { board, aid, url }。兩道守門同 aid_navigation.findLocalPostAid：
// 轉錄標頭之後的網址是原文的；看板不符的網址是轉錄帶進來的（pttbbs 擋同板轉錄）。
export function findArticleUrl(lines, board) {
  for (const text of lines) {
    if (isCrossPostHeaderLine(text)) return null;
    const hit = parseArticleUrlLine(text);
    if (!hit) continue;
    if (board && hit.board.toLowerCase() !== board.toLowerCase()) return null;
    const m = text.match(/https?:\/\/\S+/);
    return { board: hit.board, aid: hit.aid, url: m ? m[0] : null };
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 等下一次 screenSettled（畫面靜止）。逾時回 false，不算錯。
function waitSettled(buf, timeoutMs) {
  return new Promise((resolve) => {
    let timer;
    const done = (settled) => {
      clearTimeout(timer);
      buf.removeEventListener('screenSettled', onSettled);
      resolve(settled);
    };
    const onSettled = () => done(true);
    buf.addEventListener('screenSettled', onSettled);
    timer = setTimeout(() => done(false), timeoutMs);
  });
}

async function waitUntil(pred, timeoutMs, stepMs = 100) {
  const limit = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return true;
    if (Date.now() >= limit) return false;
    await sleep(stepMs);
  }
}

// 背景分頁（document.hidden）裡 Chrome 把 setTimeout 節流到 ≥1 秒（藏超過 5 分鐘再
// 拉到 1 分鐘）。term_buf 的 settle（SETTLE_MS）與 CommandQueue 的逾時／探針全靠計時器
// ⇒ 逾時先於 settle 觸發，每一步都誤判（2026-10 live 實錄：板尾明明到了，End 照樣逾時）。
// 這不是調參數能修的，所以直接拒絕並講清楚怎麼辦。
export const HIDDEN_TAB_ERROR =
  'PTT 分頁在背景：Chrome 會節流背景分頁的計時器，操作無法正確判定。' +
  '請把分頁切到前景（CDP：Page.bringToFront）後再試。';

export function createAgentTools(core, opts = {}) {
  const pollMs = opts.pollMs || 100;
  const doc = opts.doc !== undefined ? opts.doc : typeof document !== 'undefined' ? document : null;
  // 「已登入」＝這條連線看過主功能表（同 deep_link_controller 的訊號）。沒登入時
  // 高階工具的逃生前導（←）與板名會被打進登入畫面的帳號欄 ⇒ 一律拒絕。
  let loggedIn = false;
  const noteScreen = () => {
    if (core.connectState !== 1) loggedIn = false;
    else if (isMainMenuRow(core.buf.getRowText(0, 0, core.buf.cols))) loggedIn = true;
  };
  if (core.buf && core.buf.addEventListener) core.buf.addEventListener('screenSettled', noteScreen);

  const assertVisible = () => {
    if (doc && doc.hidden) throw new Error(HIDDEN_TAB_ERROR);
  };

  function assertCanSend() {
    if (core.connectState !== 1) throw new Error('尚未連線到 PTT');
    assertVisible();
    const busy = serializedOpHint(core);
    if (busy) throw new Error('目前不能操作：' + busy);
  }

  function assertReady() {
    assertCanSend();
    noteScreen();
    if (!loggedIn) throw new Error('尚未登入 PTT（請先在頁面上完成登入）');
  }

  // aid_navigation 的一輪 → Promise。onEnd 一定會被呼叫（成功或 _fail）；外加
  // 一個上限防呆（回呼漏接時不讓 agent 永遠卡住）。
  function runNav(start, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('導航逾時')), timeoutMs);
      const ok = start((result) => {
        clearTimeout(timer);
        if (result.ok) resolve();
        else reject(new Error(result.error || '導航失敗'));
      });
      if (!ok) {
        clearTimeout(timer);
        reject(new Error('目前畫面不能開始導航'));
      }
    });
  }

  // 好讀模式：等自動翻頁翻到底、累積頁不再長。
  async function collectEasyReading(timeoutMs) {
    const er = core.easyReading;
    const buf = core.buf;
    let lastLen = -1;
    let stable = 0;
    const done = await waitUntil(() => {
      assertVisible();
      const len = (buf.pageLines || []).length;
      const atEnd = er.easyReadingReachedPageEnd && !er._functionMode && !er._reverse;
      stable = atEnd && len === lastLen && len > 0 ? stable + 1 : 0;
      lastLen = len;
      return stable >= 3;
    }, timeoutMs, pollMs);
    const acc = buf.pageLines || [];
    const lines = [];
    for (let r = 0; r < acc.length; r++) lines.push(buf.getRowText(r, 0, buf.cols, acc).replace(/\s+$/, ''));
    return { lines, complete: done };
  }

  // 原生 pmore：自己 PgDn 到 100%，以內容重疊去重（同好讀的 findPageOverlap）。
  async function collectNative(timeoutMs) {
    const buf = core.buf;
    const limit = Date.now() + timeoutMs;
    const pageText = () => screenRows(buf).slice(0, buf.rows - 1);
    const status = () => parseStatusRow(buf.getRowText(buf.rows - 1, 0, buf.cols));
    let lines = pageText();
    for (;;) {
      const s = status();
      if (!s || s.pagePercent >= 100) return { lines, complete: !!s };
      if (Date.now() >= limit) return { lines, complete: false };
      assertVisible();
      const sig = statusSignature(s);
      core.view._send(KEY_PAGE_DOWN);
      const moved = await waitUntil(() => {
        const n = status();
        return !!n && statusSignature(n) !== sig;
      }, Math.min(5000, Math.max(0, limit - Date.now())), pollMs);
      if (!moved) return { lines, complete: false };
      const next = pageText();
      lines = lines.concat(next.slice(findPageOverlap(lines, next)));
    }
  }

  async function collectArticle(timeoutMs) {
    const er = core.easyReading;
    // 好讀 pref 開著時落地後由它接手（_enqueueOpen 會呼叫 ensureEnabledOnArticle；
    // 落地幀不完整時是 _pendingEnableOnArticle，下一個完整幀才進）。
    if (core.view.useEasyReadingMode && er) {
      await waitUntil(() => er._enabled || !er._pendingEnableOnArticle, 2000, pollMs);
      if (er._enabled) return collectEasyReading(timeoutMs);
    }
    return collectNative(timeoutMs);
  }

  return [
    {
      name: 'ptt_list_articles',
      description:
        '列出 PTT 某看板最新的文章（約一頁，含置底文）。回傳 articles（一般文章，編號由新到舊）' +
        '與 pinned（置底文）。每篇有 num（編號，給 ptt_read_article 用）、date、author、title、' +
        'recommend（推文數，「爆」=100 以上、X 開頭為噓）、deleted。看板名稱用英文（如 Gossiping）。' +
        '要更舊的文章：把上次回傳的 nextBefore 當 before 再呼叫一次（只回編號小於 before 的那一頁，' +
        '不含置底文）；nextBefore 為 null 表示已經到第一篇。置底文用 pinned 的 index 給 ptt_read_article 讀。',
      inputSchema: {
        type: 'object',
        properties: {
          board: { type: 'string', description: '看板英文名，如 Gossiping' },
          before: { type: 'number', description: '只列編號小於它的文章（翻更舊的頁），用上次的 nextBefore' },
          timeoutMs: { type: 'number', description: '上限，預設 30000' },
        },
        required: ['board'],
      },
      execute: async (args) => {
        const board = String((args && args.board) || '').trim();
        if (!/^[0-9A-Za-z_-]+$/.test(board)) throw new Error('board 必須是看板英文名');
        const hasBefore = args && args.before != null;
        const before = hasBefore ? Number(args.before) : null;
        if (hasBefore && !(Number.isInteger(before) && before > 1)) throw new Error('before 必須是大於 1 的文章編號');
        assertReady();
        const nav = core.aidNavigation;
        // 更舊的頁：跳到 before-1 那篇（停在列表、不開），畫面就是它所在的那一頁。
        const opts = hasBefore ? { num: before - 1 } : { end: true };
        await runNav((cb) => nav.startBoard(board, opts, cb), (args && args.timeoutMs) || 30000);
        const entries = listEntriesFromScreen(screenRows(core.buf));
        const strip = ({ cursor, ...e }) => e;
        const articles = entries
          .filter((e) => !e.pinned && e.num != null && (!hasBefore || e.num < before))
          .sort((a, b) => b.num - a.num)
          .map(strip);
        const oldest = articles.length ? articles[articles.length - 1].num : null;
        return {
          board,
          articles,
          pinned: hasBefore ? [] : entries.filter((e) => e.pinned).map(strip).map((e, index) => ({ ...e, index })),
          nextBefore: oldest != null && oldest > 1 ? oldest : null,
        };
      },
    },
    {
      name: 'ptt_read_article',
      description:
        '讀取一篇 PTT 文章的全文（自動翻完所有頁）。用 board＋num（ptt_list_articles 的編號）' +
        '或 board＋aid（文章代碼，如 1gIeu-3A）或 board＋pinned（置底文，ptt_list_articles 的 pinned[].index）' +
        '指定。回傳 author、title、time、content（內文）、' +
        'comments（推文：type 推/噓/→、user、content、time）、aid、url、complete（是否讀到結尾）。',
      inputSchema: {
        type: 'object',
        properties: {
          board: { type: 'string', description: '看板英文名' },
          num: { type: 'number', description: '文章編號（ptt_list_articles 的 num）' },
          aid: { type: 'string', description: '文章代碼，可含開頭的 #' },
          pinned: { type: 'number', description: '置底文序號（ptt_list_articles 的 pinned[].index，從 0 起）' },
          timeoutMs: { type: 'number', description: '讀全文的上限，預設 60000' },
        },
        required: ['board'],
      },
      execute: async (args) => {
        const board = String((args && args.board) || '').trim();
        const aid = String((args && args.aid) || '').trim().replace(/^#/, '');
        const num = Number(args && args.num);
        const hasPinned = args && args.pinned != null;
        const pinned = hasPinned ? Number(args.pinned) : null;
        if (!/^[0-9A-Za-z_-]+$/.test(board)) throw new Error('board 必須是看板英文名');
        if (hasPinned && !(Number.isInteger(pinned) && pinned >= 0)) throw new Error('pinned 必須是 0 起的整數');
        if (!aid && !(num > 0) && !hasPinned) throw new Error('num、aid、pinned 必須擇一');
        assertReady();
        const nav = core.aidNavigation;
        await runNav(
          (cb) =>
            aid
              ? nav.startExternal(aid, board, cb)
              : hasPinned
                ? nav.startPinned(board, pinned, cb)
                : nav.startNum(board, num, cb),
          30000
        );
        const { lines, complete } = await collectArticle((args && args.timeoutMs) || 60000);
        const found = findArticleUrl(lines, board);
        return Object.assign({ board, num: aid || hasPinned ? null : num }, parseArticleLines(lines), {
          aid: found ? found.aid : aid || null,
          url: found ? found.url : null,
          complete,
        });
      },
    },
    {
      name: 'ptt_read_screen',
      description:
        '（低階）讀取目前 PTT 終端機畫面：每列文字、畫面種類（menu/list/article/' +
        'press-any-key/editor/other）、游標位置、是否忙碌。高階工具做不到時才用。',
      inputSchema: { type: 'object', properties: {} },
      execute: () => readScreen(core),
    },
    {
      name: 'ptt_send_keys',
      description:
        '（低階）對 PTT 送出按鍵，等畫面靜止後回傳新畫面。需要懂 PTT 操作，優先用高階工具。' +
        '特殊鍵寫法 {Enter} {Esc} {Tab} {Backspace} {Up} {Down} {Left} {Right} {PgUp} {PgDn} ' +
        '{Home} {End} {Delete} {Ctrl-X}；字面大括號用 {LBrace}/{RBrace}。一次送一個動作、' +
        '看完回傳畫面再決定下一步。不要用它登入或輸入密碼。',
      inputSchema: {
        type: 'object',
        properties: {
          keys: { type: 'string', description: '要送出的按鍵序列' },
          timeoutMs: { type: 'number', description: '等畫面靜止的上限，預設 3000' },
        },
        required: ['keys'],
      },
      execute: async (args) => {
        const parts = parseKeySpec(args && args.keys);
        assertCanSend();
        const settled = waitSettled(core.buf, (args && args.timeoutMs) || 3000);
        for (const p of parts) {
          if (p.text !== undefined) core.view._convSend(p.text);
          else core.view._send(p.bytes);
        }
        return Object.assign({ settled: await settled }, readScreen(core));
      },
    },
  ];
}

// 工具回傳值一律包成 MCP 的 text content（JSON）。
function toMcpResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export const AGENT_HINT =
  'PTT agent 工具：window.pttAgent.list() 列出工具，window.pttAgent.call(name, args) 呼叫（回 Promise）。';

export function installAgentTools(core, win = window, doc = document) {
  const tools = createAgentTools(core, { doc });
  const byName = new Map(tools.map((t) => [t.name, t]));
  win.pttAgent = {
    help: AGENT_HINT,
    list: () => tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    call: async (name, args) => {
      const tool = byName.get(name);
      if (!tool) throw new Error('未知的工具 ' + name);
      return tool.execute(args || {});
    },
  };
  // 純 CDP 沒有標準的工具發現機制：留一個 agent 掃 DOM 讀得到的 meta 當提示。
  if (doc && doc.head && doc.createElement) {
    const meta = doc.createElement('meta');
    meta.name = 'ai-agent-tools';
    meta.content = AGENT_HINT;
    doc.head.appendChild(meta);
  }
  // WebMCP：規格還在 origin trial，名稱從 navigator 搬到 document，兩個都認。
  const mc = (doc && doc.modelContext) || (win.navigator && win.navigator.modelContext);
  if (!mc || typeof mc.registerTool !== 'function') return;
  for (const t of tools) {
    try {
      mc.registerTool({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        execute: async (args) => toMcpResult(await t.execute(args || {})),
      });
    } catch (e) {
      console.warn('WebMCP registerTool 失敗：' + t.name, e);
    }
  }
}
