# 編輯器輸入框（P27）

PTT 編輯器（`Ctrl+P` 發文、`y` 回文、寄信）在手機上是縮小的 80 欄格線：字小、不能選取、不能拖游標，
打長文幾乎不可能；桌機用輸入法打長段也容易錯。這個功能在**編輯器畫面**多一個「輸入框」入口，
跳出一般文字框，用系統原生的鍵盤／輸入法／選字／貼上／拼字修正打字，按「插入」把整段送進編輯器游標處。
存檔、離開、上色照舊用原生（`Ctrl+X`、`Ctrl+C`）。

## 檔案地圖

| 檔案 | 責任 |
|---|---|
| `src/js/editor_input.js` | 純邏輯 `editorInputAvailable`／`prepareEditorInsert` ＋ 控制器 `EditorInput`（state／onChange／refresh／open／close／insert） |
| `src/components/EditorInput/` | 桌機：終端機右下角的鈕 `#editorInputChip` ＋ Mantine Modal；手機：MobileSheet（`sheetKey="editorInput"`） |
| `src/js/mobile_toolbar.js` | 手機底部導覽第一格：context `editor`（pageState 6）⇒ `editorInput` 槽 |
| pref | `enableEditorInput`（**預設 `true`**，在 `NATIVE_SAFE_MODE_KEYS` 內），設定 → 一般 |

## 規則

1. **送法＝貼上**：插入走 `App.onPasteDone`（與 `Ctrl+V`／`Shift+Insert` 同一條漏斗：序列化操作在途時擋下、
   `normalizePasteText` 把換行轉成 Enter、`_convSend` 轉碼）。不另開送字路徑。
2. **送之前濾字**：`stripNonBig5`（`long_push.js`，同長推文）濾掉 PTT 畫不出來的字（emoji、控制字元），
   濾掉了什麼在框裡告訴使用者。只剩空白／換行 ⇒ 不送。
3. **只在編輯器（認不出 ⇒ 原生）**：判準是 `term_buf.setPageState` 的 pageState 6（footer caption＋插入／取代
   狀態框兩個要素都要對上），**而且本幀底列仍是編輯器**（`buf.isEditorScreenNow()`）：pageState 會黏住，編輯器裡在底列
   問話的 prompt（^Q 的 vmsg「結束但不儲存 [y/N]?」、跳至第幾行…）不命中任何分支，底下還是 6，那時送字＝替使用者回答
   prompt（首字 y 整篇丟掉）。認不出 ⇒ 入口不出現；框開著時畫面換了（被踢出、存檔離開、跳出 prompt）⇒ 按插入時再判一次，
   不送、框留著、內容不丟。
4. **不改 PTT 畫面位置** ⇒ 不經閱讀紀錄（送的是使用者自己打的字，位置由編輯器游標決定）。
5. **modal**：桌機 Modal 開著時 `setModalOpen('editorInput', open)`，打字不漏給 PTT；手機 MobileSheet 自己管。
   鈕要列進 `App._onUploadLayer`（`isEditorInputTarget`），點鈕不被當成點終端機。

## 測試

- unit：`tests/unit/editor_input.test.js`（可用條件、濾字、插入／不送三種結果）、`tests/unit/mobile_toolbar.test.js`（編輯器槽）。
- offline e2e：`editor_input.offline.spec.js`（真滑鼠點鈕、真鍵盤打字、插入整段送出；開關關無鈕）、
  `mobile_editor_input.offline.spec.js`（工具列 → sheet → 插入）。編輯器畫面取自 `tests/unit/fixtures/ptt_src_screens/editor.json`。
