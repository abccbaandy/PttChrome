# 文章列表好讀模式 — 重做交接（v4 藍圖：內容判定＋狀態機＋命令序列化）

## 狀態（CONFIRMED）

- **目標**：看板列表多頁串成 ascending 可捲動長列表（舊上新下、置底文釘底）；黑名單命中**整列真隱藏無空行**；JS 本地導覽（綠條走可見子集）；背景預讀；原生功能（`/`、`v`、發文…）functionMode 整頁 LIVE 直通。
- **歷史**：v3 在 branch `wip/easy-reading-list`（e2e 全綠、**實測不穩、未合 dev**；症狀＝易掉回原生＋進板偶爾版面亂）。該 branch 落後 dev 51 commits，**code 僅供參考、勿 rebase/merge**，可回收物見下；查閱用 `git show wip/easy-reading-list:<path>`。
- **根因一句話**：把虛擬捲動疊在 debounced pageState heuristic 上，且預讀送鍵與使用者導覽並行——pttbbs 的 typeahead 跳繪（見下）保證這會 race，是協定性質不是 bug。
- 本檔＝v4 重做藍圖（研究已完成、佐證齊備），**未動工**。

## 經驗法則 → 穩定規則：已解，讀 `docs/pttbbs-screen-protocol.md`

pttbbs source 逆向完成（全 CONFIRMED file:line），三個 load-bearing 結論：
1. **一鍵一回應**：等輸入前必 refresh+oflush、結尾游標 park 位置確定 → BBS 可當 request/response 用，回應可用**內容謂詞**驗收。
2. **typeahead 跳繪**（`screen.c:310`）：按鍵在途 server 直接不畫 → **機器送鍵必須序列化**（v3 不穩的 source 級解釋）。
3. **frame 邊界不可靠**（OBUFSIZE=3072 拆包＋WS proxy unknown）→ 完成判定不可靠 timing/封包，靠畫面指紋（列表逐列指紋、burst 髒列特徵、游標 park 位置，protocol doc §3-5）。

## dev 地基（比 v3 當時好，直接用）

| 機制 | 位置 |
|---|---|
| settle 去抖動：`SETTLE_MS=50`、`settledPageState`、`pageStateSettled`+`screenSettled` 事件 | `src/js/term_buf.js:13`、`_armSettleTimer` :854-865、`setPageState` :1023-1064 |
| **「settle 只當排程、決策靠內容」成功前例**：文章 functionMode，純函式 `functionModeExitDecision` → resume/leave/stay | `src/js/easy_reading.js`（檔頭 export 純函式版型照抄） |
| redraw 單軌分流（functionMode→native / pageState3→accumulate / else native）；黑名單整列移除 `dropHidden` 已存在 | `src/js/term_view.js` `redraw` :293-388、`src/components/Screen.js` computeAnnotations |
| 鍵盤 gate 單點 | `term_view.js` `onKeyDown` :478-535 |
| 每列 `lineChangeds` 旗標（但被 redraw 逐窗消費，settle 視窗需另累加，見 M2） | `term_buf.js:259`、寫入點 :407-408 |
| offline replay 已支援 list cassette | `tests/e2e/cassettes/cchat-list.json`（僅單 start step） |

## 架構（三原則）

**A. 內容判定**：settle 只決定「何時評估」；「是什麼」靠指紋謂詞。**B. 顯式狀態機**：ListSession 單一擁有者，render/鍵盤讀狀態不猜 pageState。**C. 命令序列化**：機器送鍵走 CommandQueue 一次一個 in-flight。**誤判方向永遠往 native 降級（catch-all 自癒），不往 buffer 掉。**

