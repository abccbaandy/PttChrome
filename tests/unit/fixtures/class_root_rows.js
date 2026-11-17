// 分類看板根目錄（P99）的畫面文字，24 列。依 mbbsd/board.c 的 IN_CLASSROOT 版型排出來：
//   第 0 列 redraw_title("分類看板", …)、第 1～6 列寫死的 ANSI 圖（文字取自 upstream 產的
//   ptt_src_screens/class_list.json "root" 幀）、群組列 prints("          %s%s%*s %s",
//   col_num＝"%7d%c%s", t_desc 補空白到 40 欄, 第 61 欄起 t_bm)、游標 cursor_show(y, 10)、
//   底列 vs_cmd_bar 的「分類看板」caption。
// 群組的 desc 是「名稱＋多個空白＋說明」同一欄（util/initbbs.c：「市民廣場     報告  站長  ㄜ！」），
// 板主欄 80 欄時只剩 12 欄寬。upstream 那一幀只有一個群組、沒有說明，這裡照同一個格式字串多排幾個。
const W = (s) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) < 0x80 ? 1 : 2), 0);
const padTo = (s, n) => s + " ".repeat(Math.max(0, n - W(s)));

export function classRootRow(num, desc, bm, opts = {}) {
  let col = String(num).padStart(7) + (opts.hide || " ") + (opts.mark || "  ");
  if (opts.cursor) col = opts.cursor + (opts.cursor === ">" ? " " : "") + col.slice(2);
  return padTo("          " + col + padTo(desc, 40) + " " + bm, 80);
}

const GROUPS = [
  ["◎市民廣場     報告站長  PTT咬我", ""],
  ["◎臺灣大學     臺大, 臺科大, 師大", "sysop"],
  ["◎政治大學     政大與其他學校", ""],
  ["◎生活娛樂館   生活, 娛樂, 心情", ""],
];

export const CLASS_ROOT_ROWS = [
  padTo("【分類看板】                       新批踢踢", 80),
  padTo("                                                              ◣  ╭—●", 80),
  padTo("                                                    ╬—   ◢█⊙██◣╤", 80),
  padTo("     ︿︿︿︿︿︿︿︿                               ║ ◣◢███▼▼▼║", 80),
  padTo("                                                       ◤◥███▲▲▲ ║", 80),
  padTo("                                  ︿︿︿︿︿︿︿︿    │   ◥████◤ ║", 80),
  padTo("                                                      ╫——  ◤      —＋", 80),
  ...GROUPS.map(([d, b], i) => classRootRow(i + 1, d, b, i === 0 ? { cursor: ">" } : {})),
  ...Array(12).fill(" ".repeat(80)),
  padTo(" 分類看板  (m)加入最愛 (v)已讀/未讀 (t)標記 (y)只列最愛     (←)回上層 (h)說明", 80),
];
export const CLASS_ROOT_ITEM_ROWS = [7, 8, 9, 10];
