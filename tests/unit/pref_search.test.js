// 設定搜尋的比對／排序邏輯（src/js/pref_search.js）。純函式，無 DOM。
//
// 斷言一律鎖**行為**（哪一項會被找到、靠什麼命中、誰排前面），不鎖分數的實際
// 數值——調權重是預期會發生的事，調了就該只有排序測試需要跟著看。
//
// 一律顯式傳 lang：不傳的話會走 getLang() 讀 navigator.languages，jsdom 下是
// 跑測試那台機器的語系 ⇒ 換一台機器結果就變。
import {
  searchPrefSettings,
  PREF_SEARCH_ITEMS,
  MAX_RESULTS,
} from "../../src/js/pref_search";

const zh = (q, opts) => searchPrefSettings(q, { lang: "zh_tw", ...opts });
const en = (q, opts) => searchPrefSettings(q, { lang: "en_us", ...opts });
const keysOf = (rows) => rows.map((r) => r.key);
const find = (rows, key) => rows.find((r) => r.key === key);

describe("searchPrefSettings", () => {
  test("空查詢與全空白回空陣列（不是回全部）", () => {
    expect(zh("")).toEqual([]);
    expect(zh("   ")).toEqual([]);
    expect(zh(null)).toEqual([]);
    expect(zh(undefined)).toEqual([]);
  });

  test("中文子字串命中標題", () => {
    const rows = zh("好讀", { limit: 50 });
    expect(keysOf(rows)).toContain("enableEasyReading");
    expect(keysOf(rows)).toContain("enableEasyReadingList");
    expect(find(rows, "enableEasyReading").matchedVia).toBe("title");
  });

  test("標題前綴命中排在子字串命中之前", () => {
    // 「啟用滑鼠瀏覽」是前綴命中，滑鼠分頁其他項目多半只在分區／說明命中。
    const rows = zh("啟用滑鼠", { limit: 50 });
    expect(rows[0].key).toBe("useMouseBrowsing");
    expect(rows[0].matchedVia).toBe("title");
  });

  test("中文介面打英文 key 也命中（本功能的主要理由）", () => {
    const rows = zh("auto", { limit: 50 });
    const hit = find(rows, "autoLogin");
    expect(hit).toBeTruthy();
    expect(hit.matchedVia).toBe("key");
    // 顯示的仍是中文標題，不是 key。
    expect(hit.title).toBe("開啟網頁時自動登入");
  });

  test("去駝峰後的多字比對：\"easy reading\" 命中 enableEasyReading", () => {
    const rows = zh("easy reading", { limit: 50 });
    expect(keysOf(rows)).toContain("enableEasyReading");
  });

  test("大小寫不敏感", () => {
    const a = keysOf(zh("AUTO", { limit: 50 }));
    const b = keysOf(zh("auto", { limit: 50 }));
    const c = keysOf(zh("AuTo", { limit: 50 }));
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  test("中文介面打另一語系的標題文字也命中", () => {
    // 刻意挑 key 裡沒有這個字的項目（enableBell ↛ "beep"），否則會先被 key
    // 那條規則接走，測不到 altLang。
    const rows = zh("beep", { limit: 50 });
    const hit = find(rows, "enableBell");
    expect(hit).toBeTruthy();
    expect(hit.matchedVia).toBe("altLang");
    expect(hit.title).toBe("PTT 發出提示音時嗶一聲（輸入錯誤、將軍、聊天邀請等）");
  });

  test("只出現在說明文字裡的詞也命中", () => {
    // 「熱門看板」只在 tooltip_enableBoardListSmoothScroll 出現，標題沒有。
    const rows = zh("熱門看板", { limit: 50 });
    const hit = find(rows, "enableBoardListSmoothScroll");
    expect(hit).toBeTruthy();
    expect(hit.matchedVia).toBe("tooltip");
  });

  test("分區／分頁名命中會把該區的項目都帶出來", () => {
    const rows = zh("滑鼠", { limit: 100 });
    const mouseKeys = PREF_SEARCH_ITEMS.filter(
      (it) => it.tab === "mouse" && it.kind === "pref",
    ).map((it) => it.key);
    mouseKeys.forEach((k) => expect(keysOf(rows)).toContain(k));
  });

  test("命中方式的排序：title → key → section → tooltip → altLang", () => {
    const rows = zh("滑鼠", { limit: 100 });
    const order = ["title", "key", "section", "tooltip", "altLang"];
    const seen = rows.map((r) => order.indexOf(r.matchedVia));
    // 非遞減即代表分組順序正確。
    seen.forEach((v, i) => {
      expect(v).toBeGreaterThanOrEqual(0);
      if (i > 0) expect(v).toBeGreaterThanOrEqual(seen[i - 1]);
    });
  });

  test("ranges 切出來的就是查詢字串本身", () => {
    const rows = zh("好讀", { limit: 50 });
    rows
      .filter((r) => r.matchedVia === "title")
      .forEach((r) => {
        expect(r.ranges.length).toBe(1);
        const [s, e] = r.ranges[0];
        expect(r.title.slice(s, e)).toBe("好讀");
      });
  });

  test("非標題命中不畫假高亮（ranges 為空）", () => {
    const rows = zh("auto", { limit: 50 });
    rows
      .filter((r) => r.matchedVia !== "title")
      .forEach((r) => expect(r.ranges).toEqual([]));
  });

  test("預設截斷到 MAX_RESULTS", () => {
    const rows = zh("啟用");
    expect(rows.length).toBeLessThanOrEqual(MAX_RESULTS);
    expect(zh("啟用", { limit: 100 }).length).toBeGreaterThan(MAX_RESULTS);
  });

  test("兩個語系拿到同一組 key、不同的顯示文字", () => {
    const zhRows = zh("mouse", { limit: 100 });
    const enRows = en("mouse", { limit: 100 });
    expect(new Set(keysOf(zhRows))).toEqual(new Set(keysOf(enRows)));
    expect(find(zhRows, "useMouseBrowsing").title).toBe("啟用滑鼠瀏覽");
    expect(find(enRows, "useMouseBrowsing").title).toBe("Enable mouse browsing");
  });

  test("陣列型 message（about_new_content）不會炸", () => {
    // 「關於」分頁的更新說明是條列陣列；索引掃到它時若沒扁平化會丟例外。
    expect(() => zh("升級", { limit: 100 })).not.toThrow();
    expect(() => en("upgrade", { limit: 100 })).not.toThrow();
  });

  test("每一筆結果都帶得出分頁名與可跳轉的 key", () => {
    const rows = zh("設定", { limit: 100 });
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((r) => {
      expect(typeof r.key).toBe("string");
      expect(r.key.length).toBeGreaterThan(0);
      expect(r.tabLabel).toBeTruthy();
      expect(r.title).toBeTruthy();
    });
  });

  test("分區項不重複顯示自己的分區名當副標", () => {
    const rows = zh("備份", { limit: 100 });
    rows
      .filter((r) => r.kind === "section")
      .forEach((r) => expect(r.sectionLabel).toBeNull());
  });

  test("分區名與分頁名同字時不重複印（不出現「增強功能 · 增強功能」）", () => {
    const rows = zh("推文", { limit: 100 });
    const hit = find(rows, "showFloorNumbers");
    expect(hit).toBeTruthy();
    // 「增強功能」分頁的唯一分區 legend 就叫「增強功能」。
    expect(hit.tabLabel).toBe("增強功能");
    expect(hit.sectionLabel).toBeNull();
    rows.forEach((r) => expect(r.sectionLabel).not.toBe(r.tabLabel));
  });

  test("查無結果回空陣列", () => {
    expect(zh("zzzzznotathing", { limit: 100 })).toEqual([]);
  });
});