### 檔案落點
- 新 `src/js/list_session.js`：純函式（unit 守護）＋ class。
  - `classifyListScreen(facts)` → `clean-list|article|menu|prompt|transient`＋boardName。clean-list＝row0 反白標題＋row2 表頭＋entry 區 ≥3 可解析序號列＋**游標 park 在 entry 區 col≤1**＋底列「文章選讀」feeter（protocol doc §3/§5；**勿用 `parseListRow`**——那是看板選單，v3 踩坑）。
  - `classifyListBurst({changedRows,curY,…})` → `cursor-move|page-turn|full-repaint|other`（§4；只做 fast-path 提示，**完成判定一律以最終畫面謂詞為準**，防 proxy 黏包）。
  - `transitionListSession(state,event)` → `{next,actions[]}` 純 reducer，轉移表全枚舉 unit。
  - class `ListSession(core,view,termBuf,queue)`：訂 `screenSettled` → snapshot → facts → classify → reduce → actions。選取以序號 `_selectedNum`；`listRenderMode` 以 bindProperty 掛 term_buf（仿 `easyReadingFunctionMode`）。
- 新 `src/js/command_queue.js`：零依賴（注入 send/timer）。`enqueue({keys, expect(snapshot,facts), timeoutMs, onDone, onFail})`；每 settle 評估 in-flight 的 expect；settle 間有活動 re-arm timeout、硬上限 10s。
- `src/js/comment_parse.js`：移植 wip 四函式（下表）。
- `src/js/term_buf.js`：**M2 唯一擴充**（~8 行）——`_settleChangedRows` Set 在 :407-408 同點 add；`_armSettleTimer` timeout callback 內 dispatch 前凍結 `settleSnapshot = {changedRows, curX, curY, pageState}` 並換新 Set（settle 已定義為內容＋游標皆靜，snapshot 的 cur_x/cur_y 即 park 位置）。與 `lineChangeds` 雙軌互不干擾。
- `src/js/term_view.js`：redraw **只加一個分支**（functionMode 分支後、article 分支前）：`listRenderMode ∈ {buffer,frozen}` → [buffer 時 `accumulateListLines()`] → `_renderScreenLines(buf.listLines, dropHidden=true, …, enhance 帶 pageState:2 覆寫)`；`native`（list functionMode）自然落既有原生分支，**無第三分流**。`frozen`＝開文期間渲染現有 listLines 不 accumulate（治 v3「進出文章瞬間版面亂」）。移植 `accumulateListLines`/`resetListAccumulation`/prepend 捲動錨定/hideCursor。鍵盤：onKeyDown 加一 hook（buffer/frozen → `listSession.onKeyDown`；native 不觸發＝全鍵直通，Enter 問題天生解）。
- 接線：`pttchrome.js` new ListSession；prefs `enableEasyReadingList`/`easyReadingListPrefetchCount`＋PrefModal＋zh/en messages（wip 有現成）。

### 狀態機（idle → active ⇄ functionMode；active → opening → suspended → active）

| 現態 | 事件 | 次態 | actions |
|---|---|---|---|
| idle | settle=clean-list ∧ pref ∧ rows==24 ∧ article-ER 未啟用 | active | seed 本頁、記 boardName、選取＝游標列序號、hideCursor、啟動 fill（入 queue） |
| active | settle=clean-list ∧ 板名一致 | active | accumulate 已在 redraw；queue.onSettle；續預讀 |
| active | settle=clean-list ∧ **板名不一致** | active | rebuild-from-current（防跨板/`s` 跳板序號 aliasing 污染） |
| active | settle=article | suspended | 交棒 article ER（它自己的 settled 2→3 邊緣觸發，零新耦合）；記 restoreNum |
| active | settle=prompt/menu/transient ∧ 非 in-flight 可解釋 | functionMode | **catch-all 自癒**：flush queue、showCursor、native（水球/動態看板/誤判全走這） |
| active | key=導覽(↑↓ jk PgUp/PgDn Home End) | active | 純本地 `moveListSelection`＋demand 預讀；**不送鍵** |
| active | key=Enter/→ | opening | frozen、清綠條、enqueue 開文兩命令 |
| active | key=其他 | functionMode | flush、showCursor、**不 preventDefault**（鍵照送，仿文章 `_enterFunctionMode`） |
| functionMode | settle=clean-list | active | 內容判定 exit；landedNum∈buffer ∧ 板名同 → 覆寫本頁＋重選，否則 rebuild |
| functionMode | settle=article | suspended | 使用者原生開文，article ER 接手 |
| functionMode | settle=menu | idle | 離板 cleanup＋showCursor＋原生 repaint |
| functionMode | settle=prompt/transient | functionMode | stay（鏡像原生） |
| opening | settle=clean-list ∧ 游標=目標序號 | opening | queue 送第二命令（Enter） |
| opening | settle=article | suspended | 交棒；listLines/maps 保留 |
| opening | timeout/意外 | functionMode | 自癒棄開文 |
| suspended | settle=clean-list | active | restore：maps 不重建、重選 restoreNum |
| suspended | settle=menu | idle | cleanup |
| 任意 | pref off | idle | 單一出口 cleanup（仿 `exitEasyReading` 紀律） |

