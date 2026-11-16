// 設定頁的說明文字（勾選框下面那行小灰字）後面如果還接著下一個設定，要留 mb="xs" 的間距：
// 原本一半有、一半沒有，沒有的那幾項說明直接黏著下一個勾選框，看起來像下一項的說明。
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(
  path.resolve(__dirname, "../../src/components/ContextMenu/PrefModal.jsx"),
  "utf8",
);

test("說明文字後面接著下一個設定 ⇒ 有 mb 間距", () => {
  const re = /<Text size="xs" c="dimmed"([^>]*)>[\s\S]*?<\/Text>\s*\n\s*(\S+)/g;
  const tight = [];
  let m;
  let total = 0;
  while ((m = re.exec(src))) {
    total++;
    const attrs = m[1];
    const next = m[2];
    if (next.startsWith("</") || next.startsWith(")") || next.startsWith("}")) continue;
    if (!/\bmb=/.test(attrs)) tight.push(src.slice(0, m.index).split("\n").length);
  }
  // 大部分說明已收進 <PrefHint textKey=…/>（元件本身固定帶 mb="xs"）；這裡掃的是還
  // 手寫 <Text> 的那些，總數要把 PrefHint 算進來，掃描才不會因為搬家而默默失效。
  const hints = (src.match(/<PrefHint textKey=/g) || []).length;
  expect(total + hints).toBeGreaterThan(20);
  expect(src).toMatch(/const PrefHint = memo\(\(\{ textKey \}\) => \(\n\s*<Text size="xs" c="dimmed" mb="xs">/);
  expect(tight).toEqual([]);
});
