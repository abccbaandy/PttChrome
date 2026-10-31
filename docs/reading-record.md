# 閱讀紀錄（reading record）

`src/js/reading_record.js`：「使用者眼睛看到的位置」只由這個模組擁有。好讀模式（文章好讀、列表好讀、看板列表平滑捲動）下，使用者看到的畫面常常不是 PTT 的真實畫面。任何會暫時改掉畫面的功能，結束、取消或失敗之後都要把人送回這份紀錄。

**新增或修改「會切到原生／會改畫面」的功能時，一律走這裡**：開始時 `begin(feature)`，結束時 `end(bookmark, outcome)`，並在下面的決策表加一列（`tests/unit/reading_record.test.js` 逐格守護）。不要在功能裡自己採樣 `currentLineIndex` 或存 `_topNum`，也不要自己呼叫 `requestScrollRestore`。

## 模型

三種畫面各一型紀錄，**只存身分與列錨，不存像素**。原因：文章重讀後預覽的高度會變；列表補頁、刪頁之後像素也對不上。

| 型 | 欄位 | 量測（畫面擁有者） |
|---|---|---|
| 文章 | `board`、`lineIndex`（文章的絕對列索引＋列內比例）、`atBottom`、`easy`（好讀或原生 pmore） | `term_view.currentLineIndex`：量節點，所以圖片／預覽高度、手機換行版面、收起的列都算對。反向讀取（End）未接合時 tail 的 srow 換算成 `tailStartLine-1+(srow-J)`：消費端都是從頭重讀後才還原 |
| 文章列表 | `board`（看板身分鍵）、`mode`（`plain`／`select`）、`topNum` 或 `topPinnedKey`、`scrollFrac`（px）、`cursorNum` | `list_session.readingPosition`：視口在 DOM 上就從 scrollTop 現場換算（不改欄位），否則用 session 的錨；idle 時回原生列表的身分 |
| 看板列表 | `variant`、`topNum`、`scrollFrac`、`cursorNum` | `board_list_session.readingPosition` |
| 首頁儀表板 | `key`（面板頂端那張卡片：`board:<板>`／`recent:<板>`）、`offset`（它離面板上緣幾 px）、`scrollTop` | `home_dashboard.readingPosition`：面板畫著才有；不切原生，不凍結 |

`mode`：底列 caption 是「系列文章」或「文摘列表」時為 `select`（MODE_SELECT／MODE_DIGEST，獨立的編號空間，見 `docs/pttbbs-screen-protocol.md` §8）。舊版 caption 一律是「文章選讀」，分不出來，當成 `plain`（已知限制，與重新整理相同）。

手機：列表的列高與一屏筆數取自 `mobile_layout`（卡片模式一筆佔 `LIST_CARD_ROWS` 列，非整數 DPR 有捲動量化），所以錨一律用編號加列內偏移。文章在手機換行版面也只能量節點，不准退回 `scrollTop/chh`。守護：`mobile_list_cards.offline.spec.js`「閱讀紀錄：卡片模式量到的視野頂端」。

## 凍結

畫面擁有者切進原生鏡像的那一刻，呼叫 `freeze(surface)` 交出快照：`easy_reading._enterFunctionMode`、`list_session._enterFunctionMode`、`board_list_session._enterNative`。原因是鏡像期間沒有可捲的視口：文章鏡像那一幀的 redraw 會把 scrollTop 歸零，列表則清掉看板身分、丟掉緩衝。

鏡像期間任何人問「現在在哪」，都拿到那份快照。擁有者一離開鏡像（`_functionMode` 或 `state === 'functionMode'` 不再成立），快照就自動作廢。這一條取代以前散在 aid_navigation、long_push_session、deep_link_controller 三處的「採樣一定要在 `_enterFunctionMode` 之前」註解。

## 交易與決策表

`begin(feature, own?)` 回傳書籤，也就是當下紀錄的副本。畫面擁有者自己發起的交易，可以用 `own` 交出自己的量測（`{ list, listOwner }`）；文章端可以交 `{ view, buf }`。`end(bm, outcome, { only, article })` 依下表分派給畫面擁有者既有的還原器：

