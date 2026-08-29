# 長推文一鍵發送

右鍵選單 →「長推文一鍵發送」→ 輸入一大段話 → 依 PTT 單則推文的 Big5 byte 上限自動
分段 → 逐則跑完完整的推文互動送出。撞到冷卻自動等待，全程有進度遮罩與取消。

PTT 端的協定事實（畫面序列、每個字串、冷卻分類）全部整理在
`docs/pttbbs-screen-protocol.md` **§11.3**，**動這個功能前先讀那一節**；本文只寫 client
這側的結構與不變量。

## 檔案地圖

| 檔案 | 責任 |
|---|---|
| `src/js/long_push.js` | 送出端純邏輯：`stripNonBig5` / `big5ByteLength` / `pushMaxBytes` / `splitPushSpans`(+`splitPushSegments`) |
| `src/js/push_screen.js` | **共用**的畫面判讀：`classifyPushScreen` / `detectIpLogged` / `parseVmsgText` / `parseCooldownSeconds`。另一個消費者是圖片上傳（`image_upload.js#decideInsertMode`）⇒ 改這裡要同時想兩邊，也**不准**任一邊自己另寫 regex（分歧實錄見 `docs/image-upload.md`） |
| `src/js/long_push_session.js` | 狀態機（形狀比照 `aid_navigation.js`）：持 `active` 旗標，每一步一個 `CommandQueue` command |
| `src/components/ContextMenu/LongPushModal.jsx` | 輸入框（Textarea ＋ 類型 ＋ 即時則數 ＋ 濾字提示 ＋ >20 則二次確認） |
| `src/components/ContextMenu/LongPushProgressModal.jsx` | 送出中的全版遮罩（真 modal，唯一出口是取消） |
| `src/components/ContextMenu/index.jsx` | gating、handler、`modalOpen` 推導、`longPush.onChange` 掛接 |
| `src/js/pttchrome.jsx` | `new LongPushSession(...)`（與 aidNavigation 共用同一條 CommandQueue）＋ `onFunctionKey` 守門 |
| `src/js/term_view.js` | `onKeyDown` 守門（比照 `aidNavigation.active`） |
| pref | `enableLongPush`，**預設 `true`**，設定 → 一般 → 右鍵選單 |

## 資料流

```
右鍵選單（gating: enableLongPush && buf.pageState===3 && footer!=='mail'）
  → LongPushModal：stripNonBig5 → splitPushSegments(預估 maxBytes) → 即時則數
  → onConfirm({ text已過濾, type })
  → LongPushSession.start()  ── active=true, easyReading._enterFunctionMode(),
                                listSession.beginExternalNavigation()
  → 每則：X → [型別鍵] → 內容+\r → y\r     （全部走 commandQueue.enqueue）
  → onChange(progress) → ContextMenu state → LongPushProgressModal
```

`start()` 的 `maxBytes` 只是**預估**（`pushMaxBytes({ userId: prefs.autoLoginUser })`，
IP 板一律當 true＝較短）。真正的上限在第一次拿到內容輸入列時由畫面校正，**雙向**：
prompt 裡有自己的帳號，畫面上的既有推文列有沒有 IP 欄就決定 base 是 61 還是 46。
校正後 `_recount()` 會更新遮罩上的總則數。

## 位移模型（`_text` / `_offset`）

session 存的是**使用者打的原文**與「已送出到哪個 index」，不是切好的段落陣列。每次要送
就拿 `_text.slice(_offset)` 現切（`splitPushSpans` 回 `{ text, end }`）。三個好處：

- 上限中途變準時，剩下的內容依新上限**重切**（變大會合併、變小會再切），段落不會愈接愈碎；
- 中止／取消時交給剪貼簿的是原文的一段 slice，不是切開又接回去的版本；
- 總則數可以隨時重算。

## 決策表（`push_screen.js#classifyPushScreen` → 動作）

| kind | 判準（底列） | 動作 |
|---|---|---|
| `typeMenu` | 以 `您覺得這篇文章 ` 開頭 | 送**單一 byte** 型別鍵（`1`/`2`/`3`），**不帶 `\r`** |
| `inputPrompt` | `^(推\|噓\|→) <id> *:` 且**無**行尾時間戳 | 送 `u2b(內容)+'\r'`；順便讀 userId 校正上限 |
| `confirm` | 含 ` 確定[y/N]:` | 送 `y\r` |
| `angel` | 含 `要使用小天使匿名推文嗎？` | 送 `n\r`（空 Enter＝匿名 YES） |
| `cooldown` | ◆ 橫幅 ∈ 可等清單 | 送 `' '` 消橫幅 → 遮罩倒數 `waitSec+1s` → 重送 `X` |
| `fatal` | 其他所有 ◆ 橫幅（**含認不得的**） | 中止，剩餘進剪貼簿 |
| `other` | 都不是 | 步驟 1 視為沒回應；`confirm` 之後視為「已離開推文流程」＝該則送出成功 |

