# `CtrlShiftMap` 的符號鍵送的是 keyCode 不是控制碼（`Ctrl+[` 沒有變成 ESC）

狀態：**已知缺陷，未修**。fork 自 upstream 就是錯的；2026-09-13 修「Ctrl 組合跳過 sync 腿」
時盤到，當時刻意只保證「passthrough 與原生鍵盤路徑送出**同一個** byte」，沒動這張表。

## 現象（CONFIRMED，讀碼）

`src/js/term_keyboard.js` 的 `CtrlShiftMap` 字母部分是對的（`for (i=97..122) map[chr] = i-96`），
**符號部分七個裡有六個填的是舊式 `keyCode`**：

| 鍵 | 現值 | 來源 | 正確控制碼 |
|---|---|---|---|
| `Ctrl+@` | 50 | `'2'` 的 keyCode | 0（NUL） |
| `Ctrl+^` | 54 | `'6'` 的 keyCode | 30（`0x1e`） |
| `Ctrl+_` | 109 | NumpadSubtract 的 keyCode | 31（`0x1f`） |
| `Ctrl+?` | 127 | — | 127（DEL）**唯一正確的一個** |
| `Ctrl+[` | 219 | `'['` 的 keyCode | 27（ESC） |
| `Ctrl+\` | 220 | `'\'` 的 keyCode | 28（`0x1c`） |
| `Ctrl+]` | 221 | `']'` 的 keyCode | 29（`0x1d`） |

送出路徑不做任何轉換：`websocket.js#send` 是
`chunkStr.split('').map(x => x.charCodeAt(0))` 塞進 `Uint8Array` ⇒ **219 原封當成單一
byte `0xDB` 打上線**。兩條入口都吃這張表（`TermKeyboard._onKeyDown` 的 ctrl 分支、
`keyEventToBytes` 的 ctrl 分支），所以原生模式與好讀 passthrough 行為一致地錯。

## 為什麼可能不只是「沒作用」

`guess`：`0xDB`／`0xDC`／`0xDD` 都落在 **Big5 前導 byte 區間**。在列表這種純
`igetch` 分派的畫面，未知鍵走 switch 的 default ⇒ 應該只是被忽略（無害）；但在
`getdata`／`vgets`／編輯器這類**吃文字**的情境，一個孤兒前導 byte 可能把**下一個按鍵**
吞掉當 trail byte。**沒有實測過**，這是本檔第一步該驗的事。

## 動手順序

1. **先量，再改**（`unknown` → CONFIRMED）：用 offline cassette 或真站 guest 測「在
   `getdata` prompt（例如列表按 `/` 搜尋）下按 `Ctrl+]`，接著打一個字，那個字有沒有被吃掉」。
   - 結論若是「PTT 完全忽略、無副作用」⇒ 這題降級成純正確性修補，優先度低，可以只改表
     然後補測試。
   - 結論若是「會吞掉下一個字」⇒ 這是真 bug，值得排。
2. 改 `CtrlShiftMap` 的六個值為上表右欄。
3. **`Ctrl+[` → 27（ESC）要單獨想**：ESC 是跳脫序列的開頭，送出去之後 server 會等後續
   byte（`vtkbd` 的 `KEY_ESC` 分支，`io.c:321`）。現行 219 至少不會讓 server 進入等待狀態，
   改成 27 反而可能引入「按一次 Ctrl+[ 之後下一個方向鍵被吃掉」。**如果 1. 量出來 219 無害，
   就別為了「照 ASCII 正確」去動 `[` 這一格**，只改其餘五個並在原地註解寫明理由。

## 邊界

- 這張表是**兩條路徑共用**的（`docs/easy-reading-list.md` 不變量 12 的
  「判準綁 `keyEventToBytes`＝送出路徑本身」就是靠它），改它會同時動到原生與好讀，
  兩邊都要跑。
- `list_session._beginNativePassthrough` / `board_list_session._beginNativePassthrough`
  有一道 `if (!e.ctrlKey && ... charCodeAt(0) > 127) bytes = u2b(bytes)` 的守門，**存在理由
  就是這張表現在會吐 >127 的值**。六個值改對之後全都 < 32，那道守門的必要性消失——但
  **別順手拿掉**：它同時是「Ctrl 組合的 bytes 一律不過 Big5 轉碼」這個合約的表達，留著
  成本為零。若真要拿掉，`tests/unit/list_keys.test.js` 與 `board_list_session.test.js` 裡
  兩條「Ctrl-] 送 charCode 221」的回歸測試要一起改。
- 補測試：純邏輯，全部下放 unit（`tests/unit/` 現有 `term_keyboard_paste.test.js` 旁邊
  開一支 `term_keyboard_ctrl_map.test.js`，逐格釘住 `keyEventToBytes` 的輸出）。
