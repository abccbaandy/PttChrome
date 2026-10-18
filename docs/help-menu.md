# 說明選單好讀（`help_menu.js`／`components/HelpMenu`）

動 `src/js/help_menu.js`、`src/components/HelpMenu/**` 前先讀。

## 為什麼

PTT 2026-10 起（pttbbs `main@908bb063` 的 cmd_t 系列）`h` 說明改成**可點的游標選單**
（`mbbsd/psb.c#cmd_show_help_layers_inner`），看板列表、文章列表、主功能表、閱讀文章（`more.c`）、
編輯器（`edit.c`）共用。舊版是 pmore 顯示的文字檔，文章好讀會把它當長頁接手；新版是分頁的選單
（pageState 判不出，停在上一個值或 0），好讀完全不接手，手機上只剩縮小的 80 欄格線。

好讀開著（pref `enableEasyReading`，**沿用好讀總開關**，不另開 pref）時改由彈窗（桌機）／
bottom sheet（手機）一次列出**全部頁**的指令，點一下＝執行。

## PTT 端事實（讀碼，CONFIRMED）

| 項目 | 內容 | 出處 |
|---|---|---|
| 版型 | row 0 `vs_header(caption, "操作說明 (Help)")`；row 1 反白 `  按鍵 / 標籤 … 功能說明`；row 2.. 每列一項 `  (鍵) 名稱<補到 28 寬>  說明`；底列 footer caption「操作說明」＋多頁時 ` [第 x/y 頁]`＋按鈕＋靠右 `(q/←)離開`，有小天使時多 `(h)小天使` | `psb.c#cmd_show_help_layers_inner`、`psb_help_print_row` |
| 每頁項數 | `t_lines - 3`；起始 `curr = 0`（恆從第 1 頁開始） | 同上 |
| 分頁對齊 | 鍵盤路徑 `base = (curr / rows) * rows`；唯一例外是 server 端滾輪 `base ± 1`（client 送 SGR 才有，pref `mouseServerReport` 預設關） | 同上 |
| 執行 | Enter／→ 回傳 `items[curr].keys[0]`，`bbs_cmd_help` 把它當使用者按的鍵重新派送（`ctx->redispatch`） | `psb.c#bbs_cmd_help` |
| 其餘鍵 | ↑↓（k/p/^P、j/n/^N）、PgUp/PgDn（±rows，夾在範圍內）、Home/`0`、End/`$`、`h`＝小天使、`q`/←＝離開；其他鍵忽略 | 同上 |
| caption | 呼叫端給的（「我的最愛」「文章閱讀」…）⇒ row 0 開頭就是 `【我的最愛】`，**長得像看板列表標題** | `psb.c`、`more.c:166` |

## 流程（`HelpMenuController`，phase：idle／open／leaving／native）

- 每個 `screenSettled`（跳過純本地重繪）解析畫面。認得出且 idle：好讀關著或起點不是第 1 頁 ⇒ `native`
  （這一次交給原生，直到畫面離開說明選單）；否則 `open`。
- **補頁**：還缺頁就送一個 PgDn，等到下一頁的幀才送下一個（一次一個在途，pttbbs typeahead 會吞中間幀）。
  佇列有命令在途（例：看板列表 session 送 `h\f` 的那筆）就延後重試。`FETCH_TIMEOUT_MS` 沒回應 ⇒ 只列已拿到的頁、不重送。
- **執行第 t 項**：`Home → PgDn×⌊t/每頁⌋ → ↓×餘數 → Enter`，與當下游標在哪無關（補頁後游標在最後一頁）。
- **離開**＝`q`、**小天使**＝`h`、**原生畫面**＝收起彈窗（補過頁就送 Home 回第 1 頁），三者都等畫面離開說明選單才回 idle；
  送出之後 server 畫的說明幀（Home／PgDn 的回應）一律不理，不會再彈。
- 合併各頁以身分（鍵＋名稱）去重；中間缺頁就只列到缺頁前（之後的索引不可信）。
- **認不出 ⇒ 原生**：指紋任一要素失配、任一非空白項目列解析不了 ⇒ 整張不認。守護
  `tests/unit/parse_failure_degrade.test.js`「說明選單好讀」。

## UI

- 桌機：Mantine Modal，三欄（鍵／名稱／說明）用 subgrid 對齊；焦點在第一項，↑↓／Home／End 移動、Enter／→ 執行、
  q／←／Esc 離開（同原生鍵位）。開著時經 `App.setModalOpen("helpMenu")` 擋終端機鍵盤。
- 手機：`MobileSheet`（系統返回＝離開），每項兩行、至少 44px 高，不畫鍵盤游標底色與焦點框。

## 入口

- 桌機：照舊按 `h`，或點底列的 `(h)說明` 功能鍵按鈕。
- 手機：底部工具列「更多 → 操作說明」（`mobile_toolbar.js` 的 `help`：底列寫著 `(h)說明`／`(h)按鍵說明` 且游標不在輸入欄才出現；
  主功能表不給，理由同 `contentTools`：sheet 多一列就蓋住整個選單、遮罩點不到，守護 `mobile_sheet.offline`「點遮罩」），
  送 `h`（`sendKeyAsUser`，與實體鍵盤同一條分派）。手機的卡片／好讀文章畫面會收起底列，原生提示點不到。

## 連帶修正

- `board_note_skip.boardEntryArms`：說明選單 row 0 的 `【我的最愛】` 曾被當成看板列表，在說明選單點項目
  （↓…⏎）會誤 arm 跳過進板畫面（2026-10-18 錄製檔 `boardNoteSkip.arm`）。說明選單一律不 arm。

## 閱讀紀錄

從文章列表／看板列表按 `h` 時，列表好讀與看板列表平滑捲動會切原生、丟掉緩衝。說明選單認出來就向閱讀紀錄領書籤
（決策表 `help-menu`），畫面離開說明選單時交回：離開＝回到列表的原處，執行某一項＝不還原。規則見
`docs/reading-record.md`，守護 `reading_record_list.test.js`／`reading_record_board_list.test.js`「說明選單」。

## 守護

- `tests/unit/help_menu.test.js`：實錄兩頁（`fixtures/help_menu_rows.js`）解析、突變、送鍵、控制器流程、誤 arm。
- `tests/unit/help_menu_modal.test.jsx`：元件（桌機／手機）合併列出、點擊、鍵盤、原生畫面、小天使。
- `tests/e2e/offline/help_menu.offline.spec.js`／`mobile_help_menu.offline.spec.js`：合成畫面
  （`helpers/help_menu.js`）走真 boot 鏈、真滑鼠／鍵盤／觸控送出的 bytes。
