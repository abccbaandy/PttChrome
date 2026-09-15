// 自訂滑鼠指標的圖檔對照表。key ＝ mouse_regions 的 CUR_* 值，餵給
// `cursorCss(kind, { urls: MOUSE_CURSOR_URLS, iconsEnabled })`。
//
// 為什麼獨立一個模組：兩條 hover 路徑（原生的 term_buf.onMouse_move、列表好讀的
// term_view.onListMouseMove）都要同一份 URL，各自 import 五個 PNG 只會漂移。
//
// 圖檔是 Polar Cursor Theme（GPL v2，src/cursor/COPYRIGHT.txt）。back 以外的四顆
// 是 2026-09 找回邊緣翻頁區時從 3rd_script/ptt-term 拿回來的同一套。
//
// 歷史坑（別再犯）：改寫成 React 之前的 mouseCursorMap 每一筆都寫成
// `url(${x} 0 6,auto` —— **少一個右括號**，依 CSS Syntax 整條 declaration 會被丟棄
// ⇒ 那 11 顆指標其實從未顯示過。括號平衡的回歸鎖在 tests/unit/mouse_regions.test.js。
import cursorBack from '../cursor/back.png';
import cursorPageUp from '../cursor/pageup.png';
import cursorPageDown from '../cursor/pagedown.png';
import cursorHome from '../cursor/home.png';
import cursorEnd from '../cursor/end.png';

import { CUR_BACK, CUR_PAGE_UP, CUR_PAGE_DOWN, CUR_HOME, CUR_END } from './mouse_regions';

export const MOUSE_CURSOR_URLS = {
  [CUR_BACK]: cursorBack,
  [CUR_PAGE_UP]: cursorPageUp,
  [CUR_PAGE_DOWN]: cursorPageDown,
  [CUR_HOME]: cursorHome,
  [CUR_END]: cursorEnd
};
