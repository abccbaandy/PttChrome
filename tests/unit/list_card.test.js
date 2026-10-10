// @unit-env browser
// 手機 Phase 4：列表卡片（render/list_card.js、docs/mobile.md「Phase 4」）。
// 鎖三件事：欄位切在哪（出處 bbs.c#readdoent／board.c#brdlist_renderer）、外部契約
// （srow／data-row／data-list-*）、以及只在 enhance.listCards 時才取代 buildRow。
import { buildListCard, cardSegment, CARD_LAYOUT } from "../../src/render/list_card";
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { row, seg, listRow } from "./helpers/screen_fixtures";
import {
  listRowSpan,
  listPageRows,
  isListCardBodyTarget,
  listViewportGeometry,
  listFillRows,
  LIST_CARD_ROWS,
  LIST_CARD_LINES,
} from "../../src/js/mobile_layout";
import { ListSession } from "../../src/js/list_session";
import { BoardListSession } from "../../src/js/board_list_session";

afterEach(() => unmountAll());

const text = (node) => (node ? node.textContent : "");

describe("buildListCard：文章列表", () => {
  const chars = listRow("someone", "□ [心得] 手機卡片測試");

  test("第一行標題、第二行序號・日期＋作者", () => {
    const { node } = buildListCard({ chars, row: 5, kind: "article", forceWidth: 16 });
    expect(text(node.querySelector(".listCardTitle"))).toContain("[心得] 手機卡片測試");
    expect(text(node.querySelector(".listCardTitle"))).not.toContain("someone");
    expect(text(node.querySelector(".listCardAuthor")).trim()).toBe("someone");
    expect(text(node.querySelector(".listCardInfo"))).toContain("350024");
    expect(text(node.querySelector(".listCardInfo"))).toContain("6/14");
  });

  test("外部契約：bbsrow/srow、data-list-*、data-row（游標底色靠它）", () => {
    const { node } = buildListCard({
      chars,
      row: 7,
      kind: "article",
      forceWidth: 16,
      listAuthor: "someone",
      listTitle: "[心得] 手機卡片測試",
      highlightClass: "b4",
    });
    expect(node.getAttribute("type")).toBe("bbsrow");
    expect(node.getAttribute("srow")).toBe("7");
    expect(node.getAttribute("data-list-author")).toBe("someone");
    expect(node.getAttribute("data-list-title")).toBe("[心得] 手機卡片測試");
    const body = node.querySelector(".listCardBody");
    expect(body.getAttribute("data-type")).toBe("bbsline");
    expect(body.getAttribute("data-row")).toBe("7");
    // 游標底色下在卡片本體 ⇒ 整張卡片上色
    expect(body.classList.contains("b4")).toBe(true);
  });

  test("已讀列帶 data-list-read（低亮由容器 class 決定），未讀列不帶", () => {
    const read = buildListCard({ chars, row: 1, kind: "article", forceWidth: 16, listRead: true }).node;
    const unread = buildListCard({ chars, row: 2, kind: "article", forceWidth: 16 }).node;
    expect(read.hasAttribute("data-list-read")).toBe(true);
    expect(unread.hasAttribute("data-list-read")).toBe(false);
  });

  test("空白列（短板補到 bodyRows）仍是一張卡片（固定高才對得上捲動數學）", () => {
    const { node } = buildListCard({ chars: row(seg("")), row: 9, kind: "article", forceWidth: 16 });
    expect(node.classList.contains("listCard")).toBe(true);
    expect(node.querySelectorAll(".listCardLine").length).toBe(LIST_CARD_LINES);
    expect(text(node).trim()).toBe("");
  });
});

