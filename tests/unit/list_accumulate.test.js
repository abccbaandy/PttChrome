// v4-stabilize bug 2 回归（使用者实测：置底文有时少一篇）：
//   (a) pinned map 的 key 必须含作者（author|title）——两篇「标题栏切片相同、
//       作者不同」的置底公告若只用标题当 key 会互相覆写、少一篇。
//   (b) 游标停在置底列时该列也要收录（旧守门 i!==cur_y 一刀切，游标長期停在
//       置底列时它永远进不了 buffer）。真置底列即使被 ● 盖头，★ 仍在第 4-5 格
//       可辨识；收录时把 ● 的两格还原成空白。游标停在「序号不可回推的一般文章
//       列」（无 ★）时仍须排除（避免 ● 列被误档成置底，v3 坑 4）。
// 直接以 stub buf 呼叫真的 TermView.prototype.accumulateListLines（逻辑不碰 DOM）。
import { TermView } from "../../src/js/term_view";
import { pinnedRowKey } from "../../src/js/list_session";

function chRow(text, cols = 80) {
  const padded = text.padEnd(cols);
  const row = [];
  for (const c of padded) row.push({ ch: c, isLeadByte: false });
  return row;
}

function fakeView(texts, curY) {
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
    _listNumMap: null,
    _listPinnedMap: null,
    accumulateListLines: TermView.prototype.accumulateListLines,
    resetListAccumulation: TermView.prototype.resetListAccumulation,
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
