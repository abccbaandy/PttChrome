import {
  parseKeySpec,
  pageKindOf,
  createAgentTools,
  installAgentTools,
  findArticleUrl,
} from '../../src/js/agent_tools';

const MAIN_MENU = ['【主功能表】                     批踢踢實業坊', '', ''];

function fakeCore(overrides = {}) {
  const buf = new EventTarget();
  Object.assign(buf, {
    rows: 3,
    cols: 80,
    cur_x: 2,
    cur_y: 1,
    pageState: 1,
    lines: MAIN_MENU.slice(),
    pageLines: [],
    getRowText(r, c0, c1, lines) {
      return (lines || this.lines)[r] || '';
    },
  });
  const sent = [];
  const core = {
    buf,
    connectState: 1,
    sent,
    view: {
      useEasyReadingMode: false,
      _send: (b) => sent.push(['bytes', b]),
      _convSend: (t) => sent.push(['text', t]),
    },
    easyReading: { _enabled: false, _pendingEnableOnArticle: false },
    aidNavigation: {
      active: false,
      calls: [],
      // 預設：導航立刻成功（真的流程由 aid_navigation.test.js 守）。
      result: { ok: true },
      onStart: null,
      _go(name, args, cb) {
        this.calls.push([name, ...args]);
        if (this.onStart) this.onStart(name, args);
        cb(this.result);
        return true;
      },
      startBoard(board, opts, cb) {
        return this._go('startBoard', [board, opts], cb);
      },
      startNum(board, num, cb) {
        return this._go('startNum', [board, num], cb);
      },
      startExternal(aid, board, cb) {
        return this._go('startExternal', [aid, board], cb);
      },
    },
    ...overrides,
  };
  return core;
}

const tools = (core) => createAgentTools(core, { pollMs: 5 });
const tool = (core, name) => tools(core).find((t) => t.name === name);

describe('parseKeySpec', () => {
  test('文字與具名鍵分段，文字段合併', () => {
    expect(parseKeySpec('s{Ctrl-U}Gossiping{Enter}')).toEqual([
      { text: 's' },
      { bytes: '\x15' },
      { text: 'Gossiping' },
      { bytes: '\r' },
    ]);
  });

  test('別名與方向鍵對到 term_keyboard 的 byte', () => {
    expect(parseKeySpec('{Esc}{PgUp}{PgDn}{Up}{Left}')).toEqual([
      { bytes: '\x1b' },
      { bytes: '\x1b[5~' },
      { bytes: '\x1b[6~' },
      { bytes: '\x1b[A' },
      { bytes: '\x1b[D' },
    ]);
  });

  test('字面大括號用 LBrace/RBrace，併入文字段', () => {
    expect(parseKeySpec('a{LBrace}b{RBrace}')).toEqual([{ text: 'a{b}' }]);
  });

  test('未知鍵、未配對大括號、空字串都拒絕（不猜）', () => {
    expect(() => parseKeySpec('{F13}')).toThrow('未知的按鍵');
    expect(() => parseKeySpec('abc{Enter')).toThrow('大括號');
    expect(() => parseKeySpec('')).toThrow();
    expect(() => parseKeySpec(undefined)).toThrow();
  });
});

test('pageKindOf', () => {
  expect(pageKindOf(1)).toBe('menu');
  expect(pageKindOf(3)).toBe('article');
  expect(pageKindOf(0)).toBe('other');
});

