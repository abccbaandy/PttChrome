// 主功能表畫面 row 0–22 的 getRowText（80x28，2026-10 使用者錄製檔 t=7600 以
// `yarn debug:screens` 印出）。row 11 的心情點播留言者 id 已換成佔位；狀態列含帳號，不收。
// 選單項 row 13–22，游標（`>`）在 row 14。
export const MAIN_MENU_ROWS = [
  "【主功能表】                     批踢踢實業坊                                   ",
  "┌────────┬───█────────────────────────┐  ",
  "│右繞佛塔        │     ██    在在所生處    遠離於八難                   │  ",
  "│   功德經 (節錄)│    ███     常生無難處    斯由右繞塔                 │  ",
  "├────────┘   ￣￣￣￣                                             │  ",
  "│                    ▍⊙  ⊙▋       儀貌常端正    富貴多財寶             │  ",
  "│                        λ               恒食大封邑    斯由右繞塔         │  ",
  "│                ▄▄▄▄▄▄▄▄▄                                        │  ",
  "│            ▄▄▄▄▄▄▄▄▄▄▄▄▄       色相淨微妙    見者皆欣仰     │  ",
  "│        ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄         所住常安樂    斯由右繞塔 │  ",
  "└───▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄────────────────┘  ",
  "someuser想對大家說：得妙紫金色，相好莊嚴身，現作天人師，斯由右繞塔。          ",
  "───────── 上方為使用者心情點播留言區，不代表本站立場 ────────  ",
  "                      (A)nnounce     【 精華公佈欄 】                           ",
  "                    > (F)avorite     【 我 的 最愛 】                           ",
  "                      (C)lass        【 分組討論區 】                           ",
  "                      (M)ail         【 私人信件區 】                           ",
  "                      (T)alk         【 休閒聊天區 】                           ",
  "                      (U)ser         【 個人設定區 】                           ",
  "                      (X)yz          【 系統資訊區 】                           ",
  "                      (P)lay         【 娛樂與休閒 】                           ",
  "                      (N)amelist     【 編特別名單 】                           ",
  "                      (G)oodbye         離開，再見…                            ",
];

export const MAIN_MENU_ITEM_ROWS = [13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
export const MAIN_MENU_CURSOR_ROW = 14;

// 主選單的狀態列（menu.c#show_status_bar，M_MMENU：不剪「線上」、右側只有 (h)說明）。
export const MAIN_MENU_STATUS =
  " 主選單   世界郵政日   10/9 週五 13:31 | someone | 線上24764人      (h)說明  ";

// 子選單（個人設定區，menu.c 的 userlist）24 列。合成：標題／狀態列照 redraw_title／
// show_status_bar 的格式，選單項是 userlist 的 desc 經 menu_renderer 排版；子選單寬度
// 不夠時狀態列剪掉「| 線上N人」並加上「(←)回到上層」。
export const SUBMENU_ROWS = [
  "【個人設定】                     批踢踢實業坊                                   ",
  ...MAIN_MENU_ROWS.slice(1, 13),
  "                    > (U)Customize    個人化設定",
  "                      (I)nfo          設定個人資料與密碼",
  "                      (V)Login View   選擇進站畫面",
  "                      (M)y Files      【個人檔案】 (名片,簽名檔...)",
  "                      (L)My Logs      【個人記錄】 (最近上線...)",
  "                      (R)egister      新增帳號認證",
  "                      (2)FA           設定兩階段認證",
  "",
  "",
  "",
  " 個人設定 世界郵政日     10/9 週五 13:31 | someone        (←)回到上層 (h)說明 ",
];
export const SUBMENU_ITEM_ROWS = [13, 14, 15, 16, 17, 18, 19];