describe("buildListCard：看板列表（board.c#brdlist_renderer 欄位）", () => {
  // %7d 序號 [0,7)、隱板字 [7]、未讀 [8,10)、板名 [10,23)、類別 [23,28)、◎ [28,30)、
  // 敘述 [30,64)、人氣 [64,67)、板主 [67,80)
  const brd = row(
    seg("     12  "),
    seg(" "),
    seg("Gossiping    "),
    seg("綜合 "),
    seg("◎"),
    seg("[八卦]沒有開放政問" + " ".repeat(16)), // 18 + 16 ＝ %-34.34s
    seg("爆!"),
    seg("mod1/mod2"),
  );

  test("第一行板名・類別＋人氣；第二行敘述＋板主", () => {
    const { node } = buildListCard({ chars: brd, row: 3, kind: "board", forceWidth: 16 });
    const title = text(node.querySelector(".listCardTitle"));
    const meta = text(node.querySelector(".listCardMeta"));
    expect(title).toContain("Gossiping");
    expect(title).toContain("綜合");
    expect(text(node.querySelector(".listCardPopularity"))).toBe("爆!");
    expect(meta).toContain("[八卦]沒有開放政問");
    expect(text(node.querySelector(".listCardBM"))).toBe("mod1/mod2");
  });

  // 回歸：游標列 cell 0 的 `>`（labelListCursor）不是空白剪不掉，連同 %7d 補白留在
  // 序號前 ⇒ 游標那張卡片整行右移（「>   102   SYSOP」對上「101   Shadowverse」）。
  test("游標列：記號進固定寬游標欄，序號欄與非游標列同形", () => {
    const cur = row(
      seg(">   102  "),
      seg(" "),
      seg("SYSOP        "),
      seg("本站 "),
      seg("◎"),
      seg("被盜帳號發廣告" + " ".repeat(20)),
      seg("  2"),
      seg("站長"),
    );
    const other = row(
      seg("    101  "),
      seg(" "),
      seg("Shadowverse  "),
      seg("線上 "),
      seg("◎"),
      seg("[闇影詩章]" + " ".repeat(24)),
      seg("   "),
      seg("wen17"),
    );
    const a = buildListCard({ chars: cur, row: 3, kind: "board", forceWidth: 16 }).node;
    const b = buildListCard({ chars: other, row: 4, kind: "board", forceWidth: 16 }).node;
    expect(text(a.querySelector(".listCardInfo")).startsWith("102")).toBe(true);
    expect(text(b.querySelector(".listCardInfo")).startsWith("101")).toBe(true);
    expect(text(a.querySelector(".listCardCursor"))).toBe(">");
    expect(text(b.querySelector(".listCardCursor"))).toBe(" ");
    // 游標欄是標題行的第一個子節點，兩張卡片的欄位起點一致
    expect(a.querySelector(".listCardTitle").firstChild.className).toBe("listCardCursor");
    expect(b.querySelector(".listCardTitle").firstChild.className).toBe("listCardCursor");
  });

  test("文章列表游標列同理：記號不進序號欄", () => {
    const chars = listRow("someone", "□ 測試");
    chars[0].ch = ">";
    const { node } = buildListCard({ chars, row: 5, kind: "article", forceWidth: 16 });
    expect(text(node.querySelector(".listCardInfo")).startsWith("350024")).toBe(true);
    expect(text(node.querySelector(".listCardCursor"))).toBe(">");
  });

  test("版型表的 cell 範圍前後相接、不重疊", () => {
    for (const kind of Object.keys(CARD_LAYOUT)) {
      const spans = [...CARD_LAYOUT[kind].title, ...CARD_LAYOUT[kind].meta]
        .map(([a, b]) => [a, b])
        .sort((x, y) => x[0] - y[0]);
      for (let i = 1; i < spans.length; ++i)
        expect(spans[i][0]).toBeGreaterThanOrEqual(spans[i - 1][1]);
    }
  });
});

describe("cardSegment：邊界落在全形字中間時擴成完整的字", () => {
  test("起點是全形字的第二格 ⇒ 往前含進 lead byte", () => {
    const chars = row(seg("ab"), seg("中文"));
    // 「中」佔 [2,4)，從 3 開始切
    expect(text(cardSegment(chars, 3, 6, 16, 0))).toBe("中文");
  });

  test("行尾空白剪掉；全空白回 null", () => {
    expect(text(cardSegment(row(seg("abc")), 0, 20, 16, 0))).toBe("abc");
    expect(cardSegment(row(seg("")), 0, 20, 16, 0)).toBe(null);
  });
});

