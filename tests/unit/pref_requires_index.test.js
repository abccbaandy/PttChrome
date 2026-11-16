// 設定索引的前置開關（requires，架構 review A7 第九步）：資料本身對得起來，
// 而且勾選列不再在 JSX 裡自己寫「上層沒開就反灰」。行為表在 pref_modal_requires.test.jsx。
import fs from "node:fs";
import path from "node:path";
import { PREF_SEARCH_ITEMS, prefRequiresChain } from "../../src/js/pref_search";
import { DEFAULT_PREFS } from "../../src/js/pref_storage";

const prefs = PREF_SEARCH_ITEMS.filter((it) => it.kind === "pref");

describe("設定索引的前置開關", () => {
  test("requires 指向的都是索引裡、預設值是布林的設定，且不繞圈", () => {
    const withReq = prefs.filter((it) => it.requires);
    expect(withReq.length).toBeGreaterThan(10);
    for (const it of withReq) {
      expect(prefs.some((p) => p.key === it.requires), it.key).toBe(true);
      expect(typeof DEFAULT_PREFS[it.requires], it.key).toBe("boolean");
      expect(() => prefRequiresChain(it.key)).not.toThrow();
    }
  });

  test("前置鏈一層接一層、由近到遠", () => {
    expect(prefRequiresChain("commentReplyMenu")).toEqual(["enableCommentBar", "enableLongPush"]);
    expect(prefRequiresChain("enableHelpMenuPopup")).toEqual(["enableEasyReading"]);
    expect(prefRequiresChain("nativeSafeMode")).toEqual([]);
    expect(prefRequiresChain("不存在")).toEqual([]);
  });

  test("勾選列的 JSX 只給 name＋values：checked 與「上層沒開」的 disabled 不再手寫", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/components/ContextMenu/PrefModal.jsx"),
      "utf8",
    );
    const rows = [...src.matchAll(/<PrefCheckRow\b([\s\S]*?)\/>/g)].map((m) => m[1]);
    expect(rows.length).toBeGreaterThan(90);
    for (const body of rows) {
      const name = /name="(\w+)"/.exec(body)?.[1];
      expect(body, name).not.toMatch(/\bchecked=/);
      expect(body, `${name}：上層開關寫進索引的 requires`).not.toMatch(/disabled=\{[^}]*values\./);
    }
  });
});
