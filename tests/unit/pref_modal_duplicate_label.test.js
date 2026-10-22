// 設定頁同一句話不印兩次：PrefSection 的標題（legendKey）已經寫了，裡面的欄位就不再用同一個
// 字串當 label（「連線編碼（重新連線後生效）」曾經上下各一行）。螢幕閱讀器要的名字用 aria-label 給。
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(
  path.resolve(__dirname, "../../src/components/ContextMenu/PrefModal.jsx"),
  "utf8",
);

test("PrefSection 標題的字串不再當欄位的 label", () => {
  const legends = new Set(
    Array.from(src.matchAll(/legendKey="([A-Za-z0-9_]+)"/g), (m) => m[1]),
  );
  expect(legends.size).toBeGreaterThan(5);
  const dup = Array.from(src.matchAll(/(?<![-\w])label=\{i18n\("([A-Za-z0-9_]+)"\)\}/g), (m) => m[1]).filter(
    (k) => legends.has(k),
  );
  expect(dup).toEqual([]);
});
