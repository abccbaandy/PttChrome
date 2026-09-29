// 手機 Phase 4：列表卡片（render/list_card.js、docs/mobile.md「Phase 4」）。
// 鎖三件事：欄位切在哪（出處 bbs.c#readdoent／board.c#brdlist_renderer）、外部契約
// （srow／data-row／data-list-*）、以及只在 enhance.listCards 時才取代 buildRow。
import { buildListCard, cardSegment, CARD_LAYOUT } from "../../src/render/list_card";
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { row, seg, listRow } from "./helpers/screen_fixtures";
import { listRowSpan, listPageRows, LIST_CARD_ROWS } from "../../src/js/mobile_layout";
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

  test("空白列（短板補到 bodyRows）仍是一張卡片（固定高才對得上捲動數學）", () => {
    const { node } = buildListCard({ chars: row(seg("")), row: 9, kind: "article", forceWidth: 16 });
    expect(node.classList.contains("listCard")).toBe(true);
    expect(node.querySelectorAll(".listCardLine").length).toBe(LIST_CARD_ROWS);
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

  test("卡片模式：body 列變卡片，header／footer 照舊", () => {
    const m = mountScreen(props("article"));
    const view = m.container.querySelector(".listBodyView");
    const cards = view.querySelectorAll(":scope > .listCard");
    expect(cards.length).toBe(2);
    expect(cards[0].getAttribute("srow")).toBe("3");
    expect(text(cards[1].querySelector(".listCardAuthor")).trim()).toBe("bob");
    expect(m.container.querySelectorAll(":scope > .listCard").length).toBe(0);
  });

  test("桌機（沒有 listCards）：一張卡片都沒有", () => {
    const m = mountScreen(props(undefined));
    expect(m.container.querySelectorAll(".listCard").length).toBe(0);
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
  test("卡片模式一筆佔 LIST_CARD_ROWS 列；PgDn 翻一屏放得下的筆數", () => {
    expect(listRowSpan(false)).toBe(1);
    expect(listRowSpan(true)).toBe(LIST_CARD_ROWS);
    expect(listPageRows(20, false)).toBe(20);
    expect(listPageRows(20, true)).toBe(10);
    expect(listPageRows(21, true)).toBe(10);
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
  });

  test("_rowHeight：卡片＝LIST_CARD_ROWS × chh，一般＝chh", () => {
    expect(Session.prototype._rowHeight.call(fake(false))).toBe(15);
    expect(Session.prototype._rowHeight.call(fake(true))).toBe(15 * LIST_CARD_ROWS);
  });

  test("_pageRows：卡片一次翻 bodyRows/2 筆；_bodyRows（抓頁單位）不變", () => {
    expect(Session.prototype._pageRows.call(fake(false))).toBe(20);
    expect(Session.prototype._pageRows.call(fake(true))).toBe(10);
    expect(Session.prototype._bodyRows.call(fake(true))).toBe(20);
  });
});