- 文章：交給 `easy_reading.requestScrollRestore`／`requestScrollToBottom`，量節點並等累積到位才套用。原生 pmore 的文末改送原生 End；原列沒有入口，不還原。debug 錄製檔 `easyReading.scrollRestore`：`request`／`apply`（target、scrollTop）／`giveup`／`drop`（key、leave）／`settled`（套用 2 秒後實際的 `now` 列）。`readingRecord.begin` 與 `settled` 另帶 `topText`（頂端列前 20 字，`term_view.topRowSnippet`，**只給錄製檔對照、還原不讀**；鏡像快照時為 null）。定位順序：`begin.topText` 不是使用者當時看的那句＝採樣錯；`begin.lineIndex`≈`settled.now` 但 `topText` 不同＝同一索引在重讀後指向別行；apply 對而 `settled.now` 偏＝套用後被推走。
- 列表：`list_session.requestViewportRestore`，存成待還原錨，見下節。
- 看板列表：`board_list_session.requestViewportRestore`。
- 首頁儀表板：`home_dashboard.requestViewportRestore`，存成待還原錨，面板下一次畫出來（或更新完重畫）時套用，那張卡片不在了就不動；收起面板（原生主選單、打字）作廢。

| 功能（feature） | 完成 done | 取消 cancel／失敗 fail |
|---|---|---|
| `long-push` 長推文 | 文章：文末 | 文章：原列 |
| `aid-jump` AID 跳文 | 不還原（目的地就是結果） | 不還原 |
| `aid-back` 返回 | 文章：原列（取自返回錨） | 不還原 |
| `aid-board-pick` 無看板 AID 指定看板 | 不還原（跳文） | 取消：重開原文、文章原列（`reopenPicked` 落地時下）；失敗：不還原 |
| `article-refresh` 文章重新整理 | 文章：`auto`（在文末就黏回文末，否則原列） | 不還原 |
| `deep-link-copy` 複製連結（Q 路徑） | 文章：原列 | 文章：原列 |
| `deep-link-jump` 外部帶進來的連結 | 不還原（出發點推進返回堆疊） | 不還原 |
| `list-refresh` 列表重新整理（F5／工具列／下拉） | 列表：原處 | 列表：原處 |
| `board-list-refresh` 看板列表重新整理 | 看板列表：原處 | 看板列表：原處 |
| `mark-read-before` 前已讀後未讀 | 列表：原處 | 列表：原處 |
| `read-later-list` 列表右鍵／長按稍後再讀（Q 問 AID、空白關框） | 列表：原處 | 列表：原處 |
| `mark-all-read` 設為全部已讀 | 列表：原處 | 列表：原處 |
| `board-search` `s` 看板搜尋（含首頁點看板） | 首頁：原處（回到首頁時）；其餘不還原（換板） | 列表、看板列表、首頁：原處 |
| `article-search` 文章搜尋 | 列表：原處（有結果時落在搜尋結果，編號空間比對不符自動丟棄；找不到時 PTT `vmsg` 後回原列表） | 取消：不還原（零送出）；失敗（prompt 沒開出來）：列表原處 |
| `help-menu` 說明選單（`h`） | 不還原（執行的指令就是目的地） | 離開：列表、看板列表原處 |
| `unread-jump` 跳到第一篇未讀 | 不還原（目的就是移動） | 不還原：停在翻到的那頁（使用者拍板） |
| `list-fast-scroll` 列表快速捲動把手放開 | 不還原（目的就是移動） | 不還原：取消＝零送出；跳號逾時退原生，停在 PTT 給的那頁（同鍵盤數字跳號） |
| `home-favorites` 首頁抓我的最愛（含重新整理／下拉） | 首頁：原處（清單換新後停在同一張卡片） | 首頁：原處（停在 PTT 給的畫面，回到首頁時） |
| `home-mail` 首頁開信箱 | 首頁：原處（從信箱回到首頁時） | 首頁：原處 |
| `split-open` 雙欄閱讀點左欄換文 | 不還原（目的地就是結果） | 不還原：取消＝零送出；失敗停在 PTT 給的畫面（原文已離開） |
| `next-article` 好讀文末點下一篇標題卡 | 不還原（目的地就是結果） | 不還原：同 `split-open` |
| `reconnect-resume` 斷線重連後回到原處 | 文章：`auto`；列表：原處 | 失敗（原文找不到）：列表原處；取消：不還原 |

不在表上的功能或結果，一律不動：未知就停在 PTT 給的位置。

說明選單從畫面認出來就領書籤（不論彈窗接不接管），畫面離開說明選單時交回：在彈窗裡執行某一項或叫小天使是 done，其餘（彈窗的離開、改看原生畫面後自己按 q）都是 cancel。原生畫面裡自己按 ⏎ 執行的項目分不出來，也當 cancel，落點不符時由列表端的比對丟棄。文章裡按 `h` 不經這張表，理由同下一段。

