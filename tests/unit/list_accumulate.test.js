// v4-stabilize bug 2 回归（使用者实测：置底文有时少一篇）：
//   (a) pinned map 的 key 必须含作者（author|title）——两篇「标题栏切片相同、
//       作者不同」的置底公告若只用标题当 key 会互相覆写、少一篇。
//   (b) 游标停在置底列时该列也要收录（旧守门 i!==cur_y 一刀切，游标長期停在
//       置底列时它永远进不了 buffer）。真置底列即使被 ● 盖头，★ 仍在第 4-5 格
//       可辨识；收录时把 ● 的两格还原成空白。游标停在「序号不可回推的一般文章
//       列」（无 ★）时仍须排除（避免 ● 列被误档成置底，v3 坑 4）。
// 直接以 stub buf 呼叫真的 TermView.prototype.accumulateListLines（逻辑不碰 DOM）。
import { TermView } from "../../src/js/term_view";
import { pinnedRowKey, subjectOfListRow, listRowMarkFg } from "../../src/js/list_session";
import { u2b } from "../../src/js/string_util";
import { loadBig5Tables } from "./helpers/load_big5_tables";

function chRow(text, cols = 80) {
  const padded = text.padEnd(cols);
  const row = [];
  for (const c of padded) row.push({ ch: c, isLeadByte: false });
  return row;
}

// 带完整 attr 的假 TermChar 列：预设色（fg7/bg0/无 bright），spans 覆写区段
// attr（[{from,to,fg,bright}]）。造 server 的 last-read 红列 / 推文数彩色列用。
function chRowAttrs(text, spans = [], cols = 80) {
  const row = chRow(text, cols);
  for (const c of row)
    Object.assign(c, {
      fg: 7,
      bg: 0,
      bright: false,
      blink: false,
      underLine: false,
      invert: false,
    });
  for (const s of spans)
    for (let i = s.from; i < s.to && i < row.length; ++i)
      Object.assign(row[i], { fg: s.fg, bright: !!s.bright });
  return row;
}

// server 的 last-read 标红样式：作者栏 [17,29) 1;37、标题区 [29..) 1;31。
const lastReadSpans = [
  { from: 17, to: 29, fg: 7, bright: true },
  { from: 29, to: 80, fg: 1, bright: true },
];

function fakeView(texts, curY, listSession = null) {
  const lines = texts.map((t) => chRow(t));
  return {
    buf: {
      rows: texts.length,
      cols: 80,
      cur_y: curY,
      lines,
      listLines: [],
      listLineNums: [],
      getRowText(r) {
        return texts[r];
      },
    },
    bbscore: listSession ? { listSession } : null,
    _listNumMap: null,
    _listPinnedMap: null,
    accumulateListLines: TermView.prototype.accumulateListLines,
    resetListAccumulation: TermView.prototype.resetListAccumulation,
  };
}

function fakeListSession() {
  return {
    _selectedNum: null,
    _lastReadTitle: null,
    noteLastRead: vi.fn(function (title) {
      if (title) this._lastReadTitle = title;
    }),
    noteEvicted: vi.fn(),
    prunePivot: () => null,
  };
}

const rowToStr = (row) => row.map((c) => c.ch).join("").replace(/\s+$/, "");

describe("pinnedRowKey", () => {
  test("同标题不同作者 → 不同 key；推文数变动 → 同 key", () => {
    const a = "    ★  m 1 6/01 arrenwu      轉 [公告] 板規";
    const a2 = "    ★  m 9 6/01 arrenwu      轉 [公告] 板規"; // 推文数变了
    const b = "    ★  M 3 6/13 SaberTheBest 轉 [公告] 板規"; // 同标题、别的作者
    expect(pinnedRowKey(a)).toBe(pinnedRowKey(a2));
    expect(pinnedRowKey(a)).not.toBe(pinnedRowKey(b));
  });
  test("游标变体（● 盖头）与干净列同 key", () => {
    const clean = "    ★  m 1 6/01 arrenwu      轉 [公告] 板規";
    const cursor = "●  ★  m 1 6/01 arrenwu      轉 [公告] 板規";
    expect(pinnedRowKey(cursor)).toBe(pinnedRowKey(clean));
  });
});

