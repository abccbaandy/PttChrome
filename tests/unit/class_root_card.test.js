// @unit-env browser
// 手機分類看板根目錄大按鈕（P99）：解析（js/class_root.js）與 DOM（render/class_root_card.js）。
// 指紋的突變矩陣在 parse_failure_degrade.test.js，upstream 產的真畫面在 ptt_src_screens.test.js。
// real-input: tests/e2e/offline/mobile_class_root_cards.offline.spec.js
import {
  parseClassRootRow,
  isClassRootRows,
  classRootCursorRowOk,
} from "../../src/js/class_root";
import { buildClassRootCard } from "../../src/render/class_root_card";
import { CLASS_ROOT_ROWS, CLASS_ROOT_ITEM_ROWS, classRootRow } from "./fixtures/class_root_rows";

const charsOf = (text) => [...text].map((ch) => ({ ch, isLeadByte: false }));

test("群組列：desc 第一段 ≥2 空白切成名稱／說明、編號、游標", () => {
  expect(isClassRootRows(CLASS_ROOT_ROWS)).toBe(true);
  expect(CLASS_ROOT_ITEM_ROWS.map((y) => parseClassRootRow(CLASS_ROOT_ROWS[y]))).toEqual([
    { num: 1, name: "◎市民廣場", desc: "報告站長  PTT咬我", cursor: true },
    { num: 2, name: "◎臺灣大學", desc: "臺大, 臺科大, 師大", cursor: false },
    { num: 3, name: "◎政治大學", desc: "政大與其他學校", cursor: false },
    { num: 4, name: "◎生活娛樂館", desc: "生活, 娛樂, 心情", cursor: false },
  ]);
  expect(classRootCursorRowOk(CLASS_ROOT_ROWS[7])).toBe(true);
  expect(classRootCursorRowOk(CLASS_ROOT_ROWS[8])).toBe(false); // 沒有游標記號
  expect(classRootCursorRowOk(CLASS_ROOT_ROWS[20])).toBe(false); // 空白列
});

test("STR_CURSOR2（●，兩欄寬）、隱藏記號、未讀記號、未讀模式下沒有編號的群組都認得", () => {
  expect(parseClassRootRow(classRootRow(12, "◎科技人", "科技, 工作", { cursor: "●" }))).toMatchObject({
    num: 12,
    name: "◎科技人",
    cursor: true,
  });
  expect(parseClassRootRow(classRootRow(3, "◎隱藏群組", "", { hide: ")" }))).toMatchObject({ name: "◎隱藏群組", desc: "" });
  expect(parseClassRootRow(classRootRow(3, "◎有新文章", "說明", { mark: "ˇ" }))).toMatchObject({ name: "◎有新文章" });
  const blank = "                    ◎沒有編號     說明";
  expect(parseClassRootRow(blank)).toMatchObject({ num: null, name: "◎沒有編號", desc: "說明" });
  // upstream initbbs.c 的預設 desc（說明裡也有多個空白，原樣保留）。
  expect(parseClassRootRow(classRootRow(1, "市民廣場     報告  站長  ㄜ！", ""))).toMatchObject({
    name: "市民廣場",
    desc: "報告  站長  ㄜ！",
  });
  // desc 裡沒有說明：拿板主欄。
  expect(parseClassRootRow(classRootRow(5, "◎只有名稱", "PTT咬我"))).toMatchObject({ name: "◎只有名稱", desc: "PTT咬我" });
});

test("ANSI 圖、標題、狀態列、看板列表的一般列都不是群組列", () => {
  for (let y = 0; y < 7; ++y) expect(parseClassRootRow(CLASS_ROOT_ROWS[y])).toBeNull();
  expect(parseClassRootRow(CLASS_ROOT_ROWS[23])).toBeNull();
  // 群組裡（看板列表）的列：編號在第 0 欄起，沒有前導 10 格空白。
  expect(parseClassRootRow(">     1   Child        測試 ◎子看板                          sysop")).toBeNull();
  // 主功能表的選單項。
  expect(parseClassRootRow("                    (C)lass        【 分組討論區 】")).toBeNull();
});

test("大按鈕 DOM：名稱去掉 ◎、說明小字、›；保留 bbsrow／bbsline／data-row／data-menu-row 契約", () => {
  const card = buildClassRootCard({ chars: charsOf(CLASS_ROOT_ROWS[8]), row: 8, highlightClass: "b1" });
  const node = card.node;
  expect(node.getAttribute("type")).toBe("bbsrow");
  expect(node.getAttribute("srow")).toBe("8");
  expect(node.getAttribute("data-menu-row")).toBe("8");
  expect(node.classList.contains("menuCard")).toBe(true);
  const body = node.querySelector('[data-type="bbsline"]');
  expect(body.getAttribute("data-row")).toBe("8");
  expect(body.classList.contains("b1")).toBe(true);
  expect(node.querySelector(".menuCardName").textContent).toBe("臺灣大學");
  expect(node.querySelector(".classRootCardDesc").textContent).toBe("臺大, 臺科大, 師大");
  expect(node.querySelector(".classRootCardChevron").textContent).toBe("›");
  expect(buildClassRootCard({ chars: charsOf(CLASS_ROOT_ROWS[3]), row: 3 })).toBeNull();
});
