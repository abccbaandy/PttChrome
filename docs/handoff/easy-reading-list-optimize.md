# 文章列表好讀模式 — 體驗優化（交接）

## 狀態

- v4＋穩定度第一輪已完成並 commit 於 branch `feature/easy-reading-list`（使用者實測：穩定度過關）。架構/不變量必讀：`docs/easy-reading-list.md`。
- 本檔＝四項體驗優化待辦。改 fill/demand 邏輯時注意 offline 測試編排與 runtime 決策耦合（cassette 門控精確序號；見架構文件「素材再錄」段）。

## 待辦（使用者實測回饋）

### 1. 首次進板畫面閃動（預讀造成）
- 症狀：進板後 fill 逐頁 jump+PgUp，每頁 settle 都整列表重渲染＋錨定捲動 → 明顯閃動。
- 方向：初始 fill 降到 2~3 頁（`_startFill` 的 target 改小、或 fill 專用 maxPages≈3；`easyReadingListPrefetchCount` 預設 200 太大），其餘交給 demand。進一步可把 fill 期間渲染節流（accumulate 照做、render 合批）——但 accumulate 目前在 redraw 內，需先解耦，成本較高，先試小 fill。
- 位置：`list_session.js` `_startFill`/`_maybeFill`/`PREFETCH_MAX_PAGES`；`pref_storage.js` 預設值。

### 2. 列表過長卡頓 → 比照原生限制總量
- 症狀：buffer 數百列後每次 redraw 重建整個 lines 陣列＋`computeAnnotations` O(n)＋React reconcile → 卡。
- 方向：cap 總列數（~200-300），**丟棄離目前選取序號最遠端**的條目：在 `flattenListBuffer` 後（或 `accumulateListLines` 內）對 `_listNumMap` evict 超額端。
- 注意交互：(a) evict 的方向要**清該向到邊旗標**（`_edgeUp/_edgeDown`），讓 demand 能重抓被丟的段；(b) 選取/restoreNum 若被 evict → 重選最近可見列；(c) 捲動錨定在頂端 evict 時要反向補償（scrollTop 減去移除高度）；(d) offline 深捲測試的 listLen 斷言要改。
- 位置：`term_view.js#accumulateListLines`、`list_session.js`（旗標/選取）。

### 3. 讀取舊/新文章不即時（到底了才等觸發）
- 主因候選（先驗證）：**滾輪捲動不觸發 demand**——demand 只掛在鍵盤 `_moveSelection`，滾輪是純 DOM 捲動、selection 不動 → 使用者滾到底 buffer 邊緣時什麼都不發生，直到按鍵。
- 方向：(a) `mainDisplay` scroll listener（節流 ~200ms）：視口接近頂/底（例如 <2 頁高）→ `_maybeDemand(direction)`（demand 目前以選取位置判斷，需加「以視口位置判斷」的變體）；(b) `DEMAND_MARGIN` 5 → 10~15；(c) demand 一次鏈 2 頁（onDone 再補一對直到 margin 滿足——`_maybeFill` 已有鏈式前例）。
- 位置：`list_session.js` `_maybeDemand`/`DEMAND_MARGIN`；scroll listener 掛載/卸載跟 renderMode 生命週期（enter buffer 掛、離開卸，防 leak）。

### 4. 置底文 Enter 開啟（目前 no-op）
- 障礙：置底文無序號，跳號開文走不通。
- 建議方案：**序列化相對導航**——置底文永遠緊接在最大序號之後（flatten 保插入序=畫面序）：
  1. jump 到 `bufferEdgeNum(nums, +1)`（最大序號；expect＝park＋目標序號，既有指紋）；
  2. `↓`×(pinned tail 中的位置+1)，每步一命令，expect＝游標 park 移動一列（cursor-move burst 或 curY 變化）；
  3. Enter，expect＝article。
  逐步 expect 下每一步可驗、失敗走既有 open-timeout 自癒。置底通常 ≤5 篇，最多 6-7 個序列化命令，延遲可接受。
- 驗證強化：步驟 2 結束後比對游標列文字與目標 pinned 列（`pinnedRowKey` 相等）再送 Enter，不符即自癒放棄。
- reducer 影響：`open-pinned` 從 no-op 改為 begin-open 變體（`transitionListSession` 轉移表＋unit 全枚舉要同步）；`_beginOpen` 拆出共用的兩段收尾（Enter+article expect）。
- 素材：錄新 list 腳本（jump maxNum → down×k → open → back）供 offline 回歸；README 已知限制段同步移除。

## 驗證基準

每項照慣例：紅燈（unit/offline cassette）→ 修 → `yarn test:unit`＋`yarn test:e2e:offline`＋live `easy-reading-list.spec.js`；體感項（閃動/卡頓）另人工 `yarn start` 掃 C_Chat。