describe("accumulateListLines（置底文收录）", () => {
  const header = [
    "【板主:abc】看板《C_Chat》",
    "[←]離開 [→]閱讀",
    "   編號    日 期 作  者       文  章  標  題",
  ];
  const article = " 350001 + 2 6/14 someoneA     □ [閒聊] 一般文章";
  const feeter = " 文章選讀  (y)回應(X)推文";

  test("同标题不同作者的两篇置底都保留（bug 2a）", () => {
    const texts = header.concat([
      article,
      "    ★  m 1 6/01 arrenwu      轉 [公告] 板規",
      "    ★  M 3 6/13 SaberTheBest 轉 [公告] 板規",
      feeter,
    ]);
    const v = fakeView(texts, 3);
    v.accumulateListLines();
    const pinned = v.buf.listLineNums.filter((n) => n == null).length;
    expect(pinned).toBe(2);
  });

  test("游标停在置底列（●…★）仍收录，且 ● 两格还原空白（bug 2b）", () => {
    const texts = header.concat([
      article,
      "●  ★  m 1 6/01 arrenwu      轉 [公告] 板規", // 游标在置底列
      feeter,
    ]);
    const v = fakeView(texts, 4);
    v.accumulateListLines();
    const pinnedIdx = v.buf.listLineNums.indexOf(null);
    expect(pinnedIdx).not.toBe(-1);
    const text = rowToStr(v.buf.listLines[pinnedIdx]);
    expect(text).not.toContain("●");
    expect(text).toContain("★");
  });

  test("游标停在序号不可回推的一般文章列（无★）仍排除（v3 坑 4 不回归）", () => {
    // 只有游标列一列「像文章但读不到序号」：无数字邻居可回推 → nums 全 null。
    const texts = header.concat([
      "●50039 + 1 6/14 JHENGKUNLIN  □ [母雞] foo", // ● 盖掉序号最高位
      feeter,
    ]);
    const v = fakeView(texts, 3);
    v.accumulateListLines();
    // 不得被误档成置底（无★），也没有可用序号 → buffer 应为空。
    expect(v.buf.listLines.length).toBe(0);
  });

  test("游标在短序号列：relabel 不得把序号末两位写进行首（/搜寻 bug 回归）", () => {
    // MODE_SELECT 搜寻结果序号短（3 位数），数字右对齐、离 ● 有空格 —— ● 盖住的
    // 是 padding 而非数字。旧 relabel 读 cell2 起的数字得 vis=''、prefix=整个序号，
    // 把末两位（"31"）灌进 cells[0,1]，即「行首出现数字」bug。
    const clean530 = "    530 + 7 6/18 Winux        □ [情報] 萬代新TCG品牌";
    const clean531 = "    531 + 4 6/21 turndown4wat □ [情報] 火影忍者進軍卡牌";
    // 真实 DBCS：● 佔 cells[0,1]（lead+trail），其余 cells 与干净列相同。
    const cursorCells = chRow(clean531);
    cursorCells[0] = { ch: "●", isLeadByte: true };
    cursorCells[1] = { ch: "", isLeadByte: false };
    const cursorText = "●" + clean531.slice(2); // rowToText 折叠后的样子
    const texts = header.concat([clean530, cursorText, feeter]);
    const v = fakeView(texts, 4);
    v.buf.lines[4] = cursorCells;
    v.accumulateListLines();
    const idx = v.buf.listLineNums.indexOf(531);
    expect(idx).not.toBe(-1);
    expect(rowToStr(v.buf.listLines[idx])).toBe(clean531.replace(/\s+$/, ""));
  });

  test("游标在 6 位序号列：relabel 仍回填被盖的最高位（原行为不回归）", () => {
    const clean34 = " 353434 +13 7/04 basala5417   □ [閒聊] 一般文章甲";
    const clean35 = " 353435 +18 7/04 owo0204      □ [閒聊] 一般文章乙";
    const cursorCells = chRow(clean35);
    cursorCells[0] = { ch: "●", isLeadByte: true };
    cursorCells[1] = { ch: "", isLeadByte: false };
    const cursorText = "●" + clean35.slice(2);
    const texts = header.concat([clean34, cursorText, feeter]);
    const v = fakeView(texts, 4);
    v.buf.lines[4] = cursorCells;
    v.accumulateListLines();
    const idx = v.buf.listLineNums.indexOf(353435);
    expect(idx).not.toBe(-1);
    expect(rowToStr(v.buf.listLines[idx])).toBe(clean35.replace(/\s+$/, ""));
  });

  test("● 画在非 cur_y 列（mid-response 帧）不得存进 pinned map（●52880 污染回归）", () => {
    // prefetch jump 回应写入中的中间帧：server 已把 ● 画在锚定列，但终端游标
    // （buf.cur_y）还停在别处（如底部输入区）。该列 pageArticleNums 不回推
    // （只回推 cur_y 列）→ num null；strict parse 对 "●52880…" 也 null；作者栏
    // 有效 → 旧逻辑误档成置底存进 _listPinnedMap，bullet 未还原，永久残留
    // 在置底尾巴（使用者实测：置底列后多一行「●52880 RoaringWolf …」）。
    const texts = header.concat([
      article,
      "●52880 +17 7/03 RoaringWolf  □ [星原] 藍色星原 C108出展決定",
      feeter,
    ]);
    const v = fakeView(texts, texts.length - 1); // 游标 park 在底列，不在 ● 列
    v.accumulateListLines();
    const pinned = v.buf.listLineNums.filter((n) => n == null).length;
    expect(pinned).toBe(0);
  });

  test("真实 C_Chat 置底页：四篇置底全数收录且 key 互异（置底文少显示排查）", () => {
    // 列文字取自 cchat-list-pinned 离线素材（4 篇置底：arrenwu ×3 + SaberTheBest）。
    const pinnedRows = [
      "    ★  m 5 6/01 arrenwu      □ [公告] 版務新聞欄提訴",
      "    ★  m 1 6/09 arrenwu      □ [公告] C_Chat板規 v.17.3 加好文清單",
      "    ★  m26 6/09 arrenwu      □ [公告] C_Chat板規 v.17.3 版務內容",
      "    ★  = 6 6/13 SaberTheBest □ [26天] 接力活動",
    ];
    const texts = header.concat([article], pinnedRows, [feeter]);
    const v = fakeView(texts, 3);
    v.accumulateListLines();
    const pinned = v.buf.listLineNums.filter((n) => n == null).length;
    expect(pinned).toBe(4);
    const keys = new Set(pinnedRows.map(pinnedRowKey));
    expect(keys.size).toBe(4);
  });

  test("纯数字推文数的置底列（★ 后接 4/35）全数收录（部分消失主因回归）", () => {
    // 使用者实测：EZsoft/PC_Shopping 公告推文数是纯数字「4」「35」，旧 loose-parse
    // strip ★ 后露出推文数被误判为编号列 → 被排除 → 固定消失。★ 屏蔽推文数后应全收。
    // 由既有 fixture 列替换推文数 token（同宽，作者栏不动）以保欄位精確对齐；
    // 两列作者/标题互异以免 pinnedRowKey 相同被合并。
    const pinnedRows = [
      "    ★  m 5 6/01 arrenwu      □ [公告] 版務新聞欄提訴".replace("m 5", "  4"),
      "    ★  M 3 6/13 SaberTheBest □ [公告] 電蝦板板規 V4.1a".replace("M 3", " 35"),
    ];
    const texts = header.concat([article], pinnedRows, [feeter]);
    const v = fakeView(texts, 3);
    v.accumulateListLines();
    const pinned = v.buf.listLineNums.filter((n) => n == null).length;
    expect(pinned).toBe(2);
  });

  test("last-read 红列残留（两篇同时红）：map 内永存去红列＋noteLastRead 逐帧教学", () => {
    // debug cassette 20260715 实测：开 351462 退回 → 该列 1;37/1;31 标红存入 map；
    // 再开 351459 退回，重绘帧不含 351462 → map 里 351462 的红 clone 永不失效
    // → 两篇同时红。修法＝normalize-on-store：存入前去红＋教 _lastReadTitle。
    const ls = fakeListSession();
    const mkTexts = (rows) => header.concat(rows, [feeter]);
    // 帧1：351460-351462，351462 带 last-read 样式。
    const rows1 = [
      " 351460 +37 7/15 turndown4wat □ [閒聊] 無職轉生作者親回",
      " 351461    7/15 SuperSg      R: [C108] 我想成為影之強者",
      " 351462 + 9 7/15 swps40309    □ [ON] MyGO全體SR卡面公布",
    ];
    const texts1 = mkTexts(rows1);
    const v = fakeView(texts1, 3, ls);
    v.buf.lines[5] = chRowAttrs(rows1[2], lastReadSpans);
    v.accumulateListLines();
    expect(ls.noteLastRead).toHaveBeenLastCalledWith("[ON] MyGO全體SR卡面公布");
    // 帧2：351457-351459（不含 351462），351459 变红。
    const rows2 = [
      " 351457 + 2 7/15 Katsuyuki118 □ [26夏] 與妳相戀到生命盡頭",
      " 351458 + 5 7/15 someoneB     □ [閒聊] 另一篇",
      " 351459 + 1 7/15 someoneC     □ [情報] 被閱讀的那篇",
    ];
    const texts2 = mkTexts(rows2);
    v.buf.lines = texts2.map((t) => chRow(t));
    v.buf.lines[5] = chRowAttrs(rows2[2], lastReadSpans);
    v.buf.getRowText = (r) => texts2[r];
    v.accumulateListLines();
    expect(ls.noteLastRead).toHaveBeenLastCalledWith("[情報] 被閱讀的那篇");
    // map 内两列（推文数栏外）attr 皆须为预设——旧行为 351462 残红即此断言红。
    for (const num of [351462, 351459]) {
      const row = v._listNumMap.get(num);
      expect(row).toBeTruthy();
      for (let i = 0; i < row.length; ++i) {
        if (i >= 8 && i < 12) continue; // mark＋推文数栏豁免
        if (row[i].fg === undefined) continue; // 帧2 素色列没 attr
        expect({ i, num, fg: row[i].fg, bright: !!row[i].bright }).toEqual({
          i,
          num,
          fg: 7,
          bright: false,
        });
      }
    }
  });

  test("last-read 去红不动 mark/推文数栏；「爆」列（仅推文数红）不触发教学", () => {
    const ls = fakeListSession();
    const red = " 351462 +99 7/15 swps40309    □ [ON] MyGO全體SR卡面公布";
    const bao = " 351463 m爆 7/15 someoneD     □ [閒聊] 只有推文數紅的爆文";
    const texts = header.concat([red, bao], [feeter]);
    const v = fakeView(texts, 3, ls);
    // 红列：last-read 样式＋推文数黄（1;33）；爆列：推文数亮红但作者/标题素色。
    v.buf.lines[3] = chRowAttrs(
      red,
      lastReadSpans.concat([{ from: 9, to: 11, fg: 3, bright: true }])
    );
    v.buf.lines[4] = chRowAttrs(bao, [{ from: 9, to: 11, fg: 1, bright: true }]);
    v.accumulateListLines();
    expect(ls.noteLastRead).toHaveBeenCalledTimes(1);
    expect(ls.noteLastRead).toHaveBeenCalledWith("[ON] MyGO全體SR卡面公布");
    const redRow = v._listNumMap.get(351462);
    expect(redRow[9].fg).toBe(3); // 推文数黄保留
    expect(redRow[9].bright).toBe(true);
    expect(redRow[20].fg).toBe(7); // 作者去红
    expect(redRow[20].bright).toBe(false);
    expect(redRow[35].fg).toBe(7); // 标题去红
    const baoRow = v._listNumMap.get(351463);
    expect(baoRow[9].fg).toBe(1); // 爆字原封不动
    expect(baoRow[9].bright).toBe(true);
  });

  test("partial repaint 帧：author 栏 plain、仅标题亮红 → 仍须命中去红＋教学", () => {
    // debug 录制 20260717（ptt-debug-20260717-001556.json t=3477 / 015048 t=7008）：
    // pttbbs 差分重绘的 partial 帧只重画标题区 1;31，author 栏维持 plain fg7。
    // 真实逻辑（bbs.c readdoent:830）高亮本来就只涂 mark→行尾、不含 author 栏
    // ——author 亮白其实是 isonline。单条件（标题区亮色）即须命中。
    const ls = fakeListSession();
    const red = " 351891   7 7/16 laigeorge89  □ [閒聊] 感覺遮斷丟"; // 实录列
    const texts = header.concat([red], [feeter]);
    const v = fakeView(texts, 3, ls);
    // 仅标题区亮红；author 栏 [17,29) 保持预设 plain fg7。
    v.buf.lines[3] = chRowAttrs(red, [{ from: 29, to: 50, fg: 1, bright: true }]);
    v.accumulateListLines();
    expect(ls.noteLastRead).toHaveBeenCalledWith("[閒聊] 感覺遮斷丟");
    const row = v._listNumMap.get(351891);
    expect(row[35].fg).toBe(7); // 标题去红
    expect(row[35].bright).toBe(false);
  });

  test("黄变体（回文 R: 标题）：标题亮黄命中→去黄＋noteLastRead(去R:标题)；红→黄切换旧红不残留", () => {
    // debug 录制 20260717-211732 t=4526：last-read 落在回文（R: 标题）时 server 用
    // 1;33 亮黄（readdoent title_type=REPLY → color '3'）。教学值是去 R: 后的
    // subject（pttbbs currtitle 比对键），render 端依该列自身 mark 上色。
    const ls = fakeListSession();
    const mkTexts = (rows) => header.concat(rows, [feeter]);
    // 帧1：351935 红 last-read。
    const red = " 351935   7 7/16 s386644187   □ [閒聊] 誰的皇帝夢最好";
    const v = fakeView(mkTexts([red]), 3, ls);
    v.buf.lines[3] = chRowAttrs(red, [{ from: 29, to: 60, fg: 1, bright: true }]);
    v.accumulateListLines();
    expect(ls.noteLastRead).toHaveBeenLastCalledWith("[閒聊] 誰的皇帝夢最好");
    // 帧2：351934 黄 last-read（实录属性：author plain、推文数 [9,11) 黄、标题黄）。
    const yel = " 351934  29 7/16 jack0123nj   R: [討論] 敗北女角太多了";
    const texts2 = mkTexts([yel]);
    v.buf.lines = texts2.map((t) => chRow(t));
    v.buf.lines[3] = chRowAttrs(yel, [
      { from: 9, to: 11, fg: 3, bright: true },
      { from: 30, to: 55, fg: 3, bright: true },
    ]);
    v.buf.getRowText = (r) => texts2[r];
    v.accumulateListLines();
    // 去 R: 前缀的 subject（pttbbs subject_ex 等价）
    expect(ls.noteLastRead).toHaveBeenLastCalledWith("[討論] 敗北女角太多了");
    const yelRow = v._listNumMap.get(351934);
    expect(yelRow[35].fg).toBe(7); // 标题去黄
    expect(yelRow[35].bright).toBe(false);
    expect(yelRow[9].fg).toBe(3); // 推文数栏黄豁免保留
    const redRow = v._listNumMap.get(351935);
    expect(redRow[35].fg).toBe(7); // 旧红列仍是干净列
    expect(redRow[35].bright).toBe(false);
  });

  test("游标（●盖头）停在 last-read 红列：relabel＋去红共存", () => {
    const ls = fakeListSession();
    const clean61 = " 351461 + 3 7/15 SuperSg      □ [C108] 前一篇";
    const clean62 = " 351462 + 9 7/15 swps40309    □ [ON] MyGO全體SR卡面公布";
    const cursorCells = chRowAttrs(clean62, lastReadSpans);
    cursorCells[0] = { ch: "●", isLeadByte: true, fg: 7, bg: 0, bright: true };
    cursorCells[1] = { ch: "", isLeadByte: false, fg: 7, bg: 0, bright: true };
    const cursorText = "●" + clean62.slice(2);
    const texts = header.concat([clean61, cursorText], [feeter]);
    const v = fakeView(texts, 4, ls);
    v.buf.lines[4] = cursorCells;
    v.accumulateListLines();
    expect(ls.noteLastRead).toHaveBeenCalledWith("[ON] MyGO全體SR卡面公布");
    const row = v._listNumMap.get(351462);
    expect(rowToStr(row)).toBe(clean62.replace(/\s+$/, ""));
    expect(row[0].bright).toBe(false); // 行首两格也一并归零
    expect(row[20].fg).toBe(7);
    expect(row[35].fg).toBe(7);
    expect(row[35].bright).toBe(false);
  });

  test("推文数变动的置底再累积不产生重复列（v3 bug 5a 不回归）", () => {
    const mk = (cnt) =>
      header.concat([
        article,
        `    ★  m ${cnt} 6/01 arrenwu      轉 [公告] 板規`,
        feeter,
      ]);
    const v = fakeView(mk(1), 3);
    v.accumulateListLines();
    // 同页重画、推文数 1 → 2。
    const texts2 = mk(2);
    v.buf.lines = texts2.map((t) => chRow(t));
    v.buf.getRowText = (r) => texts2[r];
    v.accumulateListLines();
    const pinned = v.buf.listLineNums.filter((n) => n == null).length;
    expect(pinned).toBe(1);
  });
});