describe("ScreenController：只在 enhance.listCards 時畫卡片", () => {
  const LINES = [
    row(seg("看板《Test》")),
    row(seg("  編號     日 期  作 者        文  章  標  題")),
    row(seg("")),
    listRow("alice", "□ 第一篇"),
    listRow("bob", "□ 第二篇"),
    row(seg(" 文章選讀  (y)回應(X)推文")),
  ];
  const props = (listCards) => ({
    lines: LINES,
    enableLinkInlinePreview: false,
    enableLinkHoverPreview: false,
    enhance: {
      pageState: 2,
      listEasyReading: true,
      easyReading: true,
      listCards,
      listScroll: { bodyStart: 3, viewportPx: 320, scrollable: true },
    },
  });

  test("卡片模式：body 列變卡片，header／footer 不在視口裡", () => {
    const m = mountScreen(props("article"));
    const view = m.container.querySelector(".listBodyView");
    const cards = view.querySelectorAll(":scope > .listCard");
    expect(cards.length).toBe(2);
    expect(cards[0].getAttribute("srow")).toBe("3");
    expect(text(cards[1].querySelector(".listCardAuthor")).trim()).toBe("bob");
    expect(m.container.querySelectorAll(":scope > .listCard").length).toBe(0);
  });

  // 看板名在 App Bar、動作在底部導覽（docs/mobile.md「收起終端機標頭／狀態列」）。
  test("卡片模式：header 三列與 footer 收起，DOM 契約（srow／data-row）保留", () => {
    const m = mountScreen(props("article"));
    for (const r of [0, 1, 2, 5]) {
      const n = m.container.querySelector(`:scope > [type="bbsrow"][srow="${r}"]`);
      expect(n.classList.contains("mobileCollapsedRow")).toBe(true);
      expect(n.querySelector(`[data-type="bbsline"][data-row="${r}"]`)).not.toBe(null);
      expect(n.textContent).toBe("");
    }
  });

  test("桌機（沒有 listCards）：一張卡片都沒有、header／footer 照畫", () => {
    const m = mountScreen(props(undefined));
    expect(m.container.querySelectorAll(".listCard").length).toBe(0);
    expect(m.container.querySelectorAll(".mobileCollapsedRow").length).toBe(0);
    expect(m.container.textContent).toContain("看板《Test》");
  });

  test("同一批列物件切換卡片模式 ⇒ 節點重建（listCards 進 annotationsKey）", () => {
    const m = mountScreen(props(undefined));
    m.update(props("article"));
    expect(m.container.querySelectorAll(".listBodyView > .listCard").length).toBe(2);
    m.update(props(undefined));
    expect(m.container.querySelectorAll(".listCard").length).toBe(0);
  });
});

describe("列表 session 的卡片換算（mobile_layout）", () => {
  test("卡片模式一筆佔 LIST_CARD_ROWS 列（兩行＋0.5 列間距）；PgDn 翻一屏放得下的筆數", () => {
    expect(LIST_CARD_ROWS).toBe(2.5);
    expect(listRowSpan(false)).toBe(1);
    expect(listRowSpan(true)).toBe(LIST_CARD_ROWS);
    expect(listPageRows(20, false)).toBe(20);
    expect(listPageRows(20, true)).toBe(8);
    expect(listPageRows(21, true)).toBe(8);
    expect(listPageRows(1, true)).toBe(1);
  });

});

