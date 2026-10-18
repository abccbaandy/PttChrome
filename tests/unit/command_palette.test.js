// 指令面板的純邏輯（src/js/command_palette.js）：輸入 → 列出哪些項目。
// 能不能用全由 ctx 決定（呼叫端開面板當下量），這裡守「不能用就不列」與各類輸入的判讀。
import {
  PALETTE_ACTIONS,
  PALETTE_SETTING_LIMIT,
  buildPaletteItems,
  movePaletteIndex,
  parseArticleTarget,
} from "../../src/js/command_palette";
import { aidToFn } from "../../src/js/aid_codec";
import { zh_TW } from "../../src/js/zh_TW_messages";
import { en_US } from "../../src/js/en_US_messages";

const AID = "1gU3xHKD";
const FN = aidToFn(AID);
const ids = (items) => items.map((it) => it.id);
const LIST = { searchKinds: ["title", "author", "push", "board"] };

describe("parseArticleTarget", () => {
  test("ptt.cc 文章網址", () => {
    expect(parseArticleTarget(`https://www.ptt.cc/bbs/Gossiping/${FN}.html`)).toEqual({
      board: "Gossiping",
      aid: AID,
    });
  });

  test("本站 deep link", () => {
    expect(
      parseArticleTarget(`https://example.github.io/pttchrome/#C_Chat/${FN}.html`),
    ).toEqual({ board: "C_Chat", aid: AID });
  });

  test("PTT 文章資訊框的寫法 #AID (看板)，全形括號也吃", () => {
    expect(parseArticleTarget(`#${AID} (Gossiping)`)).toEqual({ board: "Gossiping", aid: AID });
    expect(parseArticleTarget(`#${AID}（Gossiping）`)).toEqual({ board: "Gossiping", aid: AID });
  });

  test("看板 #AID、看板/AID", () => {
    expect(parseArticleTarget(`Gossiping #${AID}`)).toEqual({ board: "Gossiping", aid: AID });
    expect(parseArticleTarget(`Gossiping/${AID}`)).toEqual({ board: "Gossiping", aid: AID });
  });

  test("沒寫看板、別的網站、空白隔開沒有 # ⇒ 不是文章", () => {
    expect(parseArticleTarget(`#${AID}`)).toBeNull();
    expect(parseArticleTarget(`https://example.com/bbs/Gossiping/${FN}.html`)).toBeNull();
    expect(parseArticleTarget(`Gossiping ${AID}`)).toBeNull();
    expect(parseArticleTarget("")).toBeNull();
  });
});

describe("buildPaletteItems", () => {
  test("空輸入 ⇒ 只列能用的動作（設定恆在）", () => {
    expect(ids(buildPaletteItems("", {}))).toEqual(["action:settings", "action:safeModeOn"]);
    expect(
      ids(buildPaletteItems("", { refresh: true, unreadJump: true, markAllRead: true, copyLink: true, back: true })),
    ).toEqual([
      "action:refresh",
      "action:unreadJump",
      "action:markAllRead",
      "action:copyLink",
      "action:back",
      "action:settings",
      "action:safeModeOn",
    ]);
  });

  test("安全模式開著 ⇒ 換成「關閉安全模式」", () => {
    const got = ids(buildPaletteItems("", { safeMode: true }));
    expect(got).toContain("action:safeModeOff");
    expect(got).not.toContain("action:safeModeOn");
  });

  test("文章網址 ⇒ 第一項是開文，不列搜尋／設定", () => {
    const items = buildPaletteItems(`https://www.ptt.cc/bbs/Gossiping/${FN}.html`, LIST);
    expect(items[0]).toMatchObject({ kind: "article", target: { board: "Gossiping", aid: AID } });
    expect(items.some((it) => it.kind === "search" || it.kind === "setting")).toBe(false);
  });

  test("文章列表打板名 ⇒ 前往看板＋搜標題＋搜作者", () => {
    expect(ids(buildPaletteItems("Gossiping", LIST)).slice(0, 3)).toEqual([
      "board",
      "search:title",
      "search:author",
    ]);
  });

  test("中文 ⇒ 沒有前往看板與搜作者（不是板名、不是帳號）", () => {
    const got = ids(buildPaletteItems("問卦", LIST));
    expect(got).toContain("search:title");
    expect(got).not.toContain("board");
    expect(got).not.toContain("search:author");
  });

  test("數字 ⇒ 多一項推文數搜尋", () => {
    expect(ids(buildPaletteItems("50", LIST))).toContain("search:push");
  });

  test("這個畫面不能搜 ⇒ 不列搜尋（文章裡、主選單只有看板）", () => {
    expect(ids(buildPaletteItems("Gossiping", { searchKinds: [] })).some((id) => /^(board|search)/.test(id))).toBe(false);
    expect(ids(buildPaletteItems("Gossiping", { searchKinds: ["board"] }))).toContain("board");
    expect(ids(buildPaletteItems("Gossiping", { searchKinds: ["board"] }))).not.toContain("search:title");
  });

  test("用關鍵字找動作，兩種語言都找得到", () => {
    expect(ids(buildPaletteItems("重整", { refresh: true }))).toContain("action:refresh");
    expect(ids(buildPaletteItems("reload", { refresh: true }))).toContain("action:refresh");
    expect(ids(buildPaletteItems("未讀", { unreadJump: true }))).toContain("action:unreadJump");
  });

  test("關鍵字開頭符合的動作排在搜尋前面；只是中間含有的排在後面", () => {
    const ctx = { ...LIST, unreadJump: true };
    expect(ids(buildPaletteItems("unread", ctx))[0]).toBe("action:unreadJump");
    expect(ids(buildPaletteItems("未讀", ctx))[0]).toBe("action:unreadJump");
    const got = ids(buildPaletteItems("讀", ctx));
    expect(got.indexOf("search:title")).toBeLessThan(got.indexOf("action:unreadJump"));
  });

  test("不能用的動作打得到關鍵字也不列", () => {
    expect(ids(buildPaletteItems("重整", { refresh: false }))).not.toContain("action:refresh");
  });

  test("設定項：最多列 PALETTE_SETTING_LIMIT 筆，帶分頁 key", () => {
    const settings = buildPaletteItems("推文", { lang: "zh_tw" }).filter((it) => it.kind === "setting");
    expect(settings.length).toBeGreaterThan(0);
    expect(settings.length).toBeLessThanOrEqual(PALETTE_SETTING_LIMIT);
    expect(settings[0]).toMatchObject({ settingKey: expect.any(String), tab: expect.any(String) });
  });
});

describe("movePaletteIndex", () => {
  test("循環、沒有項目回 -1", () => {
    expect(movePaletteIndex(0, 1, 3)).toBe(1);
    expect(movePaletteIndex(2, 1, 3)).toBe(0);
    expect(movePaletteIndex(0, -1, 3)).toBe(2);
    expect(movePaletteIndex(-1, 1, 3)).toBe(0);
    expect(movePaletteIndex(0, 1, 0)).toBe(-1);
  });
});

test("每個動作的標題兩語系都有", () => {
  for (const a of PALETTE_ACTIONS) {
    expect(zh_TW[a.titleKey], a.titleKey).toBeTruthy();
    expect(en_US[a.titleKey], a.titleKey).toBeTruthy();
  }
});
