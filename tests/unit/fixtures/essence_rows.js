// 看板精華區（列表按 z）的畫面文字：upstream pttbbs 原始碼產生的畫面
// （ptt_src_screens/essence.json 的 "menu" 幀，announce.c#announce_renderer），24 列。
// essence_card.test.js 另有一支直接從該 fixture 的位元組重建，確認兩者一致。
export const ESSENCE_ROWS = [
  "【精華文章】                        Gossip                       看板《Gossip》 ",
  "[→]讀取資料 [/]搜尋                                                            ",
  "   編號   標  題                                        編  選       日  期     ",
  ">     1.  ◇ [爆卦] 收進精華區的文章                    judy         [09/27/26] ",
  ...Array(19).fill(" ".repeat(80)),
  " 精華列表  (F)寄回信箱 (c)複製項目 (→)讀取資料 (/)搜尋       (←)離開 (h)說明  ",
];
export const ESSENCE_HEADER_ROW_INDEX = 2;
export const ESSENCE_ITEM_ROWS = [3];

// 舊版（c20edf04 之前，announce.c#a_showmenu）：欄位標題列在第 1 列、字距不同、
// 底列是 vs_footer「【功能鍵】」／「【板  主】」。依 a_showmenu 的格式字串排出來。
export const ESSENCE_ROWS_OLD = [
  "【精華文章】                        Gossip                       看板《Gossip》 ",
  "   編號    標      題                                                        編    選      日    期",
  "●   1. ◆ [板規] 本板板規與公告                     sysop        [01/02/26]",
  "     2. ◇ [爆卦] 收進精華區的文章                   judy         [09/27/26]",
  ...Array(19).fill(" ".repeat(80)),
  " 【功能鍵】  (k↑j↓)移動游標 (enter/→)讀取資料          (q/←)離開 (h)說明 ",
];
