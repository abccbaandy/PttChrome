// @unit-env browser
// 手機推文卡片（render/comment_card.js、docs/mobile.md「推文卡片」）。
// 症狀：換行版面下推文列照 80 欄原樣 pre-wrap，時間戳前的補位空白先折行 ⇒ 時間
// 被擠到下一行最左邊。卡片兩段：標頭一行「推 id 樓號 …… IP 時間」＋內容滿寬另起一行
// （作者與內容分開，合併推文一個標頭、多則內容）。
// 鎖：時間／IP 不在內容裡、合併塊只留最後一則的時間、外部契約保留、只在
// enhance.commentCards 時才取代 buildRow（桌機 golden 不受影響）。
import {
  buildCommentCard,
  commentCardRegions,
} from "../../src/render/comment_card";
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { row, seg, color, SCENARIOS } from "./helpers/screen_fixtures";

afterEach(() => unmountAll());

const text = (node) => (node ? node.textContent : "");
const easy = SCENARIOS.find((s) => s.name === "article_easy_reading");
const props = (commentCards) => ({
  ...easy,
  enhance: { ...easy.enhance, commentCards },
});

describe("buildCommentCard（單一推文列）", () => {
  const chars = row(
    seg("推 someone: 這是一則推文內容", color(2, 0)),
    seg("            1.2.3.4 06/14 12:05"),
  );

  test("標頭一行：標記・id・樓號・IP・時間；內容另起一段、不含 id／IP／時間", () => {
    const { node } = buildCommentCard({
      chars,
      regions: commentCardRegions(chars),
      row: 9,
      forceWidth: 20,
      pusher: "someone",
      pusherContentCol: 12,
      floor: { seq: 7, sub: 3, type: "推" },
    });
    const head = node.querySelector(".commentCardHead");
    expect(text(head.querySelector(".commentCardTag"))).toBe("推");
    expect(text(head.querySelector(".commentCardId"))).toBe("someone");
    expect(text(head.querySelector(".floorBadge[data-floor]"))).toBe("7");
    // IP／時間在標頭那一行（CSS 靠右），不在內容後面。
    const meta = head.querySelector(":scope > .commentCardMeta");
    expect(text(meta.querySelector(".commentCardIp"))).toBe("1.2.3.4");
    expect(text(meta.querySelector(".commentCardTime"))).toBe("06/14 12:05");
    expect(
      Array.from(head.children).map((c) => c.className.split(" ")[0]),
    ).toEqual(["commentCardTag", "commentCardId", "floorBadge", "commentCardMeta"]);
    // 卡片只有兩段：標頭 → 內容。標頭與內容分行 ⇒ 不畫冒號。
    expect(
      Array.from(node.children).map((c) => c.className.split(" ")[0]),
    ).toEqual(["commentCardHead", "commentCardText"]);
    expect(head.querySelector(".commentCardSep")).toBe(null);
    const body = text(node.querySelector(".commentCardText"));
    expect(body).toContain("這是一則推文內容");
    expect(body).not.toContain("06/14");
    expect(body).not.toContain("1.2.3.4");
    expect(body).not.toContain("someone");
  });

  test("外部契約：bbsrow/srow、data-pusher(-col)、每一行都有 bbsline/data-row", () => {
    const { node } = buildCommentCard({
      chars,
      regions: commentCardRegions(chars),
      row: 9,
      forceWidth: 20,
      pusher: "someone",
      pusherContentCol: 12,
      pusherHighlight: true,
    });
    expect(node.getAttribute("type")).toBe("bbsrow");
    expect(node.getAttribute("srow")).toBe("9");
    expect(node.getAttribute("data-pusher")).toBe("someone");
    expect(node.getAttribute("data-pusher-col")).toBe("12");
    expect(node.classList.contains("pusherHighlight")).toBe(true);
    const lines = node.querySelectorAll('[data-type="bbsline"]');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) expect(l.getAttribute("data-row")).toBe("9");
  });

  test("認不出推文形狀（沒有時間戳）⇒ 沒有區段，caller 退回一般列", () => {
    expect(commentCardRegions(row(seg("推 someone: 沒有時間")))).toBe(null);
  });
});

describe("ScreenController：只在 enhance.commentCards 時畫卡片", () => {
  test("卡片模式：合併塊一張、單則一張；黑名單列照舊移除", () => {
    const m = mountScreen(props(true));
    // 頂層節點（累積長頁的列住在分塊 .screenChunk 裡，見 render/screen_chunk.js）。
    const cards = m.container.querySelectorAll(
      ":scope > .screenChunk > .commentCard",
    );
    expect(cards.length).toBe(2);
    expect(m.container.querySelectorAll(".mergedCommentBlock").length).toBe(0);

    const [merged, single] = cards;
    expect(merged.getAttribute("data-pusher")).toBe("gooduser");
    const mergedBody = text(merged.querySelector(".commentCardText"));
    expect(mergedBody).toContain("第一則");
    expect(mergedBody).toContain("同一人第二則");
    expect(mergedBody).not.toContain("06/14");
    // 合併塊只留最後一則的時間（同桌機合併塊的規則）。
    expect(text(merged.querySelector(".commentCardTime"))).toBe("06/14 12:02");
    expect(text(merged.querySelector(".floorBadge[data-floor]"))).toBe("1");

    expect(single.getAttribute("data-pusher")).toBe("other");
    expect(text(single.querySelector(".commentCardTag"))).toBe("噓");
    expect(text(single.querySelector(".commentCardTime"))).toBe("06/14 12:04");
    expect(m.container.textContent).not.toContain("黑名單這則");
  });

  test("桌機（沒有 commentCards）：一張卡片都沒有", () => {
    const m = mountScreen(props(undefined));
    expect(m.container.querySelectorAll(".commentCard").length).toBe(0);
  });

  test("同一批列物件切換 ⇒ 節點重建（commentCards 進 annotationsKey）", () => {
    const m = mountScreen(props(undefined));
    m.update(props(true));
    expect(m.container.querySelectorAll(".commentCard").length).toBe(2);
    m.update(props(undefined));
    expect(m.container.querySelectorAll(".commentCard").length).toBe(0);
    expect(m.container.querySelectorAll(".mergedCommentBlock").length).toBe(1);
  });
});
