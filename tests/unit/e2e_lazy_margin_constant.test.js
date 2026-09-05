// easy_reading_scroll_jump.offline.spec.js 抄了一份 LAZY_MOUNT_MARGIN_PX，這裡守住
// 「兩邊一致」（2026-09-05）。
//
// 為什麼要抄：spec 是 CJS、產品端是 ESM，測試一端 import 不進來。
// 為什麼非守不可：那支 spec 挑「已卸載、只剩替身盒」的佔位盒時，用這個邊界把候選
// 限制在**掛載範圍之外** —— 少了這道限制就會挑到邊界上的 slot，而它在機器慢一點時
// 早就自己掛回來、圖也載好了 ⇒ 候選歸零，測試紅在一句看不出原因的「素材太短」
// （實錄：actions/runs/33955762422，同一份素材本機與其他四輪 CI 全綠）。
// 產品端把邊界調大時這條會紅，提醒 spec 的死角也要跟著變大。
//
// 純靜態比對，不連網、不開瀏覽器 ⇒ 放 unit（比照 tests/unit/e2e_layout_settle.test.js）。
import fs from "fs";
import path from "path";
import { LAZY_MOUNT_MARGIN_PX } from "../../src/js/lazy_media";

const SPEC = path.join(
  __dirname,
  "..",
  "e2e",
  "offline",
  "easy_reading_scroll_jump.offline.spec.js",
);

test("scroll_jump spec 抄的 MOUNT_MARGIN_PX 與產品端的 LAZY_MOUNT_MARGIN_PX 一致", () => {
  const src = fs.readFileSync(SPEC, "utf8");
  const m = /^const MOUNT_MARGIN_PX = (\d+);$/m.exec(src);
  expect(
    m,
    "找不到 `const MOUNT_MARGIN_PX = <數字>;` —— 改名或改寫法時要一起更新這條守護",
  ).not.toBeNull();
  expect(Number(m[1])).toBe(LAZY_MOUNT_MARGIN_PX);
});
