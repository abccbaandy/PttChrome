// 反向讀取（End）的 renderer：新頁插在接合點 J（head 與 tail 之間），不是 append。
//
// 守護四件事：
//   1. 等價 —— 逐頁插入之後的 DOM ＝ 同一份 lines 一次 render 到位的 DOM；接合後
//      （reverseJunction 拿掉）＝ 從頭讀完的 DOM。
//   2. 增量 —— 插入一頁只重算／重建常數級的列（不然每頁 O(文章)，整篇 O(n²)，
//      正是 docs/easy-reading.md「累積頁的每頁 render 成本」那條 1196ms/頁 的曲線）。
//   3. 節點沿用 —— tail 的列節點是同一個物件（圖片佔位盒、捲動錨點都靠它），而且
//      srow／data-row 已改成新 index（選取反查、_scrollToPageRow 的外部契約）。
//   4. tail 不編樓層、跨列合併在 J 斷開、接合點有標記。
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

const COLOR = { fg: 7, bg: 0, blink: false, equals(o) { return o === this; } };
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
function commentRow(type, uid, text, time) {
  const head = " " + uid + ": " + text;
  const pad = Math.max(1, COLS - 2 - head.length - time.length);
  const rest = head + " ".repeat(pad) + time;
  return [cell(type, true), cell("")].concat(rest.split("").map((c) => cell(c)));
}
// 同作者連續 3 則 → 換人 → …：讓 run 跨過任何切點。
const AUTHORS = ["alpha1", "alpha1", "alpha1", "poster", "badguy", "gamma3", "gamma3"];
function makeArticle(count) {
  const rows = [
    line("作者 poster (暱稱) 看板 Test"),
    line("標題 [測試] 反向讀取"),
    line("時間 Sat Aug  9 22:00:00 2026"),
    line(""),
    line("  內文，含一張圖："),
    line("  https://i.imgur.com/abcdefg.jpg"),
    line(""),
    line("--"),
    line("※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 1.2.3.4"),
  ];
  for (let i = 0; rows.length < count; ++i) {
    const uid = AUTHORS[i % AUTHORS.length];
    const mm = String((i % 59) + 1).padStart(2, "0");
    rows.push(commentRow("推", uid, "留言 " + i, "08/09 22:" + mm));
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
  stableRows: true,
});
const propsFor = (lines, extra) => ({
  lines,
  forceWidth: 16,
  enableLinkInlinePreview: false,
  enableLinkHoverPreview: false,
  enhance: { ...enhance(), ...extra },
});

const PAGE = 22;

// 反向讀取的累積形狀：head ＝ full[0, J)，tail 從 tailStart 起到文末；每一步把 tail
// 往上長一頁。列物件參考全部來自 full（等同 term_view 的 cloneRow 快照只 clone 一次）。
function reverseSteps(full, J, tailStart) {
  const steps = [];
  for (let t = tailStart; ; t = Math.max(J, t - PAGE)) {
    steps.push(full.slice(0, J).concat(full.slice(t)));
    if (t === J) break;
  }
  return steps;
}

describe("反向讀取：逐頁插入與一次到位等價", () => {
  test("插入過程中每一步的 DOM ＝ 同一份 lines 一次 render（帶同一個接合點）", () => {
    const full = makeArticle(PAGE * 12);
    const J = PAGE * 2 + 5;
    const steps = reverseSteps(full, J, full.length - PAGE);
    const step = mountScreen(propsFor(steps[0], { reverseJunction: J }));
    for (let i = 1; i < steps.length; ++i) {
      step.update(propsFor(steps[i], { reverseJunction: J }));
      const fresh = mountScreen(propsFor(steps[i], { reverseJunction: J }));
      expect(step.container.innerHTML).toBe(fresh.container.innerHTML);
      fresh.destroy();
    }
  });

  test("接合後（拿掉 reverseJunction）＝ 從頭讀完的 DOM，樓層補齊", () => {
    const full = makeArticle(PAGE * 12);
    const J = PAGE * 2 + 5;
    const steps = reverseSteps(full, J, full.length - PAGE);
    const step = mountScreen(propsFor(steps[0], { reverseJunction: J }));
    for (let i = 1; i < steps.length; ++i)
      step.update(propsFor(steps[i], { reverseJunction: J }));
    step.update(propsFor(full));
    const fresh = mountScreen(propsFor(full));
    expect(step.container.innerHTML).toBe(fresh.container.innerHTML);
  });
});

