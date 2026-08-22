// dirty-row 逐列 patch（src/render/screen.js#_buildNodes 的第三層重用）。
//
// 背景：原生／列表畫面每收到一幀就整份重畫。去 React 化之後 renderer 仍然每列都
// 重建節點，再用 outerHTML 比對決定要不要沿用舊節點——省掉 DOM 抽換，沒省掉「建
// 節點 + 兩次序列化」。這一層讓 renderer 對「這一幀沒被寫過的列」完全不建節點。
//
// 它的正確性建立在一組守門上，守錯了就是**靜默畫出上一幀**（最難查的那種 bug），
// 所以這裡的每一條等價測試都拿「同一批內容、全新 controller 全量重建」當對照組
// 逐字比對 DOM，而不是比對某幾個屬性。
//
// 兩個 dirty 來源（見 term_view.redraw）：
//   changedRows        活 buffer（buf.lines）：server 這一幀寫了哪幾列
//   rowIdentityStable  快照列（列表好讀視窗）：列參考相同即內容相同

const counters = vi.hoisted(() => ({ rowRender: 0 }));

vi.mock("../../src/render/row", async (importOriginal) => {
  const actual = await importOriginal();
  const counting = (props) => {
    ++counters.rowRender;
    return actual.buildRow(props);
  };
  return { ...actual, buildRow: counting, default: counting };
});

const { ScreenController } = await import("../../src/render/screen");
const { row, seg, listRow, color, normalizeHtml } = await import(
  "./helpers/screen_fixtures"
);

const live = [];
function mount(p) {
  const root = document.createElement("div");
  root.className = "main";
  document.body.appendChild(root);
  const controller = new ScreenController(root);
  const entry = {
    controller,
    root,
    get container() {
      return controller.container;
    },
    update: (next) => controller.update(next),
  };
  live.push(entry);
  controller.update(p);
  return entry;
}

afterEach(() => {
  while (live.length) {
    const e = live.pop();
    e.controller.destroy();
    e.root.remove();
  }
  counters.rowRender = 0;
});

const PROPS = {
  forceWidth: 20,
  enableLinkInlinePreview: false,
  enableLinkHoverPreview: false,
};

const LIST_ENHANCE = {
  blacklist: new Set(),
  titleBlacklist: [],
  showFloorNumbers: false,
  mergeSameAuthorComments: false,
  highlightAuthor: false,
  articleAuthor: null,
  selectedPusher: null,
  autoFixUrl: false,
  bareDomainLink: false,
  enableXMention: false,
  pageState: 2,
  easyReading: false,
  onAidClick: null,
  dropHidden: false,
  inListContext: false,
  articleId: "dirty-1",
};

const props = (lines, enhanceExtra) =>
  Object.assign(
    { lines, enhance: Object.assign({}, LIST_ENHANCE, enhanceExtra) },
    PROPS,
  );

// 對照組：全新的 controller、同一批 lines／enhance，但**不給**任何 dirty hint。
// 逐字相同才算等價。
function expectMatchesFullRebuild(entry, lines, enhanceExtra) {
  const full = mount(props(lines, enhanceExtra));
  expect(normalizeHtml(entry.container)).toBe(normalizeHtml(full.container));
}

// 活 buffer 的就地改寫：列**物件**不換，內容整列換掉（term_buf 的行為）。
function overwriteRow(target, ...parts) {
  const next = row(...parts);
  target.length = 0;
  for (let i = 0; i < next.length; ++i) target.push(next[i]);
  return target;
}

const listLines = () => [
  listRow("alice", "R: [情報] 第一篇"),
  listRow("bob", "□ [閒聊] 第二篇"),
  listRow("carol", "□ [心得] 第三篇"),
  listRow("dave", "R: [問題] 第四篇"),
  listRow("erin", "□ [公告] 第五篇"),
  listRow("frank", "□ [討論] 第六篇"),
];

const EDITED = " 350024 + 9 6/15 dave        R: [問題] 改過的標題";