describe('ptt_list_articles', () => {
  const LIST = [
    '【板主:mod】[八卦] 標語    看板《Gossiping》',
    '[←]離開 [→]閱讀',
    '   編號    日 期 作  者       文  章  標  題',
    ' 780296 + 110/14 someone1     □ [問卦] 較舊',
    ' 780297 +1610/14 someone2     □ [新聞] 最新',
    '>   ★  !   2/21 boardmod     □ [公告] 板規',
    ' 文章選讀  (y)回應(X)推文',
  ];

  test('走 startBoard(end) 後解析畫面：一般文章由新到舊、置底分開', async () => {
    const core = fakeCore();
    core.aidNavigation.onStart = () => {
      core.buf.lines = LIST;
      core.buf.rows = LIST.length;
    };
    const r = await tool(core, 'ptt_list_articles').execute({ board: 'Gossiping' });
    expect(core.aidNavigation.calls).toEqual([['startBoard', 'Gossiping', { end: true }]]);
    expect(r.board).toBe('Gossiping');
    expect(r.articles.map((a) => [a.num, a.title, a.recommend])).toEqual([
      [780297, '[新聞] 最新', '16'],
      [780296, '[問卦] 較舊', '1'],
    ]);
    expect(r.pinned.map((a) => a.title)).toEqual(['[公告] 板規']);
    expect(r.articles[0]).not.toHaveProperty('cursor');
  });

  test('導航失敗 ⇒ 帶原因 reject', async () => {
    const core = fakeCore();
    core.aidNavigation.result = { ok: false, error: '切換看板 X 失敗（miss）' };
    await expect(tool(core, 'ptt_list_articles').execute({ board: 'X' })).rejects.toThrow('切換看板 X 失敗');
  });

  test('沒看過主功能表（未登入）⇒ 拒絕，一個導航都不開', async () => {
    const core = fakeCore();
    core.buf.lines = ['請輸入代號，或以 guest 參觀，或以 new 註冊:', '', ''];
    await expect(tool(core, 'ptt_list_articles').execute({ board: 'Gossiping' })).rejects.toThrow('尚未登入');
    expect(core.aidNavigation.calls).toEqual([]);
  });

  test('登入過一次就算（之後畫面不在主功能表也可以）', async () => {
    const core = fakeCore();
    const ts = tools(core);
    core.buf.dispatchEvent(new CustomEvent('screenSettled'));
    core.buf.lines = LIST;
    core.buf.rows = LIST.length;
    await ts.find((t) => t.name === 'ptt_list_articles').execute({ board: 'Gossiping' });
    expect(core.aidNavigation.calls.length).toBe(1);
  });

  test('背景分頁 ⇒ 拒絕並說明要切到前景（計時器被節流，判定會全錯）', async () => {
    const core = fakeCore();
    const t = createAgentTools(core, { pollMs: 5, doc: { hidden: true } }).find((x) => x.name === 'ptt_list_articles');
    await expect(t.execute({ board: 'Gossiping' })).rejects.toThrow('Page.bringToFront');
    expect(core.aidNavigation.calls).toEqual([]);
  });

  test('板名不是英文名 ⇒ 拒絕（不把任意字串打進 PTT）', async () => {
    await expect(tool(fakeCore(), 'ptt_list_articles').execute({ board: '八卦{Enter}' })).rejects.toThrow('英文名');
  });

  test('序列化操作在線上 ⇒ 拒絕', async () => {
    const core = fakeCore();
    core.aidNavigation.active = true;
    await expect(tool(core, 'ptt_list_articles').execute({ board: 'Gossiping' })).rejects.toThrow('不能操作');
  });
});

const STATUS = (page, total, pct, a, b) =>
  `  瀏覽 第 ${page}/${total} 頁 (${pct}%)  目前顯示: 第 ${a}~${b} 行  (y)回應(X%)推文(h)說明(←)離開 `;

const ARTICLE = [
  ' 作者  someuser (暱稱)                                       看板  Gossiping',
  ' 標題  [問卦] 測試',
  ' 時間  Wed Oct 14 21:00:00 2026',
  '內文 A',
  '內文 B',
  '※ 文章網址: https://www.ptt.cc/bbs/Gossiping/M.1760446800.A.123.html',
  '推 user1: 推                                                       10/14 21:01',
];

describe('ptt_read_article', () => {
  test('原生 pmore：自己 PgDn 到 100%，以重疊去重，解析出檔頭／內文／推文', async () => {
    const core = fakeCore();
    // 一頁 4 列內容＋1 列狀態；第二頁與第一頁重疊 1 列（內文 A）。
    const pages = [
      [...ARTICLE.slice(0, 4), STATUS(1, 2, 60, 1, 4)],
      [...ARTICLE.slice(3, 7), STATUS(2, 2, 100, 4, 7)],
    ];
    let page = 0;
    const show = () => {
      core.buf.lines = pages[page];
      core.buf.rows = pages[page].length;
      core.buf.pageState = 3;
    };
    core.aidNavigation.onStart = show;
    core.view._send = (b) => {
      core.sent.push(['bytes', b]);
      page++;
      setTimeout(show, 10);
    };
    const r = await tool(core, 'ptt_read_article').execute({ board: 'Gossiping', num: 780297 });
    expect(core.aidNavigation.calls).toEqual([['startNum', 'Gossiping', 780297]]);
    expect(core.sent).toEqual([['bytes', '\x1b[6~']]);
    expect(r).toMatchObject({
      board: 'Gossiping',
      num: 780297,
      author: 'someuser',
      title: '[問卦] 測試',
      time: 'Wed Oct 14 21:00:00 2026',
      aid: expect.any(String),
      url: 'https://www.ptt.cc/bbs/Gossiping/M.1760446800.A.123.html',
      complete: true,
    });
    expect(r.content.split('\n').filter((l) => l.startsWith('內文'))).toEqual(['內文 A', '內文 B']);
    expect(r.comments).toEqual([expect.objectContaining({ type: '推', user: 'user1', content: '推' })]);
  });

  test('好讀模式開著：不自己送鍵，等累積頁翻到底且不再長', async () => {
    const core = fakeCore();
    core.view.useEasyReadingMode = true;
    const er = core.easyReading;
    core.aidNavigation.onStart = () => {
      er._enabled = true;
      er.easyReadingReachedPageEnd = false;
      core.buf.pageLines = ARTICLE.slice(0, 3);
      setTimeout(() => {
        core.buf.pageLines = ARTICLE.slice();
        er.easyReadingReachedPageEnd = true;
      }, 20);
    };
    const r = await tool(core, 'ptt_read_article').execute({ board: 'Gossiping', aid: '#1gIeu-3A' });
    expect(core.aidNavigation.calls).toEqual([['startExternal', '1gIeu-3A', 'Gossiping']]);
    expect(core.sent).toEqual([]);
    expect(r.complete).toBe(true);
    expect(r.num).toBe(null);
    expect(r.comments.length).toBe(1);
  });

  test('num／aid 都沒給 ⇒ 拒絕', async () => {
    await expect(tool(fakeCore(), 'ptt_read_article').execute({ board: 'Gossiping' })).rejects.toThrow('擇一');
  });
});

