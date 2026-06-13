# Bug：好讀模式進文章偶發推文截斷（race，未修）

狀態：根因 `unknown`，以下機制 `CONFIRMED`、候選根因 `guess`。對應 `src/js/easy_reading.js` + `src/js/term_view.js`(accumulatePageLines) + `src/js/term_buf.js`(settle)。

## 症狀（CONFIRMED 使用者回報）
- 進文章後**有時只顯示到內文**、底下推文只剩約一則（不確定數量，總之非全部）。
- **重進即正常** → 非特定文章。
- **登入後看的第一篇機率最高**，無法穩定重現 → 時序/race。

## 累積機制（CONFIRMED 讀碼）
好讀進文章(pageState 3)後靠逐幀自動翻頁把整篇累積成長頁：
- `_onChanged` 在游標到末列末欄且該列是狀態列、且**非 100%**（`lastRowFirstChBg!=4`）時設 `sendCommandAfterUpdate='\x1b[6~'`(PageDown)：`easy_reading.js#L59-73`（純邏輯 `nextEasyReadingRowState`）。
- `_onViewUpdated` 實際送出該鍵並清空：`easy_reading.js#L204-213`。
- PTT 重畫 → `term_view.accumulatePageLines` 用 `comment_parse.findPageOverlap` 去重 append 進 `buf.pageLines`：`term_view.js#L814-848`。
- 到底判定：末列首字 `bg==4 && fg==7`（100% 狀態列）→ `reachedPageEnd=true`、停止送 PageDown：`easy_reading.js#L64-66`。
- settle debounce `SETTLE_MS=50`：`term_buf.js#L807-820`；enterEasyReading 在 settle 邊緣重播一輪 render 啟動翻頁迴圈：`easy_reading.js#L257-271`。

## 候選根因（guess，未驗）
1. **send/viewUpdate 脫拍**：`sendCommandAfterUpdate` 送出後被中途（半畫）frame 打斷，該幀 `curY!=lastRow` 或 `!isStatusRow` → `halt`，未再設下一個 PageDown → 翻頁停在中途，pageLines 缺尾。登入後第一篇因跨多個 30ms redraw 視窗、frame 邊界最碎，最易脫拍。
2. **premature settle**：網路卡使畫面中途停 >`SETTLE_MS` → settledPageState 提早升 3 → `enterEasyReading` 在首頁未畫完就重播 → accumulate 基數就缺（見 `docs/easy-reading.md` 退化情形）。
3. **reachedPageEnd 誤置**：`parseStatusRow` 把推文末行（含 `MM/DD HH:MM` 時間戳）誤判為底部狀態列，或某中間行恰好 `bg==4,fg==7` → 提早 `reachedPageEnd=true` 停翻。

## 為何「第一篇」最高（CONFIRMED 同源時序）
未快取、內容大、跨多個 PTT 30ms redraw 視窗 → frame 最碎、settle 邊界最不穩。同源於 `docs/easy-reading.md` 踩坑 #12（已治本的「第一篇走原生」是 prevPageState 被 transient 0 覆寫；本 bug 是累積迴圈提早中止，**不同環節**）。

## Debug 策略
1. `yarn start`、登入、設好讀 pref（localStorage `pttchrome.pref.v1`→`{values:{enableEasyReading:true}}`）。
2. 暫時 log：`_onChanged`/`_onViewUpdated`/`accumulatePageLines` 印 `curY,curX,isStatusRow,bg,fg,sendCommandAfterUpdate,pageLines.length` 與每次送鍵。
3. 登入後反覆進「第一篇」直到重現，比對**正常 vs 截斷**的送鍵/累積序列，定位翻頁在哪一幀停（root 是 1/2/3 哪個）。
4. 對照 `findPageOverlap`（`comment_parse.js#L211-233`）有無把推文段誤判為重疊而跳過 append。

## 守護方向
根因確定後，逐列判斷務必落在純函式 `nextEasyReadingRowState`（`easy_reading.js#L37`）並於 `tests/unit/easy_reading_logic.test.js` 回歸（純邏輯先測，e2e 素材不穩）。若修到渲染/翻頁路徑，提交前必跑 `yarn test:e2e`（`easy-reading.spec.js`+`enhance.spec.js`，見 CLAUDE.md 強制規範）。修完刪本檔。
