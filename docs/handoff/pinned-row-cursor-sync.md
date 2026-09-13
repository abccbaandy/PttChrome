# 置底公告列被選取時無法同步真游標 ⇒ cursor-relative 鍵作用在別列

狀態：**已知限制，未修**。非本次引入——2026-09-13 修「Ctrl/Alt 組合跳過 sync 腿」
（`docs/easy-reading-list.md` 不變量 12）時盤到的剩餘缺口。

## 現象

好讀列表把選取移到**置底公告列**（`★` 開頭、無編號）後，任何 cursor-relative 的鍵都
落在 server 真游標那一列（通常是背景 prefetch 的落點），不是使用者看到的選取列：

| 鍵 | 入口 | pttbbs |
|---|---|---|
| `Ctrl-Q` 查詢作者 | `_beginPassthroughBytes` | `read.c:904` `my_query(headers[crs_ln - top_ln].owner)` |
| `Ctrl-S` / `Ctrl-T` / `Ctrl-D` | 同上 | `read.c:911` / `:957` / `:970` |
| `t` 等 A 類鍵 | `_beginInplaceTransaction` | `read.c` `ToggleTagItem` |
| `←` 離開 | `_beginLeave` | `getkeep` 記的是真游標 ⇒ 下次進板落點也錯 |

完整的 cursor-relative 鍵表在 `docs/pttbbs-screen-protocol.md` §11.7。

## 根因（CONFIRMED）

置底列**沒有文章編號** ⇒ `_selectedNum` 是 `null`（選取改記在 `_selectedPinnedKey`），
而三個入口的 sync 腿都只認編號：

- `list_session.js#_beginPassthroughBytes`：`if (this._selectedNum != null && this._selectedNum !== this._serverNum)`
- `list_session.js#_beginLeave`：`if (num == null || num === this._serverNum)` → 直接跳過
- `list_session.js#_beginInplaceTransaction`：同型

`_enqueueCursorSyncJump` 送的是 `String(num) + '\r'`，走 pttbbs 的 `search_num`
（`stuff.c:189-208`）——它只夾得到最大**編號**文章，**到不了置底列**（同 §11.6 記的
End vs 跳號差異）。所以不是「忘了呼叫」，是這條腿的機制本身沒有置底列的位址。

## 修法方向：複用 `_beginOpenPinned` 已經證明可行的走位序列

`list_session.js#_beginOpenPinned`（:2683）**已經解掉「把真游標停到某個置底列」這件事**，
只是目前把落點直接拿去按 Enter 開文。四腿：

1. `open-pinned-jump`：`String(anchor) + '\r'`，anchor ＝ `bufferEdgeNum(nums, 1)`
2. `open-pinned-end`：`\x1b[4~`（End，`fullRepaint: true`——游標已在底端時 End 零回應），
   在落地幀裡掃出目標置底列的 `curY`，記 `parkY` / `targetY`
3. `open-pinned-step`：逐格 `\x1b[A`／`\x1b[B`，最後一格的 expect **用內容比對驗身分**
   （`pinnedRowKey(rowTexts[stepY]) === key`），不是位置算術
4. `open-enter`：`\r`

⇒ 把 1–3 抽成共用的 `_enqueuePinnedCursorSync(key, onSynced, onFail)`，讓
`_beginOpenPinned` 與上面三個入口共用；`_beginOpen*` 之外的呼叫端在 onSynced 裡接自己的
那一腿。**抽的時候 `_serverNum` 語意要一起想清楚**：它是「最後已知的 server 游標**編號**」，
置底列沒有編號 ⇒ 同步成功後應設成 `null`（而不是留著舊值謊報已同步），並另立一個
「真游標停在哪個 pinnedKey」的欄位，否則下一個鍵又會走錯快路徑。

## 邊界（動手前先讀）

- `docs/easy-reading-list.md` 不變量 12（passthrough 序列是承重部分，三個入口一律共用
  同一份，勿各自複製）與不變量 N6（A 類鍵採用落點時錨不動、只 reveal）。
- **成本**：從 1 腿變 4+N 腿（N ＝ End 落點到目標列的格數），期間畫面 frozen＋吞鍵。
  `_beginOpenPinned` 現行的預算是每腿 250/600/1200（`CMD_PROBE_AFTER_MS` 那組），照抄即可；
  但要確認整串不會撞到 `FROZEN_WATCHDOG_MS`（2500ms）——那是「沒有任何一腿推進」的
  backstop，每完成一腿會 re-arm，所以多腿本身不會踩到，**但別把它改成整串的總預算**。
- `_beginLeave` 這個入口要不要納入值得先想：置底列離開時 `getkeep` 記錯落點的代價
  （下次進板位置不對）vs 多跑 4+N 腿的代價。**可以只修 passthrough／inplace 兩個入口**，
  在本檔記下 `_beginLeave` 刻意不納入的理由。
- 補測試：unit 為主（`tests/unit/list_keys.test.js` 檔末那組 cursor-relative describe
  旁邊加「置底列選取 → 走 pinned sync 序列」），形狀照 `list_command_budget.test.js` 的
  表格式守護補上新腿的 `\f`／預算。

## 先確認再動手

`unknown`：使用者實際上會不會在置底列上按這些鍵？置底公告多半是板規／公告，
`Ctrl-Q` 查它的作者（板主）是合理的，但頻率可能極低。**這條的成本效益比不高**——
若評估後認為不值得，就直接刪掉本檔，並把「置底列不支援 cursor-relative 鍵」從
`docs/easy-reading-list.md` 不變量 12 的「已知限制」升格成 CONFIRMED 的永久合約。
