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