describe("buildListWindowLines（last-read title-match decorate-on-render）", () => {
  // pttbbs 真实逻辑（bbs.c readdoent:830）：subject 等于 currtitle 的【每一列】
  // 都高亮，颜色依各列自身 mark（□红/R:黄），范围 mark→行尾、不含 author 栏。
  // 实录 20260717-224420 t=1937：296/298 两篇同标题同时红＝正常行为。
  // map 存去色列，render 对命中列 clone 重上样式：map 原列不得被改。
  const header = [
    "【板主:abc】看板《C_Chat》",
    "[←]離開 [→]閱讀",
    "   編號    日 期 作  者       文  章  標  題",
  ];
  const feeter = " 文章選讀  (y)回應(X)推文";
  const clean61 = " 351461 + 3 7/15 SuperSg      □ [C108] 前一篇";
  const clean62 = " 351462 + 9 7/15 swps40309    □ [ON] MyGO全體SR卡面公布";
  // 与 351462 同主题的回文（R: 前缀，去前缀后 subject 相同）
  const reply63 = " 351463 + 1 7/16 replyGuy     R: [ON] MyGO全體SR卡面公布";

  beforeAll(() => {
    // buildListWindowLines 的 u2b('●') 需要真 Big5 表（string_util 读裸全域 lib）。
    globalThis.window = globalThis;
    loadBig5Tables();
  });

  function renderView(lastReadTitle, cursorAbs) {
    const ls = fakeListSession();
    const texts = header.concat([clean61, clean62, reply63], [feeter]);
    const v = fakeView(texts, 3, ls);
    v.buf.lines[4] = chRowAttrs(clean62, lastReadSpans);
    v.accumulateListLines(); // 建 map＋header/footer 快取，帧教 _lastReadTitle
    expect(ls._lastReadTitle).toBe("[ON] MyGO全體SR卡面公布");
    ls._lastReadTitle = lastReadTitle;
    ls.getWindowView = () => ({ body: [0, 1, 2], cursorAbs });
    v.buildListWindowLines = TermView.prototype.buildListWindowLines;
    v._listWindowLines = null;
    return { v, ls };
  }

  test("同主题多列全部命中：原文红、R:回文黄（各依自身 mark）；map 原列不变", () => {
    const { v } = renderView("[ON] MyGO全體SR卡面公布", -1);
    const out = v.buildListWindowLines();
    const red = out[4]; // body[1] = 351462（原文 □ → 红）
    expect(red).not.toBe(v.buf.listLines[1]);
    expect(red[35].fg).toBe(1);
    expect(red[35].bright).toBe(true);
    expect(red[20].fg).toBe(7); // author 栏不上色（亮白=isonline，非 last-read）
    expect(red[20].bright).toBe(false);
    const yel = out[5]; // body[2] = 351463（回文 R: → 黄）
    expect(yel).not.toBe(v.buf.listLines[2]);
    expect(yel[35].fg).toBe(3);
    expect(yel[35].bright).toBe(true);
    // map/flatten 内原列仍是去色干净列
    expect(v.buf.listLines[1][35].fg).toBe(7);
    expect(v.buf.listLines[1][35].bright).toBe(false);
    // 非命中列 by-reference 直出且无色
    expect(out[3]).toBe(v.buf.listLines[0]);
  });

  test("游标与 last-read 同列：● bullet 与红样式并存", () => {
    const { v } = renderView("[ON] MyGO全體SR卡面公布", 1);
    const out = v.buildListWindowLines();
    const rendered = out[4];
    expect(rendered[0].ch + rendered[1].ch).toBe(u2bBullet());
    expect(rendered[35].fg).toBe(1);
    expect(rendered[35].bright).toBe(true);
  });

  test("换读别篇（_lastReadTitle 换键）→ 旧主题所有列退色", () => {
    const { v } = renderView("[C108] 前一篇", -1);
    const out = v.buildListWindowLines();
    expect(out[4]).toBe(v.buf.listLines[1]); // 旧红列素色直出
    expect(out[5]).toBe(v.buf.listLines[2]);
    const hit = out[3]; // 新键命中列
    expect(hit[35].fg).toBe(1);
    expect(hit[35].bright).toBe(true);
  });

  test("_lastReadTitle=null → 全部素色直出", () => {
    const { v } = renderView(null, -1);
    const out = v.buildListWindowLines();
    expect(out[4]).toBe(v.buf.listLines[1]);
  });

  function u2bBullet() {
    const b = u2b("●");
    return b.charAt(0) + b.charAt(1);
  }
});