## 不變量（改動前必讀）

1. **不用 `fullRepaint`、不用 `probe`**（兩者都送 `\f`）。型別選單是 `vkey()` 取單一 byte，
   非數字一律當「推」——萬一 `\f` 沒被 `io.c#system_key_hook` 完全吃掉，就是在使用者沒選的
   情況下推出去。這個功能會把內容寫進公開看板，**送錯遠比失敗嚴重**，所以逾時直接失敗。
2. **未知畫面一律停手**。在 PTT 上盲送鍵等於亂按快捷鍵。
3. **段末是全形字時少收 1 byte**。`vgetstring` 的 DBCS 保護是
   `c > 0x80 && vkey_is_ready() && len - iend < 3 → vkey_purge()`，Big5 的第二個 byte 常常
   也 > 0x80，踩到就會把後面那個 `\r` **一起清掉** ⇒ 推文停在輸入列、整條序列卡死。
4. **非 Big5 字元一定要先濾掉**（`stripNonBig5`）。`u2b` 對它們回 `'\xFF\xFD'`，`0xFF` 就是
   telnet IAC。**傳輸層已修**（`telnet.js#_sendEscaped` 對資料路徑加倍 IAC，守護
   `tests/unit/telnet_iac.test.js`）⇒ 現在濾掉的理由只剩顯示：那些字 PTT 畫不出來，
   而且使用者不會知道自己打的字被吃了，所以要濾掉**並回報濾了什麼**。
5. **每個 command 都要有 `onFlushed`**（`command_queue.js` 的硬性要求）：queue 被別人 flush
   時若不釋放 `active`，整頁再也收不到鍵盤。
6. **進度遮罩必須是 modal**。使用者在序列途中打字會插進 X → 型別 → 內容 的中間，pttbbs 的
   typeahead 會把中間那幀吞掉。`modalShown` 由 `ContextMenu` 的 render state 推導
   （`showsLongPush || longPushProgress`），**不可手動賦值**。

## 取消

`cancel()` → `queue.flush()` → 依當下底列送收尾鍵，最多 `MAX_ABORT_STEPS(3)` 次：

- 輸入列／確認列 → `\x03`（Ctrl-C：`vgetstring` 清空 + abort ⇒ `getdata` 回 0 ⇒
  `recommend()` 什麼都不寫就 return）
- ◆ 橫幅 → `' '`
- 已回到文章／列表 → 不送任何鍵

型別選單**沒有取消**（任何非數字都會被當成預設值），所以那一步是先進到輸入列再 Ctrl-C 出來。
已經送出的推文收不回來——PTT 沒有這種 API，遮罩上寫明了。

## 尚待 live 驗證

1. 推完落在**文章列表**（上游讀碼的結論）還是**文章**（線上私有 commit 可能不同）。
   設計對兩者免疫；只在「落在 clean-list 且起點是文章」時補一個 `\r` 回去。
2. 反白欄顏色（`docs/pttbbs-screen-protocol.md` §5.1 與 `vgetstring` 相左）⇒ 目前**不靠**數
   反白格反推 `maxlength`。

## 測試

| 層 | 檔案 | 守什麼 |
|---|---|---|
| unit | `tests/unit/long_push_split.test.js` | 濾字、byte 長度、上限公式、分段（含全形餘裕、標點斷點） |
| unit | `tests/unit/push_screen.test.js` | §11.3 每個 PTT 字串一個 case（共用分類器，長推文與圖片上傳都吃它） |
| unit | `tests/unit/long_push_flow.test.js` | 真 CommandQueue ＋ 假 buf/view：鍵序、冷卻、取消、flush、上限校正 |
| unit | `tests/unit/long_push_modal.test.js` | 即時則數、濾字提示、>20 則二次確認 |
| unit | `tests/unit/dropdown_menu_preview.test.jsx` / `pref_modal_context_menu.test.jsx` | 選單 gating、pref 預設值 |
| e2e | `tests/e2e/offline/long_push.offline.spec.js` | 整條鏈（React → session → queue → WS）、遮罩擋鍵盤、取消 |
