# 跳到第一篇未讀

入口：桌機快捷鍵（pref `unreadJumpKey`，預設 `F7`，`term_view.onKeyDown`）、手機工具列「更多」→「跳到第一篇未讀」
（`mobile_toolbar` 的 `unreadJump` 旗標）。兩個入口同一支 `src/js/unread_jump.js#UnreadJump.start()`。

## 什麼是「未讀」（讀碼 CONFIRMED，`mbbsd/bbs.c#readdoent`）

列表每列的 cell 8 是 type 字元：`type = isunread ? '+' : ' '`、`isunread == 2`（讀過但有新推文）是 `~`；
有 M 標記時改成 `m`（已讀）／`M`（未讀）／`=`（有新推文），solved 是 `!`／`s`／`S`，tag 是 `D`。

本功能的「未讀」＝ `+` 與 `M`（`brc_unread == 1`）。`D`、`!` 蓋掉了未讀資訊 ⇒ **中性**（不算未讀、也不算已讀）；
列表好讀會藏起來的列（刪除文、鎖文、黑名單：`list_row_filter#isHiddenListText`，見 `docs/list-row-filter.md`）同樣中性，這樣才不會跳到看不到的那篇。其餘（` `、`~`、`m`、`=`…）都是「非未讀」。

## 「第一篇」怎麼判斷：從新往舊

從最新一篇往回讀，記住最後看到的那篇未讀；**連續 `READ_RUN`（5）篇非未讀**＝走進已讀區，記住的那篇就是答案。
只看一篇已讀會被「中間挑著讀過幾篇」騙到，所以要連續。

| 情況 | 結果 |
|---|---|
| 走進已讀區、之前看過未讀 | 跳到那篇 |
| 最新的 5 篇都不是未讀 | 提示「沒有未讀」，停在 End |
| 翻到第 1 篇（PgUp 不再往上：`read_move_cursor` 夾在 1） | 跳到最上面那篇未讀 |
| 翻了 `MAX_PGUP`（20）頁還沒走進已讀區 | 放棄，停在原地 |

## 送什麼鍵（全程原生，畫面照實反應）

`End` → 讀這頁 → 還沒結論就 `PgUp` → 讀這頁 …… → `<編號>⏎`。

- `End`／`PgUp`：`read.c#read_cmd_end`／`read_cmd_pgup`。PgUp 把游標移到 `top_ln - p_lines`，新頁從游標開始，頁與頁不重疊。
- `<編號>⏎`：`read.c#read_cmd_num` → `stuff.c#search_num`（「跳至第幾項」），不受「目標在不在這頁」影響。
- 序列**邊走邊長**：每讀完一頁才 push 下一步；送出路徑是 `article_search.submitSerializedSteps`
  （列表好讀時走 list_session 的 passthrough、原生時走 CommandQueue），兩條都在第 i 步 onDone 之後才讀第 i+1 步。
- 每一步都補 `\f`（`fullRepaint`）：PgUp 已在第一頁、跳號目標就是游標列時 PTT 送零 byte，沒有 settle 只能等逾時。
- 落地判定：End 用 `aid_navigation.endLanded`、PgUp 用 `pageLanded`（同板、游標在條目區、有編號）、跳號用 `numJumpLanded`。
- 在途旗標 `unreadJumpInFlight`（`serialized_op_gate`）：期間使用者的鍵一律吞掉＋提示。

## 只在文章列表

與重新整理同一個判準（`screen_refresh.refreshTargetOf` 的 `article-list`；搜尋結果／文摘不算，編號空間不同）。
其他畫面按快捷鍵：**仍吞掉**並提示——F 鍵本來就送不到 PTT，而 Chrome 的 F7 是「鍵盤瀏覽模式」對話框。

## 手機：`+` 與 `~` 分不出來

卡片次行縮字之後兩個標記一樣小、一樣亮。`render/list_card.js#articleCardMark` 依 cell 8 帶 `data-list-mark`
（`unread`／`updated`），CSS：未讀標記加粗＋`transform: scale`（不佔版面，卡片固定高不變）；`~` 卡片在
已讀低亮（`dimReadList`）開著時調暗一階（0.8，介於已讀 0.6 與未讀之間），游標卡片不調暗。

## 守護

- unit：`unread_jump.test.js`（標記、判定、送鍵序列、收手條件、忙碌）、`mobile_toolbar.test.js`、
  `list_card.test.js`（`data-list-mark`）、`list_card_css.test.js`（放大／調暗的 CSS 契約）。
- offline e2e：`unread_jump.offline.spec.js`（真 F7）。
