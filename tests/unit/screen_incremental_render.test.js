// 好讀累積長頁的**增量重算**（src/render/screen.js + screen_annotate_cache.js）。
//
// 背景：好讀文章每收到一頁就同步重繪整份累積頁。原本每幀對全部 n 列重跑
// rowToText / annotateComment / detectRowExtras 並重建 n 個 <Row>，8500 行的長文
// 翻頁週期從 55ms 惡化到 1196ms（實錄 ptt-debug-20260809），越過
// PAGE_DOWN_GRACE_MS 之後還會誤判掉包 → 補送 PageDown → P4 吞頁 → 缺頁自癒 →
// 「讀到一半跳回第一頁 / 卡住不讀」。
//
// 這裡守護兩件事，兩件缺一不可：
//   1. 等價 —— 「一次 render 到位」與「每頁 append 逐步 rerender」的 DOM 完全相同。
//      增量最怕的是算錯（樓層從中間重數、推文合併塊沿用到錯的列…），這條擋住。
//   2. 增量 —— append 一頁之後，重新標註的列數／重建的列節點數是常數級，
//      不是 O(文章)。用計次而非計時（時間在 CI 上會 flake）。
//
// cell 假資料手法：ASCII 單格 cell（同 screen_dropHidden.test.js），但推文列的
// 型別符（推/噓/→ 實際是 2-col DBCS）用「isLeadByte 的 cell + 空字串 cell」頂替
// cols 0-1 —— rowToText 對 `lead.ch + next.ch` 長度為 1 的情形直接回傳，不走 b2u，
// 所以不需要 Big5 對照表，而 comment_merge 的欄位數學（id 從 col 3 起）照樣成立。

const counters = vi.hoisted(() => ({ rowToText: 0, rowRender: 0 }));

vi.mock("../../src/js/comment_parse", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    rowToText: (chars) => {
      ++counters.rowToText;
      return actual.rowToText(chars);
    },
  };
});

vi.mock("../../src/render/row", async (importOriginal) => {
  const actual = await importOriginal();
  const counting = (props) => {
    ++counters.rowRender;
    return actual.buildRow(props);
  };
  return { ...actual, buildRow: counting, default: counting };
});

const { ScreenController } = await import("../../src/render/screen");

// 掛一個畫面；回傳 { container, update, destroy }。
const live = [];
function mountScreen(props) {
  const root = document.createElement("div");
  root.className = "main";
  document.body.appendChild(root);
  const controller = new ScreenController(root);
  const entry = {
    controller,
    get container() {
      return controller.container;
    },
    update: (next) => controller.update(next),
    destroy() {
      controller.destroy();
      root.remove();
      const i = live.indexOf(entry);
      if (i >= 0) live.splice(i, 1);
    },
  };
  live.push(entry);
  controller.update(props);
  return entry;
}
afterEach(() => {
  while (live.length) live[live.length - 1].destroy();
});

const COLOR = {
  fg: 7,
  bg: 0,
  blink: false,
  equals(o) {
    return o === this;
  },
};

function cell(c, isLeadByte) {
  return {
    ch: c,
    isLeadByte: !!isLeadByte,
    isStartOfURL: () => false,
    isEndOfURL: () => false,
    getFullURL: () => null,
    getColor: () => COLOR,
  };
}

const line = (str) => str.split("").map((c) => cell(c));

const COLS = 78;

// 推文列：cols 0-1 型別符、col 2 空格、col 3 起 id、": "、內容、padding、時間戳。
function commentRow(type, uid, text, time) {
  const head = " " + uid + ": " + text;
  const pad = Math.max(1, COLS - 2 - head.length - time.length);
  const rest = head + " ".repeat(pad) + time;
  return [cell(type, true), cell("")].concat(rest.split("").map((c) => cell(c)));
}

// 一篇合成長文：標頭 3 列 + 內文（含一條圖片連結、一條裸網域）+ 分隔線 +
// 發信站 + 推文。推文作者刻意排成「同作者連續 3 則 → 換人 → 同作者 2 則」，
// 讓 groupSameAuthorRuns 產生跨頁邊界的 run；其中一位是黑名單、一位是原PO。
const AUTHORS = ["alpha1", "alpha1", "alpha1", "poster", "badguy", "gamma3", "gamma3"];

