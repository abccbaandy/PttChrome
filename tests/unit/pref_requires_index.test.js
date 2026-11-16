// 設定索引的前置開關（requires，架構 review A7 第九、十步）：資料本身對得起來，
// 而且設定頁不再在 JSX 裡自己寫「上層沒開就反灰」（勾選列由 PrefCheckRow 自己判斷，
// 其他欄位走 prefRequiresOff）。行為表在 pref_modal_requires.test.jsx。
import fs from "node:fs";
import path from "node:path";
import { PREF_SEARCH_ITEMS, prefRequiresChain, prefRequiresOff } from "../../src/js/pref_search";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";

const prefs = PREF_SEARCH_ITEMS.filter((it) => it.kind === "pref");

describe("設定索引的前置開關", () => {
  test("requires 指向的都是索引裡、預設值是布林（或 0＝關的數字）的設定，且不繞圈", () => {
    const withReq = prefs.filter((it) => it.requires);
    expect(withReq.length).toBeGreaterThan(10);
    for (const it of withReq) {
      expect(prefs.some((p) => p.key === it.requires), it.key).toBe(true);
      expect(["boolean", "number"], it.key).toContain(typeof DEFAULT_PREFS[it.requires]);
      expect(() => prefRequiresChain(it.key)).not.toThrow();
    }
  });

  test("前置鏈一層接一層、由近到遠", () => {
    expect(prefRequiresChain("commentReplyMenu")).toEqual(["enableCommentBar", "enableLongPush"]);
    expect(prefRequiresChain("enableHelpMenuPopup")).toEqual(["enableEasyReading"]);
    expect(prefRequiresChain("mouseWheelSmoothScroll")).toEqual(["mouseWheel", "useMouseBrowsing"]);
    expect(prefRequiresChain("nativeSafeMode")).toEqual([]);
    expect(prefRequiresChain("不存在")).toEqual([]);
  });

  test("勾選列的 JSX 只給 name＋values：checked 與「上層沒開」的 disabled 不再手寫", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/components/ContextMenu/PrefModal.jsx"),
      "utf8",
    );
    const rows = [...src.matchAll(/<PrefCheckRow\b([\s\S]*?)\/>/g)].map((m) => m[1]);
    // 分區陸續改由索引畫出（PrefIndexRows），手寫的勾選列會越來越少；只擋「掃描本身壞掉、一列都沒抓到」。
    expect(rows.length).toBeGreaterThan(10);
    for (const body of rows) {
      const name = /name="(\w+)"/.exec(body)?.[1];
      expect(body, name).not.toMatch(/\bchecked=/);
      expect(body, `${name}：上層開關寫進索引的 requires`).not.toMatch(/disabled=\{[^}]*values\./);
    }
  });

  test("prefRequiresOff：前置鏈任一格關（含數字 0）就是 true", () => {
    const on = { useMouseBrowsing: true, mouseWheel: 1 };
    expect(prefRequiresOff("mouseWheelSmoothScroll", on)).toBe(false);
    expect(prefRequiresOff("mouseWheelSmoothScroll", { ...on, mouseWheel: 0 })).toBe(true);
    expect(prefRequiresOff("mouseWheelSmoothScroll", { ...on, useMouseBrowsing: false })).toBe(true);
    expect(prefRequiresOff("nativeSafeMode", {})).toBe(false);
  });

  test("設定頁不再手寫「上層沒開就反灰」：其他欄位的 disabled 一律走 prefRequiresOff", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/components/ContextMenu/PrefModal.jsx"),
      "utf8",
    );
    const left = [...src.matchAll(/(?<![-\w])disabled=\{!values\.(\w+)\}/g)].map((m) => m[1]);
    // 剩下的都是索引表達不了的：syncReadLater 不在設定搜尋索引裡（雲端同步分區的按鈕列）。
    expect(left).toEqual(["enableRecentArticles"]);
  });
});