推文、回應這類 functionMode 進出不在表上：仍由 easy_reading 的 `_savedScrollTop`（像素）在同一篇文章內來回，不經過重讀，像素是對的。看板列表的「`<板>` 設為已讀」也不在表上：接管時是原地交易（`_resumeInPlace`），本來就不丟視野；沒接管時是原生畫面，pttbbs 自己會把游標留在原處。

## 盤點：替使用者送鍵、卻不在表上的功能

掃過所有替使用者送鍵的模組。下面這些刻意不經閱讀紀錄，新增功能時對照這份清單判斷：

| 模組 | 不在表上的理由 |
|---|---|
| `board_note_skip.js` 跳過進板畫面 | 只收掉使用者自己進板途中的那張進板畫面，目的地就是使用者要去的文章列表 |
| `board_mark_read.js` 看板列表「<板> 設為已讀」 | 接管時是原地交易（見上一節）；沒接管時畫面本來就是原生，沒有好讀的視野要還原 |
| `logout_session.js` 一鍵登出 | 連線由 server 關掉，沒有可回的畫面（斷線重連也不回自己登出的） |
| `agent_tools.js` AI agent 工具 | 高階工具走 `aid_navigation`（目的地就是結果）；低階 `send_keys` 等同使用者按鍵 |
| `image_upload*.js` 圖片上傳 | 只把網址送進使用者自己開著的輸入欄，不離開畫面 |
| 手機工具列、滑鼠邊緣區、功能鍵按鈕 | 走 `sendKeyAsUser`，就是使用者的按鍵；由各畫面擁有者照一般按鍵處理 |

## 列表的還原：認不出就不還原

列表的還原是**請求**。`requestViewportRestore` 存成 `_pendingViewport`，回好讀的 rebuild（文章列表）或 seed（看板列表）之前，先驗證落點仍是同一份清單：

- 文章列表（`listRecordMatches`）：同板，同編號空間，而且落點游標等於書籤的 `cursorNum`，也就是原生交易沒有移動游標。返回錨（`matchBoardOnly`）只比板與編號空間，因為 `s<板>` 回來時的 server 游標是 getkeep 的 `crs_ln`，不等於列表好讀的本地選取。
- 看板列表（`boardListRecordMatches`）：同變體，游標仍在發起那一列。

驗證過之後，要等錨列**進了緩衝而且捲得到**才套用。rebuild 後緩衝只有落點那一頁，錨常在上一頁；下方列數不夠時，scrollTop 會被 maxScrollTop 夾住。所以期間會為了錨往上或往下補頁，有自己的頁數上限，逾時（10 秒）就放棄。以下情況會作廢待還原錨：使用者按鍵、滾輪、點擊，或 seed／進文章／cleanup。生命週期記進 debug 錄製檔：文章列表是 `listSession.viewportRestore`，看板列表是 `boardList.viewportRestore`，各有 saved、adopted、applied、dropped 四種事件，dropped 會帶原因。

## 身後的列表

使用者從文章列表進了文章，文章裡的操作（AID 跳文與返回、長推文、文章重新整理）會呼叫 `listSession.beginExternalNavigation()`。它把列表停進外部 hold、清掉看板身分，所以之後退回列表一定 rebuild，視野就丟了。

- `beginExternalNavigation` 先把當下的列表紀錄交給 `noteBehindList`。看板身分已經被上一趟清掉時（長推文探路之後的第二次序幕）保留舊的那份。
- 下一次 rebuild 的 `_adoptPendingViewport` 會 `takeBehindList()` 一次性取走，照上面的規則驗證；不符就丟棄。`_cleanup`（真的離開看板）也會丟。
- AID 跳文的返回錨會帶著它（`anchor.list`）。返回落地回到原文時，再用 `noteBehindList` 換回那一份，所以 A → B → 返回 → ← 也回得到原列表的視野。

為什麼不改成「suspended 時不動緩衝」（看板列表的做法）：文章列表的 suspended 狀態對 clean-list 沒有在途序列的守門。外部序列的 `s<板>` 幀會讓它 resume 回緩衝，並在共用佇列排自己的補頁，把 AID 序列截斷。存紀錄再在 rebuild 時還原，是不碰 reducer 的做法。

## 外部導覽的出口