describe("反向讀取：tail 的呈現", () => {
  const floorRows = (container) =>
    Array.from(container.querySelectorAll(".floorBadgeNum")).map((n) =>
      Number(n.closest('[type="bbsrow"]').getAttribute("srow")),
    );

  test("tail 不編樓層；head 照常編", () => {
    const full = makeArticle(PAGE * 8);
    const J = PAGE * 2;
    const lines = full.slice(0, J).concat(full.slice(PAGE * 5));
    const s = mountScreen(propsFor(lines, { reverseJunction: J }));
    const rows = floorRows(s.container);
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((r) => expect(r).toBeLessThan(J));
  });

  test("接合點標記：恰好一個，就在 tail 的第一列；接合後消失", () => {
    const full = makeArticle(PAGE * 8);
    const J = PAGE * 2;
    const lines = full.slice(0, J).concat(full.slice(PAGE * 5));
    const s = mountScreen(propsFor(lines, { reverseJunction: J }));
    const marks = s.container.querySelectorAll(".reverseJunction");
    expect(marks.length).toBe(1);
    const srow = marks[0].getAttribute("srow") ||
      marks[0].querySelector("[srow]").getAttribute("srow");
    expect(Number(srow)).toBe(J);
    // 插入一頁：標記跟著 J（新插入的第一列），舊的那一列不再帶
    const more = full.slice(0, J).concat(full.slice(PAGE * 4));
    s.update(propsFor(more, { reverseJunction: J }));
    expect(s.container.querySelectorAll(".reverseJunction").length).toBe(1);
    s.update(propsFor(full));
    expect(s.container.querySelectorAll(".reverseJunction").length).toBe(0);
  });

  test("同作者推文不得跨接合點合併（head 末則與 tail 首則在文章裡並不相鄰）", () => {
    const full = makeArticle(PAGE * 8);
    // 找一個 J：J-1 與 tail 的第一列是同一位作者（alpha1 連三則的中間）
    const tailStart = PAGE * 5;
    let J = PAGE * 2;
    const uidAt = (r) => {
      const t = r.map((c) => c.ch).join("");
      const m = /^\S*\s+([a-z0-9]+):/.exec(t.slice(2));
      return m ? m[1] : null;
    };
    while (uidAt(full[J - 1]) !== uidAt(full[tailStart])) ++J;
    const lines = full.slice(0, J).concat(full.slice(tailStart));
    const s = mountScreen(propsFor(lines, { reverseJunction: J }));
    // row J 有自己的頂層節點（沒有被併進從 J-1 開始的合併塊）
    expect(s.container.querySelector(`[type="bbsrow"][srow="${J}"]`)).not.toBeNull();
  });
});

