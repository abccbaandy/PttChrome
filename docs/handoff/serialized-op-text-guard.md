# 序列化操作進行中：`onTextInput` / `onPasteDone` 缺少守門

2026-08-31 修列表好讀 IME bug 時順帶發現的**對稱缺口**，與該次修法同型但範圍不同，
刻意留給後續 session。

## 事實

送 bytes 給 PTT 的四條使用者入口，只有兩條擋得住「序列化操作在途」：

| 入口 | 位置 | `aidNavigation.active` | `longPush.active` |
|---|---|---|---|
| 鍵盤 | `term_view.js#onKeyDown` `:968` / `:975` | 有（preventDefault＋`flashListHint`） | 有 |
| 滑鼠點功能鍵 | `pttchrome.jsx#onFunctionKey` `:631` / `:638` | 有 | 有 |
| **文字輸入（IME）** | `term_view.js#onTextInput` | **無** | 間接（見下） |
| **貼上** | `pttchrome.jsx#onPasteDone` `:602`（由 `onDOMPaste` `:675` 轉入） | **無** | **無** |

後果與 `docs/easy-reading-list.md` 不變量 12b/12d 逐字相同：bytes 裸走
`view._convSend`，與序列化命令競態（pttbbs typeahead 吞掉中間那幀，
`docs/pttbbs-screen-protocol.md` §2）。長推文更嚴重——整段序列在程式化按
`X` → 型別 → 內容 → `y`，插一個 byte 就打亂配對（`docs/long-push.md`）。

## 狀態旗標

- `CONFIRMED` **AID 跳文期間 IME 送字與貼上都會裸送**。`aid_navigation.js` 完全不碰
  `setModalOpen`，`modalShown` 的來源集合只有 `contextMenu` / `imageUploadPicker` /
  `pasteAlert`（`grep setModalOpen src/js`），所以 `onInput` 開頭那道
  `if (modalShown || contextMenuShown) return` 對它不成立。
- `CONFIRMED` **長推文送出期間 IME 已被間接擋住**。`longPushProgress` 納入
  `components/ContextMenu/index.jsx:173-176` 的 `modalOpen` 推導 → `modalShown=true`
  → `onInput` 早退。**這是巧合式的覆蓋，不是刻意守門**：`onTextInput` 本身仍無條件，
  任何繞過 `onInput` 的呼叫端（含測試、未來的新入口）照樣裸送。
- `unknown` **長推文送出期間貼上是否真的到得了 `onDOMPaste`**。該函式無 `modalShown`
  守門，但 paste 事件要焦點在 `#t` 才會發；進度遮罩開著時焦點歸屬未驗證。
  先驗這一條再決定貼上那半要不要一起修。

## 修法方向

四條入口的守門條件與提示文字完全相同，現在有兩份複製品（`term_view.js` 一份、
`pttchrome.jsx` 一份）。**抽成 `App` 上的單一述詞**再讓四條入口共用，例如
`App.prototype.serializedOpHint()` 回 `null`（可送）或提示字串（吞掉＋
`flashListHint`）。不要再複製第三、第四份——本檔的存在就是複製的代價。

順序建議照 2026-08-31 那次：先寫會重現的紅測試（純邏輯下放 unit），再修。

- `onTextInput` 的守門要放在**列表好讀分派之前**：`ListSession.noteTextInput` 會
  `_enterFunctionMode()`＋排 `native-input`，AID 跳文在途時那本身就是競態。
- `onPasteDone` 同理，放在 `listSession.onPaste` 之前。
- 別動 `onInput` 的 `modalShown` 早退（它守的是別的東西）。

## 測試

- unit：述詞純函式 + 四條入口各一條「在途時不送、有提示」。參考
  `tests/unit/term_view_text_input.test.js`（漏斗分派）與 `tests/unit/list_text_input.test.js`。
- offline e2e：`aid_back_ui.offline.spec.js` / `long_push.offline.spec.js` 已有這兩種
  序列化操作的離線情境，在途時注入一次 `view.onTextInput('測')` 斷言 `__replay.sent`
  不增加即可。

## 相關

`src/js/term_view.js#onTextInput`、`src/js/pttchrome.jsx#onPasteDone`／`#onFunctionKey`、
`docs/easy-reading-list.md` 不變量 12b/12d、`docs/long-push.md`、`docs/deep-link.md`。