AID 導覽或長推文停在列表時，例如跳文失敗、返回看板錨、找不到原文、長推文取消或失敗，以前列表好讀會永遠卡在原生鏡像，因為 `'external'` hold 永不自動解除（不變量 N1），而且沒有任何出口。現在序列的擁有者在每個結束點呼叫 `releaseExternal()`：`aid_navigation` 的 `_fail`、`_finishGoto`、`_finishAtList`、`_finishRefresh`、落地，以及 `long_push_session` 的 `_finish`、`_preflightDone`、`_preflightFail`。兩個列表 session 的 `endExternalNavigation` 會把 hold 換成 `'passthrough'`，交回靜置探針。

N1 本身沒有變：探針仍然不碰 external，只有序列的擁有者能說「我做完了」。落在文章時，handoff 早就解除了 hold，這一步什麼都不做。

## deep link 的返回

- 人在文章裡：好讀開著，或原生 pmore 有狀態列也看得出看板（`deep_link_controller._inNativePager` → `start(..., { inPager: true })`），走一般的 `start()`。它按 Q 問出本篇 AID 當返回錨。
- 其他情況走 `startExternal()`，出發點取自書籤（`aid_navigation.externalOriginAnchor`）：
  - 完整的文章列表會變成看板錨（帶 `list`）。返回時 `s<板>` 停在列表，列表好讀依錨上的視野還原；原生列表則由 getkeep 把游標留在原處。
  - 搜尋結果或文摘（獨立編號空間）、主功能表、看板列表，都沒有可回的地方。
  - 跳往同一個板也沒有：`#<aid>` 會覆寫該板的 getkeep 游標（與 `nav_history.chooseAnchor` 同一條理由）。

## 斷線重連

`src/js/reconnect_resume.js`。PTT 的 session（含每個板的 getkeep 游標）跟著斷線一起死，重連只能重新導航，所以斷線那一刻向閱讀紀錄領書籤，登入回到主功能表後走 `aid_navigation.startResume`（AID 跳文同一套機器，dir `'resume'`，不碰返回堆疊）。

- 時機：`App.onClose` 呼叫 `capture(loggedOut)`，**必須在** `listSession.disable()`、`aidNavigation.reset()` 之前：前者丟掉看板身分，後者清掉跳文落地的那篇。
- 去哪（`resumePlanFrom`，純函式）：
  - 在文章且知道本篇 AID（`aidNavigation.currentPostAid`：免費網址列，落空用跳文落地記下的那篇；**不按 Q**，斷線當下沒有連線可問）⇒ `s<板>` → `#<aid>` → ⏎，落地照決策表還原列。
  - 在文章但問不到 AID ⇒ 退回那篇所在的列表（列表的板要等於文章的板）。只准用 AID 開文，編號會因刪文漂移。
  - 文章列表 ⇒ `s<板>` → `<編號>⏎`（游標放回那篇，不開文）→ 停在列表，rebuild 時用 `matchBoardOnly` 還原視野。搜尋結果或文摘回到完整列表，不帶編號也不還原視野。
  - 主功能表、看板列表、站內信、精華區 ⇒ 不回。
- 列表 session 在斷線時被 disable 成 idle。`beginExternalNavigation({ fromIdle: true })` 讓它照樣停進外部 hold；否則 `s<板>` 落地那一幀 idle 會直接 seed，採用 server 的預設游標，之後的 `<編號>⏎` 就和本地選取對不上。列表好讀沒開時維持 idle。
- 收手：自己登出不回；這條連線從沒登入過（重連失敗）就保留上一份；登入後離開主功能表、或 deep link 也在等登入（使用者剛給的連結較新）就作廢。`ReconnectResume` 要建在 `DeepLinkController` 之後，同一次 settle 讓 deep link 先跑。
- 開關：pref `reconnectResume`（設定 → 一般「斷線重連後回到原處」，預設開）。關掉時斷線不記，重連途中才關也在出發前作廢，停在主功能表。
- 待回目標平常只在記憶體（同 deep link）；例外是 APK 回收重建與下面的開站接回，兩者都走 localStorage `SNAPSHOT_KEY`。debug 錄製檔記 `reconnectResume.capture／restoreSnapshot／countdown／cancel／dispatch／discard`。

## 開站回到上次的地方

同一支 `reconnect_resume.js`、同一個 `startResume` 與 `'reconnect-resume'` 決策表列，只是書籤存在本機、下次開站才用。手機瀏覽器回收分頁、APK 被系統關掉、使用者自己關掉再開，原生 App 會回到上次的畫面，這裡也一樣。