### 命令佇列細節
- **進 queue**：預讀翻頁（`\x1b[6~`/`\x1b[5~`，expect＝clean-list ∧ 游標列序號朝該向動∨不動；不動＝到邊，沿用 v3 已驗證的游標 delta 法）、開文兩段（`String(num)+'\r'` expect 游標=num → `'\r'` expect article）。**序列化後跳序號安全**——v3 踩坑 1（prompt 亂 settle）在 opening 態是預期畫面；**預讀仍不用跳序號**。
- **不進 queue**：本地導覽（零網路）、functionMode 全部按鍵（有意識放棄序列化、以整頁鏡像換正確）。
- **timeout 分級**：預讀 timeout＝視為到邊＋停預讀（良性，不翻模式）；開文 timeout＝自癒 functionMode。flush 時機：進 functionMode/pref off/離板，殘餘回應由原生鏡像吸收。

## Milestones（每步獨立可驗；M6 起 pref 預設 off 護航）

| # | 內容 | 驗證 |
|---|---|---|
| M1 | 移植純函式＋wip unit（下表） | `yarn test:unit` |
| M2 | term_buf settleSnapshot（~8 行） | offline harness 喂 cchat-list.json 斷言 snapshot |
| M3 | classify×2＋reducer＋轉移表全枚舉 unit（facts 取自 replay fixture＋合成 burst） | unit |
| M4 | CommandQueue（fake timers） | unit |
| M5 | 錄製器 list 多 step 擴充（仿 `tests/e2e/tools/record-cassette.spec.js` article hook 版型；`tests/e2e/helpers/replay.js` 門控 map 加鍵）；錄 `cchat-list-nav.json`(start/PgUp×2/PgDn/跳號/開文/返回)＋`cchat-list-prompt.json`(`/` 開/取消) | 錄製跑通＋replay smoke |
| M6 | 最小閉環：idle/active/functionMode catch-all＋本地導覽＋黑名單真隱藏＋term_view 分支/鍵盤 hook＋prefs（**無預讀無開文**） | offline＋人工 |
| M7 | 預讀走 queue＋到邊＋prepend 錨定＋demand 觸發 | offline(nav cassette)＋live e2e 部分＋人工 soak |
| M8 | 開文交棒(frozen/opening)＋suspended/restore＋wip e2e 五案全移植＋**soak 自動化**（進退板×5 斷言模式保持；預讀中連打導覽斷言不掉 native——把 v3 人工重現法變回歸） | `yarn test:e2e` 全綠＋人工掃一輪 |

## 可回收資產（wip branch，e2e 曾綠；行號＝wip 檔案）

