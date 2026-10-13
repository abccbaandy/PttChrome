// 手機列表卡片 ＋ 已讀低亮的 CSS 契約（src/css/main.css）。讀檔、剝註解、正則取規則體
// （手法同 comment_spacing_css.test.js）。鎖的是「順手改一下就靜默壞掉」的幾件事：
//  (1) 卡片高（em）＝ LIST_CARD_ROWS：list_scroll.js 的位置↔scrollTop 是純乘除，
//      兩邊漂移 ⇒ 捲動／點擊整批錯位；
//  (2) 卡片間距只能是 border-box 固定高內的 padding-block，不可 margin／border
//      （會加在固定高之外）；
//  (3) 已讀低亮只掛在 #mainContainer.dimReadList 下（pref 關掉就完全不作用），
//      且排除游標列（選中項要可辨識）。
import fs from "node:fs";
import path from "node:path";
import { LIST_CARD_ROWS } from "../../src/js/mobile_layout";

const STRIPPED = fs
  .readFileSync(path.join(__dirname, "..", "..", "src", "css", "main.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

const rules = (re) =>
  [...STRIPPED.matchAll(/([^{}]*)\{([^}]*)\}/g)]
    .filter((m) => re.test(m[1]))
    .map((m) => ({ sel: m[1].trim(), body: m[2] }));

describe("列表卡片 CSS", () => {
  const card = rules(/\.listBodyView\s*>\s*span\.listCard\s*$/);

  test("卡片外框規則存在且唯一", () => {
    expect(card.length).toBe(1);
  });

  test("高度（em）＝ LIST_CARD_ROWS，且為 border-box", () => {
    const m = card[0].body.match(/(?:^|;|\s)height:\s*([\d.]+)em/);
    expect(m && Number(m[1])).toBe(LIST_CARD_ROWS);
    expect(card[0].body).toMatch(/box-sizing:\s*border-box/);
  });

  test("間距用 padding-block，不得用 margin／border", () => {
    expect(card[0].body).toMatch(/padding-block:/);
    expect(card[0].body).not.toMatch(/(^|[;\s])margin(-block|-top|-bottom)?:/);
    expect(card[0].body).not.toMatch(/(^|[;\s])border(-top|-bottom|-block)?:/);
  });
});

describe("已讀文章低亮 CSS", () => {
  const dim = rules(/\[data-list-read\]/);

  // 使用者回報：0.45 太暗幾乎看不清。要「跟未讀明顯不同」但仍讀得出字。
  test("低亮程度：仍可讀（opacity ≥ 0.55）且與未讀有明顯差異（≤ 0.75）", () => {
    for (const r of dim) {
      const m = r.body.match(/opacity:\s*([\d.]+)/);
      expect(m).not.toBe(null);
      expect(Number(m[1])).toBeGreaterThanOrEqual(0.55);
      expect(Number(m[1])).toBeLessThanOrEqual(0.75);
    }
  });

  // 回歸：卡片次行原本自帶 opacity 0.6，已讀再乘一次 ⇒ 0.27，作者／日期看不見。
  test("卡片內各段不得自帶 opacity（避免與已讀低亮疊乘）", () => {
    for (const r of rules(/\.listCard\b/)) expect(r.body).not.toMatch(/opacity:/);
  });

  test("只掛在 #mainContainer.dimReadList 下", () => {
    expect(dim.length).toBeGreaterThan(0);
    for (const r of dim) expect(r.sel).toMatch(/#mainContainer\.dimReadList/);
  });

  test("排除游標列（bbsline 與卡片本體都要排除）", () => {
    const sel = dim.map((r) => r.sel).join("\n");
    expect(sel).toMatch(/:not\(\s*:has\([^)]*data-type="bbsline"/);
    expect(sel).toMatch(/:not\(:has\(>\s*\.listCardBody/);
  });
});
