// 兩個語系的 key 集合必須一致。
//
// 這條是實際壞過才補的：`options_mouse` 長期只存在於 en_US_messages.js，zh_TW
// 沒有 —— i18n() 對缺 key 回 undefined 並 console.log，畫面上就是一個沒有文字的
// 分頁標籤。整批增刪 key 時（例如 2026-08 的滑鼠重新設計一口氣動了十幾個）漏一個
// 語系幾乎是必然，靠人眼比對不可靠。
import { zh_TW as zh } from "../../src/js/zh_TW_messages";
import { en_US as en } from "../../src/js/en_US_messages";

const keysOf = (obj) => Object.keys(obj).sort();

describe("i18n 兩語系", () => {
  test("key 集合完全相同", () => {
    const zhKeys = keysOf(zh);
    const enKeys = keysOf(en);
    expect(zhKeys.filter((k) => !(k in en))).toEqual([]);
    expect(enKeys.filter((k) => !(k in zh))).toEqual([]);
  });

  // message 通常是字串；about_new_content 是條列陣列（「重大技術升級」清單）。
  const isFilled = (m) => (Array.isArray(m) ? m.length > 0 : typeof m === "string" && !!m);

  test("每個 key 都有非空的 message", () => {
    [
      ["zh_TW", zh],
      ["en_US", en],
    ].forEach(([name, table]) => {
      const bad = Object.keys(table).filter((k) => !table[k] || !isFilled(table[k].message));
      expect(`${name}: ${bad.join(", ")}`).toBe(`${name}: `);
    });
  });
});
