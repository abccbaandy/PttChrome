# 跳過進板畫面（board_note_skip）

pref `skipBoardEntryScreen`（預設 true）。實作 `src/js/board_note_skip.js`（檔頭有完整 pttbbs 出處），
unit `tests/unit/board_note_skip.test.js`，offline e2e `tests/e2e/offline/board_note_skip.offline.spec.js`
（素材 `scn-board-note-movie`）。PTT 端序列見 `docs/pttbbs-screen-protocol.md`「進版畫面的完整序列」。

## 合約

- arm：送出出口 `TelnetConnection._sendEscaped → onDataSent → BoardNoteSkip.noteSent`。
  條件＝pref 開 ∧ 無 aidNavigation／longPush／logout 在跑 ∧（row0 是 看板列表／我的最愛／分類看板 標題
  ∧ bytes＝`⏎`/`→`/`r`/`l`，允許前綴 ↑↓（滑鼠點列）與尾 `\f`）∨（row0/1 是「選擇看板」「搜尋全站看板」
  prompt ∧ bytes 以 `\r` 結尾）。
- arm 後**先收到 server 資料（`App.onData → noteRecv`）才判畫面**：進板鍵常在某個 settle 的處理途中送出
  （平滑捲動的 sync-jump `queue.done` → 同輪送開板 `\r`），同一個 settle 輪到我們時看到的是送鍵前的舊看板列表
  （ptt-debug-20261008-215452：arm／disarm 同一毫秒）。
- 之後每個 settle（listener 排在 listSession／boardListSession 之後）跑 `boardNoteDecision`：

| 畫面 | 動作 |
|---|---|
| 末列含「動畫播放中」「暫停播放動畫」 | 送 `q`（唯一不可遮罩的鍵；暫停畫面的任意鍵＝繼續播） |
| clean-list／row 0 是 主選單・看板列表・我的最愛・分類看板・精華文章 標題 | landed ⇒ 解除。**不可用 kind 'menu'**：它也吃「底列是主選單 footer」，而 do_select 只清 row 0/1 ⇒ 板名回顯幀會被誤判落地（live 實錄） |
| 末列「請按任意鍵繼續」（不含 vmsg 的「[按任意鍵繼續]」） | 送空白 |
| kind article（pmore footer） | 送 ← |
| kind prompt ∧ 末列空白 ∧ row0 無《板名》（PMORE_AUTO_EXIT 多頁） | 送 ← |
| 其他（半繪、進板失敗 vmsg） | wait；`ARM_MS`=8s 後解除 |

- 送鍵：CommandQueue kind `board-note-skip`、fullRepaint。expect：landed→done；非動畫的 skip 形→`again`
  （← 之後的 pressanykey）；**動畫幀→false**（送鍵前已在路上的舊幀，重送會落進文章列表）。上限 `MAX_ROUNDS`=4。
  失敗不重試，停在原生畫面。
- `busy`（in-flight）⇒ `serialized_op_gate` 吞使用者鍵；`active`（arm∨busy）⇒ `easy_reading._navActive`
  為真（進板公告是 pmore，否則好讀在 1|2→3 edge 把它當文章開）。
- arm 期間有非我們的資料 bytes（裸 `\f` 除外）⇒ 解除，不搶使用者的鍵。

## 不變量

- **絕不預先送鍵**：`bnote_lastbid` 使同連線第二次進同板沒有進板畫面，預送的鍵會落進文章列表。
- 文章列表 `b`（使用者要看進板畫面）不 arm：不是看板列表畫面。
- 進板失敗的 vmsg 不收（要給使用者看）。
- offline 重放是「一個送出 → 一次餵完」，PTT 分段送達的中間幀（板名回顯）重現不了 ⇒ 那類由 unit 守。
- live helper `gotoBoard` 遇 pass 畫面先等 `boardNoteSkip.active` 落下再判，不跟它搶鍵。
- 錄製檔 `ptt-debug-*` 的首幀常是使用者的我的最愛（帳號個資）：轉素材時首幀要合成，不可原樣入 repo。