// 兩個列表 session 的捲動數學只靠 _rowHeight（每筆等高）與 _pageRows（PgUp/PgDn）。
// 看板列表沒有錄製素材可跑 e2e，這裡是它唯一的卡片換算守護。
describe.each([
  ["ListSession", ListSession],
  ["BoardListSession", BoardListSession],
])("%s 的卡片換算", (_, Session) => {
  const fake = (listCards) => ({
    _view: { chh: 15, listCards },
    _termBuf: { rows: 24 },
    _bodyRows: Session.prototype._bodyRows,
    headerRows: Session.prototype.headerRows,
  });

  test("_rowHeight：卡片＝LIST_CARD_ROWS × chh，一般＝chh", () => {
    expect(Session.prototype._rowHeight.call(fake(false))).toBe(15);
    expect(Session.prototype._rowHeight.call(fake(true))).toBe(15 * LIST_CARD_ROWS);
  });

  // 卡片模式 header／footer 收起，視口吃下整個 24 列（listViewportGeometry）。
  test("_pageRows：卡片一次翻 floor(rows/LIST_CARD_ROWS) 筆；_bodyRows（抓頁單位）不變", () => {
    expect(Session.prototype._pageRows.call(fake(false))).toBe(20);
    expect(Session.prototype._pageRows.call(fake(true))).toBe(9);
    expect(Session.prototype._bodyRows.call(fake(true))).toBe(20);
  });

  // 實錄 ptt-debug-20261011-000540.json（47 列、chh≈15.62、我的最愛 27 個看板）：短清單
  // 補白照桌機補到 bodyRows（43 筆）⇒ 卡片 43×39≈1677px ≫ 視口 734px ⇒ 清單下面一大塊
  // 空白也捲得到（scrollHeight 1679、maxScrollTop 945）。卡片只補到一個視口放得下的筆數。
  test("_maxScrollTop：短清單卡片不因補白多出可捲距離", () => {
    const chh = 734 / 47;
    const cardH = chh * LIST_CARD_ROWS;
    const s = {
      ...fake(true),
      _view: { chh, listCards: true },
      _termBuf: { rows: 47 },
      _rowHeight: Session.prototype._rowHeight,
      _pageRows: Session.prototype._pageRows,
      _sequence: () => new Array(27).fill(0),
      _sequenceLength: () => 27,
      _screen: () => ({ getListViewportPx: () => 734 }),
    };
    expect(Session.prototype._maxScrollTop.call(s)).toBeCloseTo(27 * cardH - 734, 3);
    s._sequence = () => new Array(5).fill(0);
    s._sequenceLength = () => 5;
    expect(Session.prototype._maxScrollTop.call(s)).toBe(0);
  });
});

describe("listFillRows（短清單補白筆數，term_view 補列與 session 捲動數學同源）", () => {
  test("格線：bodyRows（rows-4）；卡片：一個視口放得下的筆數", () => {
    expect(listFillRows({ rows: 24, headerRows: 3, cards: false })).toBe(20);
    expect(listFillRows({ rows: 47, headerRows: 3, cards: false })).toBe(43);
    expect(listFillRows({ rows: 47, headerRows: 3, cards: true })).toBe(18);
    expect(listFillRows({ rows: 47, headerRows: 3, cards: true }) * LIST_CARD_ROWS).toBeLessThanOrEqual(47);
  });
});

describe("listViewportGeometry（term_view／clientToPos／_pageRows 同源）", () => {
  test("格線：header 下面 rows-4 列；卡片：從頂端起整個高", () => {
    expect(listViewportGeometry({ rows: 24, headerRows: 3, cards: false })).toEqual({
      bodyTopRows: 3,
      viewportRows: 20,
    });
    expect(listViewportGeometry({ rows: 24, headerRows: 3, cards: true })).toEqual({
      bodyTopRows: 0,
      viewportRows: 24,
    });
  });

  // 防誤點：點到卡片間距（.listCard 的 padding）或視口外的留白不開文，點卡片本體才開。
  test("isListCardBodyTarget：只有卡片本體（視口外的留白、間距都不開文）", () => {
    document.body.innerHTML =
      '<div class="main"><div class="listBodyView"><span class="listCard" id="card">' +
      '<span class="listCardBody"><span class="listCardLine" id="line">x</span></span>' +
      '</span></div><span id="blank">x</span></div>';
    expect(isListCardBodyTarget(document.getElementById("line"))).toBe(true);
    expect(isListCardBodyTarget(document.querySelector(".listCardBody"))).toBe(true);
    expect(isListCardBodyTarget(document.getElementById("card"))).toBe(false);
    expect(isListCardBodyTarget(document.getElementById("blank"))).toBe(false);
    expect(isListCardBodyTarget(document.querySelector(".main"))).toBe(false);
    expect(isListCardBodyTarget(null)).toBe(false);
    document.body.innerHTML = "";
  });
});