test('findArticleUrl：轉錄標頭之後與看板不符的網址都不算本篇', () => {
  const url = '※ 文章網址: https://www.ptt.cc/bbs/Gossiping/M.1760446800.A.123.html';
  expect(findArticleUrl([url], 'gossiping')).toMatchObject({ board: 'Gossiping', url: expect.stringContaining('M.1760446800') });
  expect(findArticleUrl(['※ [本文轉錄自 Gossiping 看板 #1gIeu-3A ]', url], 'Gossiping')).toBe(null);
  expect(findArticleUrl([url], 'C_Chat')).toBe(null);
});

describe('ptt_read_screen／ptt_send_keys', () => {
  test('read_screen 回傳去尾空白的列、畫面種類、游標', () => {
    const core = fakeCore();
    core.buf.lines = ['【主功能表】  ', 'abc', ''];
    expect(tool(core, 'ptt_read_screen').execute({})).toEqual({
      connected: true,
      page: 'menu',
      rows: ['【主功能表】', 'abc', ''],
      cursor: { row: 1, col: 2 },
      busy: null,
    });
  });

  test('send_keys：文字走 _convSend、具名鍵走 _send，等 screenSettled 後回畫面', async () => {
    const core = fakeCore();
    const p = tool(core, 'ptt_send_keys').execute({ keys: '中{Enter}' });
    expect(core.sent).toEqual([['text', '中'], ['bytes', '\r']]);
    core.buf.lines[1] = 'changed';
    core.buf.dispatchEvent(new CustomEvent('screenSettled'));
    const r = await p;
    expect(r.settled).toBe(true);
    expect(r.rows[1]).toBe('changed');
  });

  test('send_keys 逾時回 settled:false；忙碌或未連線拒絕且不送', async () => {
    expect((await tool(fakeCore(), 'ptt_send_keys').execute({ keys: 'x', timeoutMs: 10 })).settled).toBe(false);
    const busy = fakeCore();
    busy.aidNavigation.active = true;
    await expect(tool(busy, 'ptt_send_keys').execute({ keys: 'x' })).rejects.toThrow('不能操作');
    expect(busy.sent).toEqual([]);
    await expect(tool(fakeCore({ connectState: 2 }), 'ptt_send_keys').execute({ keys: 'x' })).rejects.toThrow(
      '尚未連線'
    );
  });
});

describe('installAgentTools', () => {
  const NAMES = ['ptt_list_articles', 'ptt_read_article', 'ptt_read_screen', 'ptt_send_keys'];

  test('掛 window.pttAgent；沒有 WebMCP 時不註冊', async () => {
    const win = { navigator: {} };
    installAgentTools(fakeCore(), win, {});
    expect(win.pttAgent.list().map((t) => t.name)).toEqual(NAMES);
    expect(win.pttAgent.help).toContain('pttAgent.list()');
    expect((await win.pttAgent.call('ptt_read_screen')).page).toBe('menu');
    await expect(win.pttAgent.call('nope')).rejects.toThrow('未知的工具');
  });

  test('有 document.modelContext 就註冊每個工具，回 MCP text content', async () => {
    const registered = [];
    const doc = { modelContext: { registerTool: (t) => registered.push(t) } };
    installAgentTools(fakeCore(), { navigator: {} }, doc);
    expect(registered.map((t) => t.name)).toEqual(NAMES);
    const out = await registered.find((t) => t.name === 'ptt_read_screen').execute({});
    expect(out.content[0].type).toBe('text');
    expect(JSON.parse(out.content[0].text).page).toBe('menu');
  });

  test('舊名 navigator.modelContext 也認', () => {
    const registerTool = vi.fn();
    installAgentTools(fakeCore(), { navigator: { modelContext: { registerTool } } }, {});
    expect(registerTool).toHaveBeenCalledTimes(NAMES.length);
  });

  test('留一個 meta 提示給掃 DOM 的 agent', () => {
    const appended = [];
    const doc = { head: { appendChild: (n) => appended.push(n) }, createElement: () => ({}) };
    installAgentTools(fakeCore(), { navigator: {} }, doc);
    expect(appended[0]).toMatchObject({ name: 'ai-agent-tools' });
  });
});