describe("changedRows（活 buffer）", () => {
  test("只有 dirty 列被重畫，畫面與全量重建逐字相同", () => {
    const lines = listLines();
    const s = mount(props(lines));

    overwriteRow(lines[3], seg(EDITED));
    s.update(props(lines.slice(), { changedRows: [3] }));

    expectMatchesFullRebuild(s, lines.slice(), {});
  });

  test("沿用的是同一個 DOM 節點，不是重建成一模一樣的", () => {
    // 鎖的是症狀而不是實作：節點被抽換 ⇒ 使用者正在拉的選取範圍每 30ms 斷一次。
    const lines = listLines();
    const s = mount(props(lines));
    const before = Array.from(s.container.children);

    overwriteRow(lines[3], seg(EDITED));
    s.update(props(lines.slice(), { changedRows: [3] }));

    const after = Array.from(s.container.children);
    expect(after[0]).toBe(before[0]);
    expect(after[5]).toBe(before[5]);
    expect(after[3]).not.toBe(before[3]);
  });

  test("不在 changedRows 的列一列都不建（優化真的發生了）", () => {
    const lines = listLines();
    const s = mount(props(lines));

    overwriteRow(lines[3], seg(EDITED));
    counters.rowRender = 0;
    s.update(props(lines.slice(), { changedRows: [3] }));

    expect(counters.rowRender).toBe(1);
  });

  test("沒給 changedRows 的幀退回全量（每列都要重建）", () => {
    const lines = listLines();
    const s = mount(props(lines));
    counters.rowRender = 0;
    s.update(props(lines.slice()));
    expect(counters.rowRender).toBe(lines.length);
  });

  test("annotationsKey 變了就不准只畫 dirty 列", () => {
    // 黑名單是逐列標註的輸入之一，但它一次影響的是「所有列」。守門看的是整幀的
    // key，不是 changedRows。
    const lines = listLines();
    const s = mount(props(lines));

    s.update(
      props(lines.slice(), {
        blacklist: new Set(["bob"]),
        changedRows: [],
      }),
    );

    expect(s.container.textContent).toContain("本文已被黑名單");
    expectMatchesFullRebuild(s, lines.slice(), { blacklist: new Set(["bob"]) });
  });

  test("列物件被換掉就必須重畫，即使它不在 changedRows", () => {
    // 承重條件 prevLines[row] === lines[row]。原生 24 列 ↔ 列表視窗 24 列互換、
    // buf.lines ↔ buf.pageLines 互換、term_buf.scroll() 把列物件搬到別的 index，
    // 三件事都靠它一次擋掉。
    const lines = listLines();
    const s = mount(props(lines));

    const next = lines.slice();
    next[3] = listRow("zoe", "□ [心得] 換了一個列物件");
    s.update(props(next, { changedRows: [] }));

    expect(s.container.textContent).toContain("換了一個列物件");
    expectMatchesFullRebuild(s, next, {});
  });

  test("游標底色快路徑之後的下一幀，底色停在正確的列", () => {
    const lines = listLines();
    const s = mount(props(lines));
    s.controller.setCursorHighlight({ row: 2, cls: "b2", col: 0 });
    // 整列底色走快路徑（只搬 class、不重畫）。
    s.controller.setCursorHighlight({ row: 4, cls: "b2", col: 0 });

    overwriteRow(lines[0], seg(EDITED));
    counters.rowRender = 0;
    s.update(props(lines.slice(), { changedRows: [0] }));

    // 快路徑已經把 class 搬到 DOM 上，controller 也必須同步 _prevFrame.highlight：
    // 沒同步的話第 2 / 4 列會被當成「高亮狀態變了」而白白重建（結果正確、白工）。
    expect(counters.rowRender).toBe(1);
    const lit = Array.from(s.container.querySelectorAll(".b2")).map((n) =>
      n.getAttribute("data-row"),
    );
    expect(lit).toEqual(["4"]);
  });
});

describe("rowIdentityStable（列表好讀視窗的快照列）", () => {
  const winProps = (lines) =>
    props(lines, {
      listEasyReading: true,
      easyReading: true,
      rowIdentityStable: true,
    });

  test("frozen 幀（整份視窗原封沿用）一列都不重建", () => {
    const lines = listLines();
    const s = mount(winProps(lines));
    counters.rowRender = 0;
    s.update(winProps(lines.slice()));
    expect(counters.rowRender).toBe(0);
  });

  test("重用是 index-keyed：視窗捲動後每一列都要重畫", () => {
    // 天真實作（「這個列物件上一幀出現過就重用」）會讓 data-row 與內容錯位。
    const pool = listLines();
    const s = mount(winProps(pool.slice(0, 4)));

    const shifted = pool.slice(1, 5);
    counters.rowRender = 0;
    s.update(winProps(shifted));

    expect(counters.rowRender).toBe(4);
    expectMatchesFullRebuild(s, shifted, {
      listEasyReading: true,
      easyReading: true,
    });
  });
});

describe("pageState 3 的跨列耦合守門", () => {
  // annotationsAreRowIndependent 對 READING 一律回 false。理由不是「原生看文章有
  // 跨列邏輯」，而是 functionMode 原生鏡像／防黑守門那兩條分支會帶著
  // easyReading:true 把活 buffer 交進來 ⇒ FloorCounter 全開。
  const READING_ENHANCE = {
    pageState: 3,
    easyReading: true,
    showFloorNumbers: true,
    dropHidden: false,
    stableRows: false,
  };
  const push = (id, text) =>
    row(seg("推 " + id + ": " + text, color(2, 0)), seg("            06/14 12:01"));

  test("一列變成推文列，它之後所有樓號都要跟著位移", () => {
    const lines = [
      row(seg("作者  wowbenny (阿班) 看板  Test")),
      row(seg("內文一行")),
      push("alice", "第一則"),
      push("bob", "第二則"),
      push("carol", "第三則"),
    ];
    const s = mount(props(lines, READING_ENHANCE));

    // 就地把「內文一行」改成推文 ⇒ 全篇樓號 +1。它是唯一的 dirty 列，天真實作
    // 會讓後面三列的樓號停在舊值。
    overwriteRow(lines[1], ...push("zack", "插隊的一則"));
    s.update(
      props(lines.slice(), Object.assign({ changedRows: [1] }, READING_ENHANCE)),
    );

    expectMatchesFullRebuild(s, lines.slice(), READING_ENHANCE);
  });
});