function makeArticle(count) {
  const rows = [
    line("作者 poster (暱稱) 看板 Test"),
    line("標題 [測試] 超長文效能"),
    line("時間 Sat Aug  9 22:00:00 2026"),
    line(""),
    line("  內文第一段，含一張圖："),
    line("  https://i.imgur.com/abcdefg.jpg"),
    line("  也提一個裸網域 example.com 看看"),
    line(""),
    line("--"),
    line("※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 1.2.3.4"),
    line("※ 文章網址: https://www.ptt.cc/bbs/Test/M.1000000000.A.000.html"),
  ];
  for (let i = 0; rows.length < count; ++i) {
    const uid = AUTHORS[i % AUTHORS.length];
    const mm = String((i % 59) + 1).padStart(2, "0");
    rows.push(commentRow("推", uid, "留言內容 " + i, "08/09 22:" + mm));
  }
  return rows.slice(0, count);
}

const enhance = () => ({
  blacklist: new Set(["badguy"]),
  titleBlacklist: [],
  showFloorNumbers: true,
  mergeSameAuthorComments: true,
  highlightAuthor: true,
  articleAuthor: "poster",
  selectedPusher: null,
  autoFixUrl: true,
  bareDomainLink: true,
  enableXMention: true,
  pageState: 3,
  easyReading: true,
  dropHidden: true,
  inListContext: false,
  articleId: 1,
  // 好讀累積頁：列是 cloneRow 出來的快照，參考不變即內容不變 → 允許增量快取。
  stableRows: true,
});

const PAGE = 22;

const propsFor = (lines, extra) => ({
  lines,
  forceWidth: 16,
  enableLinkInlinePreview: false,
  enableLinkHoverPreview: false,
  enhance: { ...enhance(), ...extra },
});

function renderAll(lines, extra) {
  return mountScreen(propsFor(lines, extra));
}

