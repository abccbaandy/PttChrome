// @unit-env browser
// 手機好讀文章的檔頭卡片（render/article_meta_card.js、docs/mobile.md「收起終端機標頭／狀態列」）。
// 鎖：pmore 檔頭（mbbsd/pmore.c _fh_disp_heads＋header separator line）的每一列怎麼換、
// 只看該列自己（非檔頭形狀照舊）、外部契約保留、只在 enhance.commentCards 時才取代 buildRow。
import {
  articleMetaKind,
  buildArticleMetaRow,
  ARTICLE_META_MAX_ROWS,
} from "../../src/render/article_meta_card";
import { mountScreen, unmountAll } from "./helpers/mount_screen";
import { row, seg, color, SCENARIOS } from "./helpers/screen_fixtures";

afterEach(() => unmountAll());

const AUTHOR = row(seg(" 作者 ", color(4, 7)), seg(" jason050117 (阿傑)                         看板 ask"));
const AUTHOR_RAW = row(seg("作者: jason050117 (阿傑) 看板: ask"));
const TITLE = row(seg(" 標題 ", color(4, 7)), seg(" Re: [請問] 網頁版PTT 游標 怎麼變回 圓點?"));
const TIME = row(seg(" 時間 ", color(4, 7)), seg(" Wed Aug 12 00:19:48 2026"));
const RULE = row(seg("─".repeat(39), color(6, 0)));
const BODY = row(seg("作者  這行其實是內文，不在第 0 列"));

describe("articleMetaKind（只看列號＋該列文字）", () => {
  test("檔頭四種", () => {
    expect(articleMetaKind(AUTHOR, 0)).toBe("author");
    expect(articleMetaKind(AUTHOR_RAW, 0)).toBe("author");
    expect(articleMetaKind(TITLE, 1)).toBe("title");
    expect(articleMetaKind(TIME, 2)).toBe("time");
    expect(articleMetaKind(RULE, 3)).toBe("rule");
  });

  test("作者只認第 0 列；超出檔頭範圍一律不是", () => {
    expect(articleMetaKind(BODY, 2)).toBe(null);
    expect(articleMetaKind(TITLE, ARTICLE_META_MAX_ROWS)).toBe(null);
    expect(articleMetaKind(RULE, 9)).toBe(null);
    expect(articleMetaKind(row(seg("一般內文")), 1)).toBe(null);
  });
});

describe("buildArticleMetaRow", () => {
  const contract = (node, r) => {
    expect(node.getAttribute("type")).toBe("bbsrow");
    expect(node.getAttribute("srow")).toBe(String(r));
    expect(node.querySelector(`[data-type="bbsline"][data-row="${r}"]`)).not.toBe(null);
  };

  test("作者：id（暱稱），看板欄拿掉（已在 App Bar）", () => {
    const n = buildArticleMetaRow(AUTHOR, 0);
    contract(n, 0);
    expect(n.querySelector(".articleMetaValue").textContent).toBe("jason050117 (阿傑)");
    expect(n.textContent).not.toContain("ask");
    expect(buildArticleMetaRow(AUTHOR_RAW, 0).querySelector(".articleMetaValue").textContent).toBe(
      "jason050117 (阿傑)",
    );
  });

  test("標題：完整標題；時間：淡色小字", () => {
    const t = buildArticleMetaRow(TITLE, 1);
    contract(t, 1);
    expect(t.classList.contains("articleMeta--title")).toBe(true);
    expect(t.textContent).toBe("Re: [請問] 網頁版PTT 游標 怎麼變回 圓點?");
    const tm = buildArticleMetaRow(TIME, 2);
    expect(tm.classList.contains("articleMeta--time")).toBe(true);
    expect(tm.querySelector(".articleMetaValue").textContent).toBe("Wed Aug 12 00:19:48 2026");
  });

  test("分隔線收起（契約保留）", () => {
    const n = buildArticleMetaRow(RULE, 3);
    contract(n, 3);
    expect(n.classList.contains("mobileCollapsedRow")).toBe(true);
  });

  test("不是檔頭 ⇒ null（呼叫端照舊 buildRow）", () => {
    expect(buildArticleMetaRow(BODY, 2)).toBe(null);
  });
});

describe("ScreenController：只在 enhance.commentCards 時換檔頭", () => {
  const easy = SCENARIOS.find((s) => s.name === "article_easy_reading");
  const props = (commentCards) => ({ ...easy, enhance: { ...easy.enhance, commentCards } });
  const node = (m, r) => m.container.querySelector(`[type="bbsrow"][srow="${r}"]`);

  test("手機換行版面：第 0、1 列變檔頭卡片，內文照舊", () => {
    const m = mountScreen(props(true));
    expect(node(m, 0).classList.contains("articleMeta--author")).toBe(true);
    expect(node(m, 1).classList.contains("articleMeta--title")).toBe(true);
    expect(node(m, 4).classList.contains("articleMeta")).toBe(false);
  });

  test("桌機（沒有 commentCards）：一列都不換", () => {
    const m = mountScreen(props(undefined));
    expect(m.container.querySelector(".articleMeta")).toBe(null);
  });
});
