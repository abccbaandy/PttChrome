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
    // 文章裡的 h：同一套 psb 說明選單（psb.c#cmd_show_help_layers_inner，caption「文章閱讀」，3 頁），
    // 有「(Space)」「(→)」這種只有鍵、沒有名稱的項目。空白＝PgDn，q 回文章。
    file: 'article_help',
    entry: 'read:Test',
    rows: 24,
    steps: [
      { name: 'list' },
      { keys: '1' },
      { keys: '\r' },
      { keys: '\r', name: 'article' },
      { keys: 'h', name: 'help' },
      { keys: ' ', name: 'help-2' },
      { keys: ' ', name: 'help-3' },
      { keys: 'q', name: 'back' },
    ],
  },
  {
    // pmore 的設定頁（pmore.c#pmore_Preference／pmore_QuickRawModePref）：o 完整設定頁、\ 在頁上
    // 循環色彩模式（→ 原始ANSI控制碼）、q 離開；再 \ 開快速設定（選中的是 2）、1 直選回預設。
    // 完整設定頁的選項沒有數字熱鍵（「 *預設格式化內容 | …」），快速設定頁有（「1*預設格式化內容 |2 …」）。
    // pmore_pref.js 靠它決定要不要整篇重讀、記下目前的色彩模式（開燈按鈕的狀態）。
    file: 'article_pref',
    entry: 'read:Test',
    rows: 24,
    steps: [
      { name: 'list' },
      { keys: '1' },
      { keys: '\r' },
      { keys: '\r', name: 'article' },
      { keys: 'o', name: 'pref' },
      { keys: '\\', name: 'pref-cycled' },
      { keys: 'q', name: 'pref-closed' },
      { keys: '\\', name: 'quick' },
      { keys: '1', name: 'back' },
    ],
  },
  {
    // 文章列表的 Q：文章資訊（bbs.c#view_postinfo）——AID／網址，aid_navigation 讀它落地。
    file: 'post_info',
    entry: 'read:Test',
    rows: 24,
    steps: [{ name: 'list' }, { keys: 'Q', name: 'info' }],
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
    // 分類看板：主功能表游標預設就在 (C)lass，⏎ 進根（class_bid 1，只列 gid＝1 的群組），
    // 再 ⏎ 進群組（class_bid>1，看板列表的 class 變體）。
    file: 'class_list',
    entry: 'menu',
    rows: 24,
    steps: [{ name: 'menu' }, { keys: '\r', name: 'root' }, { keys: '\r', name: 'group' }],
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
    // 看板列表的重新整理（screen_refresh.buildBoardListRefreshSteps）：/ 開「請輸入看板中文關鍵字」
    // prompt（board.c），⏎ 用原關鍵字送出＝重讀列表。
    file: 'board_list_refresh',
    entry: 'fav',
    rows: 24,
    steps: [{ name: 'fav' }, { keys: '/', name: 'keyword' }, { keys: '\r', name: 'reloaded' }],
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
    // 文章列表按 X 推文（bbs.c#comment）：型別選單（vkey 單鍵）→ 1 ⇒「推 id:」輸入列。
    file: 'push',
    entry: 'read:Test',
    rows: 24,
    steps: [{ name: 'list' }, { keys: 'X', name: 'push-1' }, { keys: '1', name: 'push-2' }],
  },
  {
    // 推文走完：型別選單 → 輸入 → 確定[y/N] → y⏎ 寫進文章 → 開文看到那一則推文列（帶時間戳，long_push 判 IP 記錄板用）。
    file: 'push_flow',
    entry: 'read:Test',
    rows: 24,
    steps: [
      { name: 'list' },
      { keys: 'X', name: 'menu' },
      { keys: '1', name: 'input' },
      { keys: 'hello\r', name: 'confirm' },
      { keys: 'y\r', name: 'done' },
      { keys: '\r', name: 'article' },
    ],
  },
  {
    // 長推文續推：推完一則 90 秒內再按 X ⇒ 沒有型別選單，倒數第二列「時間太近, 使用 → 加註方式」
    // ＋直接是「→ id:」輸入列（bbs.c#comment 的 if/else if 互斥；driver 的時間釘死 ⇒ 間隔 0 秒）。
    file: 'push_again',
    entry: 'read:Test',
    rows: 24,
    steps: [
      { name: 'list' },
      { keys: 'X' },
      { keys: '1' },
      { keys: 'hello\r' },
      { keys: 'y\r', name: 'done' },
      { keys: 'X', name: 'too-close' },
      { keys: 'world\r', name: 'confirm' },
    ],
  },
  {
    // 搜尋結果（系列文章）裡推文：型別選單 → 輸入列。bbs.c#comment 對「direct 不是 .DIR」會在輸入列上方
    // 印「◆您正在搜尋…」警告，但 upstream 現行搜尋是 .DIR 上的過濾視圖（read.c#search_predicates_window），
    // direct 仍是 .DIR ⇒ 不印；舊 server（SR.* 檔）才會出現，push_screen 只讀底列，兩種都不受影響。
    file: 'push_search',
    entry: 'read:Test',
    rows: 24,
    steps: [
      { name: 'list' },
      { keys: '/' },
      { keys: 'Re\r', name: 'result' },
      { keys: 'X', name: 'menu' },
      { keys: '1', name: 'input' },
    ],
  },
  {
    // 推自己的文章：沒有型別選單，倒數第二列「作者本人, 使用 → 加註方式」＋「→ id:」輸入列。
    file: 'push_owner',
    entry: 'read:Mine',
    rows: 24,
    steps: [{ name: 'list' }, { keys: 'X', name: 'owner' }],
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
    // 文章列表的 #AID 跳文找不到（read.c 的 AID 搜尋）：格式對但沒有這篇 ⇒「找不到這個文章代碼」，
    // 格式錯 ⇒「不合法的文章代碼」；兩者都是 vmsg（按任意鍵）。aid_navigation／long_push_session 認這兩句。
    file: 'aid_miss',
    entry: 'read:Test',
    rows: 24,
    steps: [
      { name: 'list' },
      { keys: '#', name: 'prompt' },
      { keys: '1AAAAAAA\r', name: 'not-found' },
      { keys: ' ', name: 'back' },
      { keys: '#' },
      { keys: '!!\r', name: 'invalid' },
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
    // 主功能表 Ctrl+Z m（menu.c#ZA_Select 的信箱）：信件列表。caption「信件列表」⇒ 列表好讀不得接管
    // （classifyListScreen 只認文章列表 caption）。首頁儀表板的「新信」走這條。
    file: 'mail_list',
    entry: 'menu',
    rows: 24,
    // ^Z 本身不畫東西（等第二鍵），所以跟 m 一起送（同 home_dashboard 的 ZA_MAIL）。
    steps: [{ name: 'menu' }, { keys: '\x1am', name: 'mail' }],
  },
  {
    // 信件列表 ⏎ 讀信（mail.c#mail_read → more()）：跟看板文章同一個 pmore 狀態列 ⇒ pageState 3、
    // 好讀接手；← 離開回信件列表（P31 信箱卡片的延伸：讀信接不接得上好讀）。
    file: 'mail_read',
    entry: 'menu',
    rows: 24,
    steps: [
      { name: 'menu' },
      { keys: '\x1am', name: 'mail' },
      { keys: '\r', name: 'read' },
      { keys: '\x1b[D', name: 'back' },
    ],
  },
  {
    // 編輯器（edit.c）：在自己的文章上按 E ⇒ vedit，底列「 編輯文章 」caption＋右側狀態框
    // （插入／取代、旗標、行:欄）。term_buf.setPageState 靠它認 pageState 6。
    // ^X ⇒ edit.c#write_file 的「檔案處理」：getdata(2, 0, "確定要儲存檔案嗎？ ")，空答案＝[S] 存檔
    // ⇒ 點空白處關框不可以送 ^C（vgetstring 的 ^C 清空送出＝存檔／發文，screen_dismiss）。
    file: 'editor',
    entry: 'read:Mine',
    rows: 24,
    steps: [{ name: 'list' }, { keys: 'E', name: 'edit' }, { keys: '\x18', name: 'save-menu' }],
  },
  {
    // 選看板 prompt 的自動完成（namecomplete）：打 M 再按空白 ⇒ Mine／Movie 兩個候選，列出清單；
    // x 沒有看板以 Mx 開頭 ⇒ bell、字被丟掉；再打 o、空白 ⇒ 唯一的 Movie 補完。
    // board_search_bridge.parseBoardPromptFrame 讀輸入欄與候選。
    file: 'board_complete',
    entry: 'menu',
    rows: 24,
    steps: [
      { name: 'menu' },
      { keys: 's', name: 'board' },
      { keys: 'M', name: 'typed' },
      { keys: ' ', name: 'candidates' },
      { keys: 'x', name: 'rejected' },
      { keys: 'o', name: 'typed-2' },
      { keys: ' ', name: 'completed' },
    ],
  },
  {
    // 文摘（Tab，bbs.c#board_digest）：MODE_DIGEST 讀看板的 fn_mandex，標題列「文摘《板》」、
    // 底列「文摘列表」，編號是文摘自己的（跟搜尋結果一樣是另一個編號空間）。Q 看 AID，開一篇
    // 再 ← 回文摘，文摘上再 ← 是 read_cmd_quit 的 board_digest ⇒ 回完整列表（不是離板）。
    file: 'digest',
    entry: 'read:Gossip',
    rows: 24,
    steps: [
      { name: 'list' },
      { keys: '\t', name: 'digest' },
      { keys: 'Q', name: 'info' },
      { keys: ' ' },
      { keys: '\r', name: 'article' },
      { keys: '\x1b[D', name: 'back' },
      { keys: '\x1b[D', name: 'plain' },
    ],
  },
  {
    // 完整列表上 # 文摘的 AID（G 檔名，type 1）：select_by_aid 在 fn_mandex 找到後只設
    // default_ch=Tab，但 read.c#read_cmd_aid 沒用它 ⇒ 不切文摘、游標不動、也沒有錯誤訊息。
    // 換回原文的 AID（M，toPostAid）才落在原文上。游標先停到 1，看得出有沒有動。
    file: 'digest_aid',
    entry: 'read:Gossip',
    rows: 24,
    steps: [
      { name: 'list' },
      { keys: '1' },
      { keys: '\r', name: 'at-1' },
      { keys: '#' },
      { keys: '5giJk-0-\r', name: 'g-aid' },
      { keys: '#' },
      { keys: '1giJk-0-\r', name: 'm-aid' },
    ],
  },
  {
    // 精華區（z，bbs.c#b_man → announce.c#a_menu）：row 0 是【板主】的選單畫面，開一篇是
    // 精華區文章（pmore，currstat 不是 READING：s／#／推文都不在），← 回精華區、再 ← 回列表。
    file: 'essence',
    entry: 'read:Gossip',
    rows: 24,
    steps: [
      { name: 'list' },
      { keys: 'z', name: 'menu' },
      { keys: '\r', name: 'article' },
      { keys: '\x1b[D', name: 'back' },
      { keys: '\x1b[D', name: 'list-again' },
    ],
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
  {
    // 文章裡的 v（upstream 3c7d9af 實況模式）：driver 沒有 IPC service ⇒ live_toggle 失敗，
    // 狀態列 part2 換成 override_msg「[系統連線服務異常]」；仍是文章頁。
    file: 'article_live',
    entry: 'read:Test',
    rows: 24,
    steps: [{ name: 'list' }, { keys: '1\r' }, { keys: '\r', name: 'article' }, { keys: 'v', name: 'live-failed' }],
  },
  {
    // 文章裡按 y（bbs.c#do_reply）：「回應至 (F)看板 (M)作者信箱 (B)二者皆是 (Q)取消」之類的 getdata。
    file: 'reply_prompt',
    entry: 'read:Test',
    rows: 24,
    steps: [{ name: 'list' }, { keys: '1\r' }, { keys: '\r', name: 'article' }, { keys: 'y', name: 'reply' }],
  },
  {
    // 文章列表 ^P（bbs.c#do_post）：發文前的種類／標題 prompt。
    file: 'post_flow',
    entry: 'read:Test',
    rows: 24,
    steps: [{ name: 'list' }, { keys: '\x10', name: 'post' }],
  },
  {
    // 新格式推文（post.svc 寫回檔案的 "[N] id creation"＋"  內容"，含刪除的兩種）：pmore 在最後一個
    // 「※ 」列之後改畫（comments.c#comment_render_modern_header／comment_render_body_prefix）。
    // 留言色彩主題三種（pmore 設定頁 c 循環）：經典醒目 → 單純易讀 → 典雅邊框（標頭前多「╭ 」／「├ 」、
    // id 與時間之間用 ─ 填）。comment_parse 的新格式認法靠它守。
    file: 'modern_comments',
    entry: 'read:Comment',
    rows: 24,
    steps: [
      { name: 'list' },
      { keys: '\r', name: 'classic' },
      { keys: 'o' },
      { keys: 'c' },
      { keys: 'q', name: 'simple' },
      { keys: 'o' },
      { keys: 'c' },
      { keys: 'q', name: 'bordered' },
    ],
  },
];