- 存：`visibilitychange`→hidden 與 `pagehide`（APK 另有 `pttandroid:stop`）呼叫 `saveSnapshot`。只在「已登入、連線中」時存「現在斷線的話要回哪」（`resumePlanFrom`），否則清掉存檔 ⇒ 登出後關掉、還在登入畫面關掉，下次都不會跳走。不上雲。
- 接：開機讀一次就刪（`readSnapshot`）。`bootResumeMode`：APK 回收重建且 `reconnectResume` 開 ⇒ 照舊直接出發；其餘 `resumeLastPlace` 開 ⇒ 計畫帶 `fromOpen`。超過 `SNAPSHOT_MAX_AGE_MS`（12 小時）不接。
- 出發前倒數：登入回主功能表後先顯示底部提示「即將回到上次的地方：<板>…」＋「取消」（`#resumeLastPlace`，`OPEN_RESUME_DELAY_MS`），倒數完再確認一次（連線中、還在主功能表、AID 跳文沒在跑、deep link 沒在等）才 `startResume`。使用者按取消、自己走開（離開主功能表）、倒數中斷線、deep link 登記 ⇒ 一個鍵都不送。提示的滑鼠事件不外傳（`App._onUploadLayer` 認 `isResumeToastTarget`）。
- deep link 進來時以 deep link 為準：同斷線重連的 superseded。
- 開關：pref `resumeLastPlace`（設定 → 一般「開站回到上次的地方」，預設開；會送鍵 ⇒ 在安全模式名單內）。e2e 預設關（同一個 context 重整會自己送鍵），live 的共用 session 也關。

## 測試

| 層 | 檔案 | 守什麼 |
|---|---|---|
| unit | `tests/unit/reading_record.test.js` | 決策表逐格（含首頁欄）、比對規則突變、凍結語意、分派、deep link 返回錨 |
| unit（真 Chromium） | `tests/unit/home_dashboard_ui.test.jsx`「閱讀紀錄」 | 首頁：捲到中段點看板、離開、清單變了回來仍停在同一張卡片；卡片不在了不動 |
| offline e2e（手機） | `mobile_home_dashboard.offline.spec.js`「閱讀紀錄」 | 真觸控捲動 → 點卡片 → 進板 → 回首頁捲回原處 |
| unit（真 Chromium） | `tests/unit/reading_record_list.test.js` | 文章列表：設全部已讀、重新整理、`s` 取消或送出、說明選單離開／執行、文章搜尋找不到／有結果、使用者移過游標、身後的列表、外部 hold 出口（含斷線重連從 idle 停泊）、編號空間 |
| unit（真 Chromium） | `tests/unit/reading_record_board_list.test.js` | 看板列表：重新整理後還原、說明選單離開後還原、認不出、使用者按鍵作廢、外部 hold 出口 |
| unit | `tests/unit/aid_navigation.test.js`「閱讀紀錄」各條、`deep_link_controller.test.js`「原生 pmore 讀文」 | 返回錨帶列表、看板錨返回還原、失敗交回 hold、deep link 從列表或原生 pager 出發 |
| unit | `tests/unit/reconnect_resume.test.js`、`aid_navigation.test.js`「startResume」「currentPostAid」 | 斷線重連：去哪、何時出發、收手條件、鍵序列與落地還原 |
| unit（真 Chromium） | `tests/unit/reconnect_resume_open.test.js`、`reconnect_resume_renderer.test.js` | 開站接回：存檔時機與清除、開機模式、倒數與取消、走開／deep link／斷線作廢；APK 回收重建 |
| unit（真 Chromium） | `tests/unit/list_mark_read_viewport.test.js` | 前已讀後未讀（遷移後行為不變） |
| offline e2e | `scenario_navigation.offline.spec.js`「跳文 → 返回之後，閱讀紀錄記著開文前的列表視野」 | 真 boot 鏈上身後列表的交接 |
| offline e2e（手機） | `mobile_list_cards.offline.spec.js`「閱讀紀錄：卡片模式量到的視野頂端」 | 卡片模式的列表量測 |
| offline e2e（手機） | `mobile_reading_restore.offline.spec.js` | 換行版面＋多分塊長文：讀到中段 → 重讀 → 還原回同一列同一處（合成文章） |
| unit（真 Chromium） | `reading_position_preview.test.js`「反向讀取尚未接合時的採樣」 | tail 列記成絕對列索引 |

列表上原生交易的完整來回（`v` → prompt → `v⏎` → 列表重畫 → 靜置探針 → rebuild → 補頁 → 還原），offline 卷做不出來：cassette 不回應 `v⏎`、`s<板>⏎` 的重讀，所以由上面兩支真 Chromium 的 unit 驅動真的 ListSession／BoardListSession 與功能模組守護。
