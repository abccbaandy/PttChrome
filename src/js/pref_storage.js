// Preference storage layer (localStorage). Extracted from PrefModal so that
// non-React modules (main.js, pref_sync.js) can read/write prefs without
// importing a component module.

export const DEFAULT_PREFS = {
  // general
  //dbcsDetect    : false,
  enablePicPreview: true,
  enableNotifications: true,
  enableEasyReading: false,
  // List easy reading (v4): accumulate the board article list across pages into
  // one scrollable ASCENDING list (older→newer, like native) so blacklisted rows
  // can be removed entirely (no blank gaps). Engages on entering a board list.
  // Default OFF while the feature matures (same policy as enableEasyReading).
  enableEasyReadingList: false,
  // Target number of VISIBLE (non-blacklisted) rows the background prefetch
  // accumulates before stopping; continuation is demand-driven (navigate near
  // an edge). 0 disables the background fill (current page + demand only).
  easyReadingListPrefetchCount: 200,
  endTurnsOnLiveUpdate: false,
  copyOnSelect: false,
  // 終端機提示音：PTT 送 BEL（^G）時嗶一聲（captcha／棋類／水球等）。預設開啟，
  // 與真實終端機一致；bell.js 有 150ms 節流，連發不會變成噪音。
  enableBell: true,
  antiIdleTime: 0,
  lineWrap: 78,
  // Easy reading: pressing this key jumps to the post bottom and switches back to
  // native mode (so native in-post search '/' becomes usable). Toggle off to let the
  // key fall through to the native terminal instead. Key value is an e.key string.
  easyReadingEndSwitchNative: true,
  easyReadingEndSwitchKey: "F8",
  // AID 跳文後「返回原文」的快捷鍵（e.key 字串）。預設 F9：F 鍵送不到 PTT
  // （term_keyboard 的 KeyMap 沒有它們，keyEventToBytes 回 null），而 Chrome 已
  // 佔用 F1/F3/F5/F6/F7/F10/F11/F12，F8 又給了 easyReadingEndSwitchKey。
  aidNavBackKey: "F9",
  // 「複製本篇連結」（deep link）的快捷鍵。預設 F2：上面那串被 Chrome 佔用的
  // F 鍵之外，F8/F9 又已經給了上面兩個功能，剩下的就是 F2/F4。
  deepLinkCopyKey: "F2",
  // 外部連結被**這個**分頁接手時（人在別的分頁）發出通知：標題閃爍 + 系統通知。
  // 刻意不複用 enableNotifications —— 那個的文案是「啟用水球通知」，而且在
  // App.onData 實際是當「要不要解析水球封包」的閘門在用；騷擾曲線也不同（水球
  // 高頻、可能被刻意關掉；交接低頻且可操作，不通知等於功能靜默失效）。
  // 頁內橫幅提示不受此開關控制（成本為零，且是切回來後唯一的痕跡）。
  deepLinkHandoffNotify: true,

  // Connection proxy: when on, connect through proxyUrl instead of DEFAULT_SITE so
  // users behind a block can reach PTT without installing anything. proxyUrl may be a
  // bare host (a wsstelnet:// scheme and /bbs path are filled in, see main.js) or a
  // full ws(s)telnet:// URL.
  // **空字串 = 用內建的公用 relay**（util.js#DEFAULT_PROXY_HOST，UI 拿它當
  // placeholder）。不把預設值寫進欄位，使用者才能把自訂位址整段刪掉回到預設，而不是
  // 刪成一個「開著卻沒有位址」的空設定。同理見 imgurProxyUrl。
  useProxy: false,
  proxyUrl: "",

  // imgur 圖片快取代理。**預設開**（與上面的 BBS proxy 相反）：imgur 的 CDN 把台灣
  // 流量導到美西，同一張圖 20 次取樣有 4～5 次卡住 9～24 s，代理實測 stall 0/20；
  // 多數人不會去翻設定，預設關等於功能沒人用。median 幾乎不變，賣點是「不再卡住」
  // 不是「更快」。額度的計費單位是**回源次數**（快取命中時 Worker 不執行），加上
  // PTT 熱門文重複率高 ⇒ 100k/day 的消耗遠低於直覺。額度用盡或 Worker 掛掉時
  // srcset 會自動退回 i.imgur.com（見 imgur_proxy.js#imgurCandidates），不會更差。
  // 隱私：代理由專案方持有，會看到「哪個 IP 在看哪張圖」（Worker 不留任何 log），
  // 設定 UI 有明確揭露文字。量測見 docs/imgur-latency-research.md。
  // 空字串 = 用專案方的 Worker（imgur_proxy.js#DEFAULT_IMGUR_PROXY_BASE，UI 拿它當
  // placeholder），理由同 proxyUrl。
  useImgurProxy: true,
  imgurProxyUrl: "",

  // 滑鼠（設定頁的「滑鼠」分頁）。決策層是純函式 js/mouse_regions.js，合約與
  // 舊→新 key 對照見 docs/mouse.md。
  //
  // useMouseBrowsing 是**真正的總開關**：關掉之後移動底色、左鍵、中鍵、滾輪全部
  // 失效（改版前中鍵與滾輪根本不看它，只關得掉一半）。既然它現在管得住全部，
  // 預設就得是 true，否則滾輪翻頁這類本來預設就會動的功能會憑空消失。
  // 文章裡的連結與圖片**不受它影響**，永遠可以點。
  useMouseBrowsing: true,
  // 游標底色。三個 pref 共用同一條渲染管線，決策在 js/cursor_highlight.js：
  //   mouseBrowsingHighlight       滑鼠停留的那一列上底色（需 useMouseBrowsing）
  //   keyboardCursorHighlight      鍵盤操作時把游標所在列上底色（原生：真游標列
  //                                buf.cur_y，只在選單／列表；列表好讀：虛擬游標列）
  //   mouseBrowsingHighlightColor  兩者共用的顏色 index → color.css 的 b1..b15
  // UI 分處兩個分頁（滑鼠那條在「滑鼠」分頁、鍵盤那條與色票在「一般」分頁），
  // 但底層是同一條管線。key 名稱刻意保留 mouseBrowsing 前綴（雖然現在不只滑鼠
  // 用）：改名等於要為本機與 Firestore 兩邊寫遷移，換不到任何行為。
  mouseBrowsingHighlight: true,
  keyboardCursorHighlight: true,
  mouseBrowsingHighlightColor: 2,
  // 游標所在列的**樣式層**（上面三個是「哪一列」的來源層，兩層正交）：
  //   cursorRowBrighten    整列提亮、背景不動 —— 還原 pttbbs e18a7182 的
  //                        grayout(row,row+1,GRAYOUT_COLORBOLD)＝整列 FTATTR_BOLD
  //                        (ESC[1m)。本專案 TermChar.getFg() 就是 bright ? fg+8 : fg，
  //                        所以「提亮一階」＝ q0..q7 換成 q8..q15 的色值（css/color.css
  //                        的 .cursorBrighten）。預設開：不遮住任何字、也不吃掉 PTT
  //                        自己畫的反白色塊，比整片底色安靜。
  //   cursorRowBackground  整列上底色（顏色沿用 mouseBrowsingHighlightColor）。
  //                        預設關 —— 改用提亮之後它變成可選的加強樣式；兩個可以同時開。
  // **為什麼底色要開新 key 而不是把 keyboardCursorHighlight 翻成 false**：
  // readValuesWithDefault 是 {...DEFAULT_PREFS, ...localStorage} 淺層合併，而
  // PrefModal 關閉時整包 writeValues ⇒ 任何開過一次設定頁的人 localStorage 裡已經有
  // 舊 key 的舊值，翻預設對他們完全無效。開新 key 是唯一能讓既有使用者也拿到新預設的做法
  // （本 repo 刻意沒有 pref 遷移機制，見 docs/mouse.md「舊 → 新 key 對照」）。
  cursorRowBrighten: true,
  cursorRowBackground: false,
  // 左鍵：列表點標題欄開文章／進看板 + 文章內點左側離開 + 自訂滑鼠指標圖示。
  // 單一開關，不再是「送 Enter／送右方向鍵」那種按鍵層級的設定。
  mouseLeftClick: true,
  // 防誤觸模式（預設開）：可點區＝底色區，兩者的起始欄由 mouse_regions
  // .clickableColStart 統一決定。
  //   開 列表／選單只有標題（選項）欄可點且只有那一段上底色；文章推文列只有
  //      內容文字可觸發同作者高亮 ⇒ 左側 0-6 欄還給「點一下離開文章」的退出帶
  //   關 整列可點、整列上底色（改版前的行為）
  // 跟著 useMouseBrowsing 走（resolveMouseGates）：總開關關掉時沒有誤觸要防。
  mouseMisclickGuard: true,
  // 功能鍵可點（預設開）：把畫面上的 `[d]刪除` / `(y)回應` 這類提示變成按鈕，
  // 點下去＝送出那個按鍵。只認**單一按鍵**的括號組（解析見 js/footer_keys.js），
  // `(v/V)` `(=[]<>)` 這種多鍵組維持純文字。
  // 跟著 useMouseBrowsing 走（設定頁 disabled，term_view 也一併 gate）。
  mouseFunctionKeys: true,
  // 中鍵：0=關閉 1=貼上 2=左方向鍵。**與舊 mouseMiddleFunction 的值域不同**
  // （舊的 1 是 Enter），刻意不做遷移，見 docs/mouse.md。
  mouseMiddleClick: 0,
  // 滾輪：0=關閉 1=上下頁。舊版有三組設定（素滾／按住右鍵／按住左鍵）× 四種動作，
  // 全部收斂成這一個。文章好讀模式一律交給瀏覽器捲動，不受此設定影響。
  mouseWheel: 1,
  // 滾輪平滑捲動（預設開）：**只影響文章列表好讀模式** —— 那裡的畫面是我們自己
  // 組的 24 列視窗、沒有可捲距離，捲動量與動畫都得自己算（js/wheel_scroll.js ＋
  // js/smooth_scroll.js），畫面停得住半列（render 端的 body 視口）。關掉＝回到
  // 一格滾輪一整頁。原生 24 列模式沒有這個選擇（翻頁在 server 端），文章好讀模式
  // 一律交給瀏覽器原生捲動。
  // 開新 key 而不是把 mouseWheel 擴成三選項：淺層合併 + 既有使用者已存 mouseWheel:1
  // ⇒ 只有新 key 的預設值吃得到（同 cursorRowBackground 那段註解）。
  mouseWheelSmoothScroll: true,

  // displays
  fontFitWindowWidth: false,
  fontFace: "MingLiu,SymMingLiu,monospace",
  fontSize: 20,
  termSize: { cols: 80, rows: 24 },
  termSizeMode: "fixed-term-size",
  bbsMargin: 0,
  // PTT 自己畫了 '>' 游標的畫面（列表／選單）不再疊一個閃爍游標 —— 兩個游標同框是
  // 重複資訊。輸入框／編輯器不走 pttbbs 的 cursor_show，閃爍游標照舊顯示，位置資訊
  // 不會消失，所以預設開。判定見 comment_parse.js#hasServerCursorMark。
  autoHideBlinkCursor: true,

  // 裝置端 AI（Chrome Prompt API）總開關。所有 AI 子功能的生效條件都是
  // `enableAi && <子 pref>`（AND 於 term_view.js 匯總）——關掉即全部停用，但子
  // 選項的值原樣保留，重開就回到先前的組合。UI 在設定的 "ai" 分頁。
  enableAi: false,
  // 好讀「左圖右文」的裝置端 AI 校正。預設關：模型首次使用要下載數 GB，且只有
  // Chrome 有 —— 開啟（且總開關開）後文章頁才會多出 AI 浮動按鈕。
  enableCaptionAi: false,
  // 裸網域的裝置端 AI 複核。預設關，理由同 enableCaptionAi。開啟後只會**減少**
  // 誤連的連結（單向收縮），且依附 enableBareDomainLink。
  enableUrlAi: false,

  // enhanced add-on
  showFloorNumbers: true,
  mergeSameAuthorComments: true, // 好讀：連續同作者推文合併成一段
  highlightAuthorComments: true,
  enableAutoFixUrl: true, // detect & show a repaired link below a broken URL
  // 裸網域（無 scheme、無路徑，如 indiegametw.com）原位變成可點連結。
  enableBareDomainLink: true,
  enableXMentionLink: true, // auto-link @handle to x.com when the X account exists
  // 圖片上傳（urusai 圖床）：拖放／貼上／右鍵選單上傳，成功後把直連網址送進
  // 推文列或編輯器。預設開——只有真的拖檔案進來才會作用，不會干擾既有操作。
  // token 是**本機專屬**（見 pref_sync_logic.js 的 LOCAL_ONLY_PREF_KEYS）：它是
  // 憑證，比照 PTT 密碼不上雲、也不進設定匯出檔。留空＝匿名上傳。
  enableImageUpload: true,
  imageUploadToken: "",

  // 右鍵選單裡兩個小幫手的顯示開關。**預設關**：它們是小眾功能（打 ANSI 色碼、
  // 追 Live 文），卻長年佔著每個人的選單。關掉＝那一項不畫出來；Live 文小幫手的
  // End 鍵 toggle 也跟著失效，因為那條路要先從選單開啟浮層才會掛上去
  // （見 ContextMenu/index.jsx 的 onToggleLiveHelperModalState）。
  enableInputHelper: false,
  enableLiveArticleHelper: false,

  // 長推文一鍵發送（右鍵選單→輸入一大段話，自動依 PTT 單則上限分段依序推出）。
  // 預設開：不點就不會作用，而且 PTT 本來就沒有「一次推一長串」的辦法。
  enableLongPush: true,

  blacklist: "", // newline-separated user ids
  titleBlacklist: "", // newline-separated title keywords (board-list only)

  // 快速搜尋（右鍵選單）。內建項目定義在 quick_search.js#BUILTIN_QUICK_SEARCH，
  // 這裡只存「被停用的內建 id」而不是整份清單：陣列 pref 走 readValuesWithDefault
  // 的淺層合併＝整包覆蓋，一旦把內建塞進來就凍結在第一次寫入的狀態，日後新增內建
  // 項目時既有使用者永遠看不到。
  // Object.freeze 是刻意的：readValuesWithDefault 與 PrefModal 的 onResetClick 都是
  // { ...DEFAULT_PREFS } 淺層複製、陣列共用同一個 reference，in-place push/splice
  // 會污染整個 session 的預設值 → 一律 [...arr] / filter / map。
  quickSearchDisabled: Object.freeze([]), // 內建 id，出現在裡面 = 停用
  // [{ id, name, urlTemplate, match: 'any'|'digits', enabled }]
  // 欄位不可為 undefined：Firestore SDK 遇到會 throw（見 pref_sync.js#savePrefs）。
  quickSearchCustom: Object.freeze([]),
  autoLogin: false,
  autoLoginUser: "",
  autoLoginPassword: "",
  // Base32 TOTP secret for PTT's 2FA (see src/js/totp.js). Empty means either
  // "no 2FA on this account" or "I'd rather type the 6 digits myself" — both
  // end the same way: auto-login fills in account+password and hands the
  // keyboard back at the verification prompt.
  autoLoginOtpSecret: "",
  autoLoginDupConn: "N", // 'Y' | 'N': answer when a duplicate login is detected
  autoLoginSkipWelcome: true,

  // local-only (never synced to cloud — see LOCAL_ONLY_PREF_KEYS in
  // pref_sync_logic.js; UI lives in the "local" prefs tab)
  // Work mode: CSS-only remap of the 16 ANSI colors to muted grays so the
  // screen passes as a mainstream dark-theme web page. Render-layer only.
  enableWorkMode: false
};