| 物件 | wip 位置 | 移植 |
|---|---|---|
| `parseListArticleNum`/`isPinnedListRow`/`recoverCursorArticleNum`/`pageArticleNums`(截斷序號單調修復) | `src/js/comment_parse.js:212/230/256/268` | 直移＋unit（dev 該檔僅 +50 行低衝突） |
| `mergeListPage`/`flattenListBuffer`/`shouldStopListPrefetch`/`moveListSelection`/`nextEasyReadingListState` | `src/js/easy_reading.js:66-165` | 移入新 list_session.js；`nextEasyReadingListState` 改餵 classify 結果 |
| `accumulateListLines`/`resetListAccumulation`/prepend 錨定/hideCursor | `src/js/term_view.js` | 邏輯直移，接點對 dev redraw 現版 |
| unit：comment_parse +110、easy_reading_logic +147 | `tests/unit/` | 直移 |
| live e2e 五案（自動啟用+累積+置底/單向續抓/開文返回/functionMode 搜尋/黑名單 DOM 真移除） | `tests/e2e/easy-reading-list.spec.js`(289 行) | 斷言改讀新狀態機欄位 |
| prefs+messages+PrefModal 片段 | `src/js/pref_storage.js` 等 | 直移 |

**互動層（`_onListKeyDown`/`_onPageStateSettled` 緩解鏈/預讀排程）勿移植**——那正是要換掉的 heuristic 地基。

## 風險與開放問題

1. **snapshot 凍結時序**（最高）：必須在 settle timer callback 內、dispatch 前凍結＋換新 Set，否則 listener 觸發的 notify 污染下一窗；與 `lineChangeds`（redraw 消費）雙軌不得互碰。M2 offline 斷言即為此。
2. **prompt 誤判成 clean-list** → 提早出 functionMode、Enter 被綠條劫持。緩解：feeter 全文＋游標 park col 謂詞＋誤判永遠往 native 掉；M5 prompt cassette 回歸。
3. **timeout 校準**：慢鏈路 false-timeout。緩解：per-settle re-arm＋預讀 timeout 良性化；刻意慢網 soak。
4. **rows≠24**：v1 顯式 bypass（idle 不 engage）；謂詞仍寫 rows-relative。**mouse browsing** buffer 下座標不對應：v1 停用點擊、保留滾輪。
5. **v3 設計 bug 兩則（本次研究新發現，實作時要修）**：(a) pinned map 以 rowText 為 key——推文數變動即生重複列，**改標題欄切片為 key**；(b) `MODE_SELECT`（`/` 篩選）序號是篩選後空間且無置底（protocol doc §3），與主列表 aliasing——由板名一致性＋rebuild 規則涵蓋，soak 必測。

## 踩坑彙整（v3 實證，新架構下的對應）

1. 跳序號叫出 prompt 亂 settle → 僅 opening 態＋序列化下使用；預讀禁用（不變）。
2. 截斷序號（游標離開留 `" 51903"`）→ `pageArticleNums` 單調修復必移植，否則預讀跑向古老文章。
3. `parseListRow` 比對的是**看板選單**非文章列（文章列底列是「文章選讀」）→ clean-list 謂詞用 feeter。
4. 游標列序號反推失敗（`nums[cur_y]==null`）勿當置底文（accumulate 排除 `i===cur_y`）。
5. functionMode 期間全鍵放行含 Enter → native 分支天生成立。
6. 開文/退出/進文章必清綠條 `setCurrentHighlighted(undefined)`，否則 React highlight 跨 render 殘留。
7. 往上 prepend 後 `scrollTop += scrollHeight 增量` 錨定，視窗不跳。
8. debug 前清孤兒 webpack serve（playwright `reuseExistingServer` 會用到 stale bundle）。
9. e2e `attachConsole` 只存不印，要自己 filter+join 印。

## 驗收＝v3 不穩重現法不再重現

1. `yarn start` 進 C_Chat：反覆「進板→←→再進」×5，不掉原生、進板無亂版。
2. 預讀中連打 ↑↓/PgUp（慢網更易觸發），模式保持。
3. functionMode：`/`、`v`、發文進出，回列表乾淨。
（M8 已把 1、2 自動化成 e2e soak；3 靠 live e2e functionMode 案。）