describe("subjectOfListRow / listRowMarkFg / isonline 不误触", () => {
  // pttbbs currtitle 比对键（subject_ex 等价，common/bbs/string.c:58）。
  const row = (t) =>
    chRowAttrs(` 351999 + 1 7/17 someone      ${t}`.padEnd(80).slice(0, 80));
  test("mark 剥除＋Re:/Fw: loop 防御剥除（case-insensitive）", () => {
    expect(subjectOfListRow(row("□ [ON] MyGO全體SR卡面公布"))).toBe(
      "[ON] MyGO全體SR卡面公布"
    );
    expect(subjectOfListRow(row("R: [討論] 敗北女角太多了"))).toBe(
      "[討論] 敗北女角太多了"
    );
    expect(subjectOfListRow(row("轉 [情報] 轉錄的文章"))).toBe("[情報] 轉錄的文章");
    expect(subjectOfListRow(row("□ Re: re: 裸前缀防御"))).toBe("裸前缀防御");
    expect(subjectOfListRow(row("□ Fw: 轉信防御"))).toBe("轉信防御");
    expect(subjectOfListRow(chRowAttrs(" ".repeat(80)))).toBe(null);
  });
  test("listRowMarkFg：□=1红 R:=3黄 轉=6青 鎖=5紫 ˇ=2绿", () => {
    expect(listRowMarkFg(row("□ 原文"))).toBe(1);
    expect(listRowMarkFg(row("R: 回文"))).toBe(3);
    expect(listRowMarkFg(row("轉 轉錄"))).toBe(6);
    expect(listRowMarkFg(row("鎖 鎖定"))).toBe(5);
    expect(listRowMarkFg(row("ˇ 投票"))).toBe(2);
  });
  test("isonline 亮白作者（1;37，实录 t=1937 列 289）不触发 last-read 教学", () => {
    const ls = fakeListSession();
    const online = " 351289 + 9 4/20 cloclboy     □ [抽獎] steamgift LV1 抽獎";
    const texts = [
      "【板主:abc】看板《Steam》",
      "[←]離開 [→]閱讀",
      "   編號    日 期 作  者       文  章  標  題",
      online,
      " 文章選讀  (y)回應(X)推文",
    ];
    const v = fakeView(texts, 3, ls);
    // 只有 author 栏 [17,29) 亮白，标题区素色 —— isonline，非 last-read。
    v.buf.lines[3] = chRowAttrs(online, [{ from: 17, to: 29, fg: 7, bright: true }]);
    v.accumulateListLines();
    expect(ls.noteLastRead).not.toHaveBeenCalled();
  });
});