describe("反向讀取：成本與節點沿用", () => {
  const LONG = 1000;

  test("在接合點插入一頁：重新標註／重建的列數是常數級", () => {
    const full = makeArticle(PAGE * 3 + LONG + PAGE);
    const J = PAGE * 3;
    const before = full.slice(0, J).concat(full.slice(J + PAGE));
    const s = mountScreen(propsFor(before, { reverseJunction: J }));
    counters.rowToText = 0;
    counters.rowRender = 0;
    s.update(propsFor(full, { reverseJunction: J }));
    expect(counters.rowToText).toBeLessThan(80);
    expect(counters.rowRender).toBeLessThan(80);
  });

  test("tail 的列節點沿用同一個物件，srow／data-row 位移到新 index", () => {
    const full = makeArticle(PAGE * 10);
    const J = PAGE * 2;
    const before = full.slice(0, J).concat(full.slice(PAGE * 5));
    const s = mountScreen(propsFor(before, { reverseJunction: J }));
    // 頂層節點（一列或一個合併塊）→ 它帶的第一個 srow
    const firstSrow = (n) =>
      Number(
        n.getAttribute("srow") ?? n.querySelector("[srow]").getAttribute("srow"),
      );
    const tops = () =>
      Array.from(s.container.children).filter(
        (n) => n.getAttribute("srow") != null || n.querySelector("[srow]"),
      );
    const tailBefore = tops().filter((n) => firstSrow(n) >= J);
    const beforeIdx = tailBefore.map(firstSrow);
    const after = full.slice(0, J).concat(full.slice(PAGE * 4));
    s.update(propsFor(after, { reverseJunction: J }));
    const shift = after.length - before.length;
    const nowTops = tops();
    // 除了 J 那一列（接合點標記換手，必然重建），其餘 tail 節點都是同一個物件
    tailBefore.forEach((node, i) => {
      if (beforeIdx[i] === J) return;
      expect(nowTops).toContain(node);
      expect(firstSrow(node)).toBe(beforeIdx[i] + shift);
      node.querySelectorAll("[data-row]").forEach((e) =>
        expect(Number(e.getAttribute("data-row"))).toBe(beforeIdx[i] + shift),
      );
    });
    // 位移後與全新 render 逐字相同
    const fresh = mountScreen(propsFor(after, { reverseJunction: J }));
    expect(s.container.innerHTML).toBe(fresh.container.innerHTML);
  });

  // REGRESSION（offline e2e 實錄：插入一頁 ⇒ #mainContainer 上近千筆 childList 變動）：
  // _patchInto 把換掉的舊節點（接合點那一列）留在 cursor 上，之後沿用的 tail 節點
  // 全被 insertBefore 到它前面＝整段搬家。搬動含捲動錨點的節點會讓瀏覽器丟掉錨點，
  // scroll anchoring 不補償 ⇒ 讀者被往上插入的內容一路推走。
  test("插入一頁不得搬動任何沿用的節點（只插新的、只拿掉換掉的）", async () => {
    const full = makeArticle(PAGE * 10);
    const J = PAGE * 2;
    const before = full.slice(0, J).concat(full.slice(PAGE * 5));
    const s = mountScreen(propsFor(before, { reverseJunction: J }));
    const oldTops = new Set(Array.from(s.container.children));
    const removed = [];
    const mo = new MutationObserver((list) => {
      for (const m of list) m.removedNodes.forEach((n) => removed.push(n));
    });
    mo.observe(s.container, { childList: true });
    s.update(propsFor(full.slice(0, J).concat(full.slice(PAGE * 4)), { reverseJunction: J }));
    await Promise.resolve();
    mo.disconnect();
    const now = new Set(Array.from(s.container.children));
    // 被移除過的節點裡，不得有任何一個「更新後仍在畫面上」的（＝被搬家）
    const moved = removed.filter((n) => now.has(n));
    expect(moved.length).toBe(0);
    // 真正拿掉的只有換手的那幾個（接合點標記那一列等），不是整段 tail
    expect(removed.filter((n) => oldTops.has(n)).length).toBeLessThan(5);
  });

  test("插入點早於接合點（不是反向形狀）⇒ 不沿用快取，全量重算且結果正確", () => {
    const full = makeArticle(PAGE * 6);
    const J = PAGE * 3;
    const missing = full.slice(0, PAGE).concat(full.slice(PAGE * 2));
    const s = mountScreen(propsFor(missing, { reverseJunction: J }));
    s.update(propsFor(full, { reverseJunction: J }));
    const fresh = mountScreen(propsFor(full, { reverseJunction: J }));
    expect(s.container.innerHTML).toBe(fresh.container.innerHTML);
  });
});