const PREF_STORAGE_KEY = "pttchrome.pref.v1";

export const readValuesWithDefault = () => {
  try {
    return {
      ...DEFAULT_PREFS,
      ...JSON.parse(window.localStorage.getItem(PREF_STORAGE_KEY)).values
    };
  } catch (e) {
    return {
      ...DEFAULT_PREFS
    };
  }
};

export const writeValues = values => {
  try {
    window.localStorage.setItem(
      PREF_STORAGE_KEY,
      JSON.stringify({
        values
      })
    );
  } catch (e) {}
  return values;
};

// Auto-login migration (see src/js/auto_login.js): wipe the legacy plaintext
// credentials once the browser credential store has been confirmed to hold
// them. The username goes too — it serves no purpose without the password
// (the browser store supplies both via cred.id/cred.password).
//
// The OTP secret is only dropped when `clearSecret` says the credential we got
// back really carried one. A stored credential that is still a bare password
// (not yet re-packed, see credential_pack.js) means the secret exists on this
// machine ONLY, so clearing it unconditionally would lose it for good.
export const clearLegacyAutoLoginCredential = ({ clearSecret = false } = {}) => {
  const v = readValuesWithDefault();
  const stale =
    v.autoLoginPassword || v.autoLoginUser || (clearSecret && v.autoLoginOtpSecret);
  if (!stale) return;
  writeValues({
    ...v,
    autoLoginUser: "",
    autoLoginPassword: "",
    autoLoginOtpSecret: clearSecret ? "" : v.autoLoginOtpSecret
  });
};