describe("好讀累積頁增量重算：與全量重算等價", () => {
  test.each([
    ["剛好整頁", PAGE * 6],
    ["非整頁（最後一頁不滿）", PAGE * 5 + 7],
  ])("%s：逐頁 append 的 DOM == 一次到位的 DOM", (_name, total) => {
    const full = makeArticle(total);

    const once = renderAll(full);
    const expected = once.container.innerHTML;
    once.destroy();

    // 逐頁 append：slice 保留列物件參考，正是 accumulatePageLines 的 concat 形狀。
    const step = renderAll(full.slice(0, PAGE));
    for (let end = PAGE * 2; end < total + PAGE; end += PAGE) {
      step.update(propsFor(full.slice(0, Math.min(end, total))));
    }
    expect(step.container.innerHTML).toBe(expected);
  });

  test("樓層編號逐頁累加，不會從中段重數", () => {
    const total = PAGE * 6;
    const full = makeArticle(total);
    const step = renderAll(full.slice(0, PAGE));
    for (let end = PAGE * 2; end <= total; end += PAGE) {
      step.update(propsFor(full.slice(0, end)));
    }
    const badges = Array.from(
      step.container.querySelectorAll(".floorBadgeNum"),
    ).map((n) => parseInt(n.textContent, 10));
    expect(badges.length).toBeGreaterThan(5);
    // 嚴格遞增且從 1 起算（合併塊只顯示 run 首則，所以會跳號，但不可回頭）。
    expect(badges[0]).toBe(1);
    for (let i = 1; i < badges.length; ++i)
      expect(badges[i]).toBeGreaterThan(badges[i - 1]);
  });

  test("rebuild（換文章／Home 自癒）不得沿用上一篇的快取", () => {
    const first = makeArticle(PAGE * 3);
    const step = renderAll(first);
    // 全新的列物件（term_view 的 rebuild 分支＝ newRows.map(cloneRow)）
    const second = makeArticle(PAGE * 2).map((row) =>
      row.map((c) => cell(c.ch, c.isLeadByte)),
    );
    step.update(propsFor(second, { articleId: 2 }));
    const fresh = renderAll(second, { articleId: 2 });
    expect(step.container.innerHTML).toBe(fresh.container.innerHTML);
  });

  // 推文者高亮**不是**標註層的東西（見 screen_annotate_cache.annotationsKey 的
  // 「刻意不含」段）：它只是一個 class，由 ScreenController.setSelectedPusher 逐列
  // 切換。放進 annotationsKey 的年代，點一下推文列＝整份長頁全量重算 + 每一列節點
  // 重建，兩個實際回報的症狀：
  //   1. 每個 inlinePreviewSlot 被 disposeNode 收掉重建 ⇒ pinned=null ⇒ minHeight
  //      歸零 ⇒ 圖片佔位盒塌陷再非同步撐回來（合併推文的空白區閃爍）
  //   2. 節點抽換落在雙擊的第二個 mousedown 之前 ⇒ 雙擊選字時好時壞
  // 這三條鎖「切換高亮＝零重算、零節點抽換」。
  test("切換推文者高亮：不重算標註、不重建任何一列節點", () => {
    const full = makeArticle(PAGE * 8);
    const step = renderAll(full);
    const before = Array.from(step.container.children);

    counters.rowToText = 0;
    counters.rowRender = 0;
    step.controller.setSelectedPusher("alpha1");

    expect(counters.rowToText).toBe(0);
    expect(counters.rowRender).toBe(0);
    // 節點**身分**逐一相同（toEqual 對 DOM 節點是身分比對）。
    expect(Array.from(step.container.children)).toEqual(before);

    const on = step.container.querySelectorAll(".pusherHighlight");
    expect(on.length).toBeGreaterThan(0);
    on.forEach((el) => expect(el.getAttribute("data-pusher")).toBe("alpha1"));
  });

  test("取消高亮後的 DOM 與從沒切過完全等值（不得殘留 class=\"\"）", () => {
    const full = makeArticle(PAGE * 4);
    const step = renderAll(full);
    const pristine = step.container.innerHTML;
    step.controller.setSelectedPusher("alpha1");
    step.controller.setSelectedPusher(null);
    expect(step.container.innerHTML).toBe(pristine);
  });

  test("經 props 進來的 selectedPusher（新 controller／清空路徑）也要收斂", () => {
    const full = makeArticle(PAGE * 4);
    const step = renderAll(full);
    const before = Array.from(step.container.children);
    counters.rowRender = 0;
    step.update(propsFor(full, { selectedPusher: "alpha1" }));
    // props 這條路同樣不得抽換節點：selectedPusher 已不在 annotationsKey 裡，
    // 增量快取照樣命中，class 由 _render 收尾的對帳補上。
    expect(counters.rowRender).toBe(0);
    expect(Array.from(step.container.children)).toEqual(before);
    const fresh = renderAll(full, { selectedPusher: "alpha1" });
    expect(step.container.innerHTML).toBe(fresh.container.innerHTML);
    expect(step.container.querySelectorAll(".pusherHighlight").length).toBeGreaterThan(0);
  });

  test("stableRows 沒帶（原生 24 列／列表視窗）⇒ 不套快取，逐幀重算", () => {
    // 原生畫面的列是 term_buf 就地改寫的活 buffer：同一個列物件、內容卻變了。
    // 沒有 stableRows 就必須每幀重讀，不然會一直畫出上一幀的內容。
    const rows = [line("作者 poster (暱稱) 看板 Test")];
    const props = (extra) => ({
      lines: rows,
      forceWidth: 16,
      enableLinkInlinePreview: false,
      enableLinkHoverPreview: false,
      enhance: { ...enhance(), stableRows: false, ...extra },
    });
    const step = mountScreen(props());
    // 就地改寫該列的內容（不換物件參考），模擬 pfterm 的 per-cell 重畫。
    "作者 hacker (壞人) 看板 Test".split("").forEach((c, i) => {
      if (rows[0][i]) rows[0][i].ch = c;
    });
    step.update(props({ articleId: 1 }));
    expect(step.container.textContent).toContain("hacker");
  });
});

describe("好讀累積頁增量重算：成本是 O(新增列) 不是 O(文章)", () => {
  const LONG = 1000;

  test("append 一頁後，重新標註與重新 render 的列數都是常數級", () => {
    const full = makeArticle(LONG + PAGE);
    const step = renderAll(full.slice(0, LONG));

    counters.rowToText = 0;
    counters.rowRender = 0;
    step.update(propsFor(full.slice(0, LONG + PAGE)));

    // 上限抓得寬鬆（新增 22 列 + 合併塊對合併 chars 的重跑 + 邊界 run 重算），
    // 但遠低於「整篇重算」的 1022。舊 code 會是 1000+。
    expect(counters.rowToText).toBeLessThan(80);
    expect(counters.rowRender).toBeLessThan(80);
  });

  test("同一份 lines 再 render 一次（強制重繪）⇒ 幾乎零工作", () => {
    const full = makeArticle(LONG);
    const step = renderAll(full);
    counters.rowToText = 0;
    counters.rowRender = 0;
    step.update(propsFor(full));
    expect(counters.rowToText).toBe(0);
    expect(counters.rowRender).toBe(0);
  });
});
