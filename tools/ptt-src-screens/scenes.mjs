// upstream pttbbs 原始碼畫面的場景表：每個場景＝一次 driver（入口＋列數）＋一串按鍵，
// 每送一次鍵就切一幀。產出 tests/unit/fixtures/ptt_src_screens/<file>.json，由
// tests/unit/ptt_src_screens.test.js 依幀名斷言。
//
// 規則：
//   - 第一幀不送鍵（入口畫完的畫面）；之後每幀的 keys 是「送出後畫出這一幀」的鍵。
//   - 只有要斷言的幀才取 name；中途的幀（例：跳號的 prompt）也照樣存，重放時要從頭疊。
//   - 場景彼此獨立（各自一個暫存 BBSHOME），一條路徑壞掉不會連坐其他畫面。
//   - 鍵序列只用 upstream 鍵表（bbs.c read_comms／psb.c）裡的鍵；upstream 改鍵會讓斷言紅，
//     那正是要抓的。
export const COLS = 80;

export const SCENES = [
  {
    // 文章列表：一般列、m 標記、Re:、長標題截斷、置底 ★。
    file: 'article_list',
    entry: 'read:Test',
    rows: 24,
    steps: [{ name: 'list' }],
  },
  {
    // 列數 > 24（固定字體大小模式送的 NAWS；欄數恆 80，見 docs/terminal-size.md）。
    // Long 板 50 篇：一頁 rows-4 列全滿，量得到 p_lines 跟著列數走。
    file: 'article_list_tall',
    entry: 'read:Long',
    rows: 40,
    steps: [{ name: 'list' }],
  },
  {
    // 跳到第 1 篇開文 ⇒ pmore 狀態列。
    file: 'article',
    entry: 'read:Test',
    rows: 24,
    steps: [{ name: 'list' }, { keys: '1' }, { keys: '\r', name: 'list-jumped' }, { keys: '\r', name: 'article' }],
  },
  {
    // pmore 自己的 getdata prompt（pmore.c#pmore_do_goto、pmore_search_keyword）畫在 b_lines-1，
    // **狀態列留在底列**：`:` 跳行 → 2⏎ 落地 → `/` 搜尋 → 打 X。
    file: 'article_prompts',
    entry: 'read:Test',
    rows: 24,
    steps: [
      { name: 'list' },
      { keys: '1' },
      { keys: '\r' },
      { keys: '\r', name: 'article' },
      { keys: ':', name: 'goto' },
      { keys: '2\r', name: 'landed' },
      { keys: '/', name: 'search' },
      { keys: 'X', name: 'search-typed' },
    ],
  },
  {
    // 文章列表的 h：新版說明選單（psb.c#cmd_show_help_layers_inner）。
    file: 'help_menu',
    entry: 'read:Test',
    rows: 24,
    steps: [{ name: 'list' }, { keys: 'h', name: 'help' }],
  },
  {
    // 有進板畫面的看板：Read() 先 more(notes) 再 pressanykey，按空白進文章列表。
    file: 'board_note',
    entry: 'read:Notes',
    rows: 24,
    steps: [{ name: 'note' }, { keys: ' ', name: 'list' }],
  },
  {
    // 我的最愛（看板列表 fav 變體）。
    file: 'board_list',
    entry: 'fav',
    rows: 24,
    steps: [{ name: 'fav' }],
  },
  {
    // 我的最愛按 y 列出全部看板（caption 不變，只能靠提示分 fav／all）、再按 y 回最愛，
    // c 切成顯示文章總數（row 2「總數」）。
    file: 'board_list_toggles',
    entry: 'fav',
    rows: 24,
    steps: [
      { name: 'fav' },
      { keys: 'y', name: 'all' },
      { keys: 'y', name: 'fav-again' },
      { keys: 'c', name: 'newflag' },
    ],
  },
  {
    // 主功能表。
    file: 'main_menu',
    entry: 'menu',
    rows: 24,
    steps: [{ name: 'menu' }],
  },
  {
    // 有新信的主功能表（標題列中段「你有新信件」）。
    file: 'main_menu_newmail',
    entry: 'menu:newmail',
    rows: 24,
    steps: [{ name: 'menu' }],
  },
  {
    // 文章列表按 X 推文（bbs.c#recommend）。
    file: 'push',
    entry: 'read:Test',
    rows: 24,
    steps: [{ name: 'list' }, { keys: 'X', name: 'push-1' }, { keys: '1', name: 'push-2' }],
  },
  {
    // 推文走完：輸入 → 確定[y/N] → y⏎ 寫進文章 → 開文看到那一則推文列（帶時間戳，long_push 判 IP 記錄板用）。
    file: 'push_flow',
    entry: 'read:Test',
    rows: 24,
    steps: [
      { name: 'list' },
      { keys: 'X', name: 'input' },
      { keys: 'hello\r', name: 'confirm' },
      { keys: 'y\r', name: 'done' },
      { keys: '\r', name: 'article' },
    ],
  },
  {
    // 文章列表的搜尋 prompt（read.c#ask_filter_predicate、bbs.c#do_select）：每種開一次，
    // 空白 ⏎ 取消回列表再開下一種；最後 s 選看板停在兩段式 prompt。
    file: 'search_prompts',
    entry: 'read:Test',
    rows: 24,
    steps: [
      { name: 'list' },
      { keys: '/', name: 'title' },
      { keys: '\r' },
      { keys: 'a', name: 'author' },
      { keys: '\r' },
      { keys: 'Z', name: 'push' },
      { keys: '\r' },
      { keys: 's', name: 'board' },
    ],
  },
  {
    // 已在搜尋結果裡（MODE_SELECT）再搜 ⇒「增加條件 …」。
    file: 'search_refine',
    entry: 'read:Test',
    rows: 24,
    steps: [
      { name: 'list' },
      { keys: '/' },
      { keys: 'Re\r', name: 'result' },
      { keys: '/', name: 'title' },
    ],
  },
  {
    // 文章列表的 v（bbs.c#b_mark_read_unread）：getdata prompt「設定所有文章 (U)未讀 (V)已讀 …」。
    file: 'mark_read_prompt',
    entry: 'read:Test',
    rows: 24,
    steps: [{ name: 'list' }, { keys: 'v', name: 'prompt' }],
  },
  {
    // 主功能表 G⏎ 離站（xyz.c#Goodbye）：確認 getdata，y⏎ 之後 vmsg 停留時間（pressanykey）。
    // 再按一鍵就 u_exit 關線，所以停在 pressanykey。
    file: 'goodbye',
    entry: 'menu',
    rows: 24,
    steps: [{ name: 'menu' }, { keys: 'G\r', name: 'confirm' }, { keys: 'y\r', name: 'pause' }],
  },
  {
    // 主功能表的 s：同一個選看板 prompt。
    file: 'menu_search',
    entry: 'menu',
    rows: 24,
    steps: [{ name: 'menu' }, { keys: 's', name: 'board' }],
  },
  {
    // 一般水球模式回水球（wmsg.c#wmsg_handle_ctrl_r_default）：收了 alice、bob、carol 三顆，
    // 第一下 ^R 回最新一位（carol）的 prompt，再按 ^R 出訊息回顧、每按一下往舊的選一則。
    file: 'waterball_default',
    entry: 'wmsg:default',
    rows: 24,
    steps: [
      { name: 'menu' },
      { keys: '\x12', name: 'prompt' },
      { keys: '\x12', name: 'panel-1' },
      { keys: '\x12', name: 'panel-2' },
      { keys: '\x12', name: 'panel-3' },
    ],
  },
  {
    // 一對一模式（UF_PAGER_OFO，wmsg.c#ofo_my_write）：^R 開「↑反擊對象↓」名單，
    // 預設選最新一位，每按一下 ^R 換下一位（ofo_switch_user(1)）。
    file: 'waterball_ofo',
    entry: 'wmsg:ofo',
    rows: 24,
    steps: [
      { name: 'menu' },
      { keys: '\x12', name: 'ofo-1' },
      { keys: '\x12', name: 'ofo-2' },
      { keys: '\x12', name: 'ofo-3' },
    ],
  },
];
