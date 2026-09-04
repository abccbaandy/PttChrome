# 長推文一鍵發送

右鍵選單 →「長推文一鍵發送」→ 輸入一大段話 → 依 PTT 單則推文的 Big5 byte 上限自動
分段 → 逐則跑完完整的推文互動送出。撞到冷卻自動等待，全程有進度遮罩與取消。

PTT 端的協定事實（畫面序列、每個字串、冷卻分類）全部整理在
`docs/pttbbs-screen-protocol.md` **§11.3**，**動這個功能前先讀那一節**；本文只寫 client
這側的結構與不變量。

## 檔案地圖

| 檔案 | 責任 |
|---|---|
| `src/js/long_push.js` | 送出端純邏輯：`stripNonBig5` / `big5ByteLength` / `pushMaxBytes` / `splitPushSpans`(+`splitPushSegments`) / `findUrlSpans` |
| `src/js/push_screen.js` | **共用**的畫面判讀：`classifyPushScreen` / `detectIpLogged` / `parseVmsgText` / `parseCooldownSeconds`。另一個消費者是圖片上傳（`image_upload.js#decideInsertMode`）⇒ 改這裡要同時想兩邊，也**不准**任一邊自己另寫 regex（分歧實錄見 `docs/image-upload.md`） |
| `src/js/long_push_anchor.js` | **游標錨定**純邏輯：`articleAnchor` / `captureCursorAnchor` / `checkCursorAnchor` / `findAnchorRowNum` / `subjectMatches`。檔頭有完整的 pttbbs 推導 |
| `src/js/long_push_session.js` | 狀態機（形狀比照 `aid_navigation.js`）：持 `active` 旗標，每一步一個 `CommandQueue` command |
| `src/components/ContextMenu/LongPushModal.jsx` | 輸入框（Textarea ＋ 類型 ＋ 即時則數 ＋ 濾字提示 ＋ >20 則二次確認 ＋ 圖片上傳，見下節） |
| `src/components/ContextMenu/LongPushProgressModal.jsx` | 送出中的全版遮罩（真 modal，唯一出口是取消） |
| `src/components/ContextMenu/index.jsx` | gating、handler、`modalOpen` 推導、`longPush.onChange` 掛接 |
| `src/js/pttchrome.jsx` | `new LongPushSession(...)`（與 aidNavigation 共用同一條 CommandQueue）＋ `onFunctionKey`／`onPasteDone` 守門 |
| `src/js/term_view.js` | `onKeyDown`／`onTextInput` 守門 |
| `src/js/serialized_op_gate.js` | `serializedOpHint(core)`＝**四條送字入口共用**的述詞（`aidNavigation.active` / `longPush.active` → 提示字串，否則 null）。呼叫端負責吞輸入＋`flashListHint`。守護 `tests/unit/serialized_op_gate.test.js` |
| pref | `enableLongPush`，**預設 `true`**，設定 → 一般 → 右鍵選單 |

## 資料流

```
右鍵選單（gating: enableLongPush && buf.pageState===3 && footer!=='mail'）
  → LongPushModal：stripNonBig5 → splitPushSegments(預估 maxBytes) → 即時則數
  → onConfirm({ text已過濾, type })
  → LongPushSession.start()  ── 先取閱讀位置＋文章標頭錨點（ORDER INVARIANT：
                                都要在 _enterFunctionMode() 之前），active=true,
                                easyReading._enterFunctionMode(),
                                listSession.beginExternalNavigation()
  → aidNavigation.resolvePostAid()  ── 免費路徑落空就按 Q（boxOpen ⇒ 送 ␣ 關框）
  → 每則：[守門] → X → [型別鍵] → 內容+\r → y\r （全部走 commandQueue.enqueue）
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

## 游標錨定（為什麼每次按 X 之前都要先驗）

**CONFIRMED（pttbbs source）**：`read_post` 在文章內按 `X` → pmore 回
`RET_DORECOMMEND` → `recommend(ent, fhdr, direct); return FULLUPDATE;`
（`mbbsd/bbs.c:2471-2473`）⇒ **推完必定離開 pager 回到文章列表**。所以：

- **第 1 則**的 `fhdr` 是進文章那一刻 `i_read_key` 傳給 `read_post` 的快取 ⇒ 必定推對。
- **第 2 則起**的 `X` 是**在列表**按的，`i_read_key` 現場取 `&headers[crs_ln - top_ln]`
  （`mbbsd/read.c:1007`）。

而列表游標 `crs_ln` 是 **`.DIR` 的純行號，不綁任何文章身分**
（`include/pttstruct.h#keeploc_t`）：`cursor_pos()` 只做上下界 clamp（`read.c:171`），
`PARTUPDATE` 偵測到篇數變動時也只是 `recbase = -1` 重讀 headers、**`crs_ln` 原地不動**
（`read.c:1198-1221`），唯一修正是 `crs_ln > last_line` 時夾到最後一列。一般刪文
（`common/sys/record.c#delete_record2`）把後面每一筆 index 往前搬、置底區
（`.DIR.bottom` 的虛擬延伸）隨 `bottom_line` 整批位移 ⇒ **同編號 ≠ 同一篇**，
第 2 則就推到別篇（使用者實測，熱門版）。

### 錨點

| 欄位 | 來源 | 用途 |
|---|---|---|
| `aid` / `board` | `start()` 時 `aidNavigation.resolvePostAid()`（免費路徑 → 落空按 `Q`） | `#<aid>⏎` 重新定位（`read.c#select_by_aid`），**權威** |
| `author` / `subject` | `start()` 時從**文章標頭**（`作者` / `標題` 兩行）取 | 列表上唯一比對得到的身分（`bbs.c#readdoent` 只印 編號/型別/推文數/日期/作者/標題） |

**基準一定要在還在文章裡的時候取**：第 1 則落地那一幀已經是 `i_read` 重讀 headers
之後的畫面，游標列可能早就換人，拿它當基準等於把污染當成正確值。文章標頭讀不到時
才退而求其次用**第一次**落地幀採（弱，但比完全不比對好）。

主題比對必須**容忍截斷**：`readdoent` 印標題時
`if (strlen(title) > w) { outns(title, w-2); outs("…"); }`（w = `t_columns - 34`）。

### 決策表（每次要在列表上動游標所指的文章之前 → `_gate`）

| 當下畫面 | 動作 |
|---|---|
| `facts.kind !== 'clean-list'` | 直接進行（人在文章內，X 推的就是當前這篇） |
| clean-list、錨點相符 | 直接進行，**不多送任何鍵** |
| clean-list、還沒有 author/subject 錨點 | 從這一幀採，然後進行 |
| clean-list、對不上或讀不出，**有 aid** | `#<aid>⏎` → 落地是**權威**的 ⇒ 重採錨點 → 進行 |
| clean-list、對不上，**無 aid** 但原篇在同一頁 | `<編號>⏎` → 落地**再驗一次身分**（編號沒有身分保證）→ 進行 |
| 以上皆不成立 / 每則額度（`MAX_RELOCATIONS = 1`）用完 | **中止**，剩餘進剪貼簿，提示「文章位置已變動」 |

`_enqueueReopen`（全部送完後回文章的那個 `⏎`）**套用同一張表**——開錯文章比推錯更糟。

**轉錄文**：內文標頭是**原文**作者、列表上印的是轉錄者 ⇒ 第一次比對必定 `moved`，
靠 `#AID` 定位後重採錨點自癒（`_afterRelocate`），不會每則都重複定位。



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
6. **列表上按 X 之前一律先過 `_gate`**（見上節）。這是唯一擋住「推到別篇」的東西，
   而且它只能**保守**：讀不出身分就當成飄掉，絕不放行。
7. **分段盡量不切斷 URL**。切斷＝PTT 上兩則各一半，圖／連結**永遠開不起來**
   （`url_wrap.js` 那套跨列接合是「讀」別人推文用的，救不了自己送出去的）。
   `BREAK_AFTER_RE` 本來就含 `.` 和 `:` ⇒ 不保護的話，回退找斷點會直接停在
   `https://i.urusai.cc/ab.png` 的 `.` 後面。細節見下面「URL 保護與硬切」。
8. **進度遮罩必須是 modal**。使用者在序列途中打字會插進 X → 型別 → 內容 的中間，pttbbs 的
   typeahead 會把中間那幀吞掉。`modalShown` 由 `ContextMenu` 的 render state 推導
   （`showsLongPush || longPushProgress`），**不可手動賦值**。

## 圖片上傳（`target` 插入模式）

輸入框開著時把自己註冊成 `ImageUploadController` 的插入目標，上傳完的 `url_direct`
就插進 **Textarea 的游標處**。合約與三個入口見 `docs/image-upload.md`；這裡只記
長推文這側的規則：

- **絕不可以是 `send`**：這個 modal 開著時底下的畫面是文章／文章列表，`send` 走
  `App.onPasteDone` → 終端機 ⇒ 網址每個字元都變成列表快捷鍵。`decideInsertMode` 的
  `target` 因此**優先於** `pageState===6` 與 `inputPrompt`，不是並列的第三分支。
- `closeOnClickOutside={false}`：上傳浮層是另一個 React root（`#imageUploadReact`，
  portal 在 body 上），對 Mantine Modal 而言算「點外面」⇒ 少了這行，打了一大段話點
  一下「開啟上傳紀錄」就整段沒了（`LongPushProgressModal` 早就有，這裡當年漏了）。
- 插入前後視情況各補一個空白，讓網址獨立成 token ⇒ `splitPushSpans` 的 URL 保護才
  有機會把它整條留在同一則。
- `enableImageUpload` 關閉時**不註冊**目標、也不出現「插入圖片」鈕。

### URL 保護與硬切（`splitPushSpans`）

`findUrlSpans`（零件與 `url_join.js` 共用 `SCHEME_RE` / `URL_CHAR_RE`，**不另寫 regex**）
算出每條網址的 `[start, end)`，然後：

1. step 1 的硬切點落在某條網址**內部** → 退到該網址的**起點**（整條落進下一則），
   並跳過 step 3 的回退；
2. step 3 回退找斷點時，落在網址內部的位置一律不算斷點。

**例外只有一種**：網址本身就比單則上限長（IP 板＋長 id ⇒ `pushMaxBytes` 可能只有
33 bytes，而 `https://i.urusai.cc/<id>.png` 約 30–34 bytes）。此時網址起點在 `cursor`
之前，退不動 ⇒ 照 step 1 **硬切**繼續前進——退到 `cursor` 等於原地不動，會變成無限
迴圈。使用者 2026-09-02 拍板：**硬切＋事先警告，不擋送出**（`longPushModal_urlTooLong`
的 `Alert`；二次確認那條是給「會跑好幾分鐘」用的，這裡攔下來反而礙事）。

modal 用來判斷的 `maxBytes` 只是**預估**（`pushMaxBytes({ userId: prefs.autoLoginUser })`），
真值在送出時由畫面校正、且雙向 ⇒ 警告會誤報也會漏報，文案一律寫「可能」。

## 取消

`cancel()` → `queue.flush()` → 依當下底列送收尾鍵，最多 `MAX_ABORT_STEPS(3)` 次：

- 輸入列／確認列 → `\x03`（Ctrl-C：`vgetstring` 清空 + abort ⇒ `getdata` 回 0 ⇒
  `recommend()` 什麼都不寫就 return）
- ◆ 橫幅 → `' '`
- 已回到文章／列表 → 不送任何鍵

型別選單**沒有取消**（任何非數字都會被當成預設值），所以那一步是先進到輸入列再 Ctrl-C 出來。
已經送出的推文收不回來——PTT 沒有這種 API，遮罩上寫明了。

## 尚待 live 驗證

1. ~~推完落在文章列表還是文章~~ → **CONFIRMED 落在文章列表**（`bbs.c:2471-2473`
   對 `RET_DORECOMMEND` 一律 `recommend(...); return FULLUPDATE;`，2026-09 使用者
   實測的推錯文災情也印證）。設計仍對兩者免疫；落在 clean-list 且起點是文章時，
   **先過守門**再補 `\r` 回去。
2. 反白欄顏色（`docs/pttbbs-screen-protocol.md` §5.1 與 `vgetstring` 相左）⇒ 目前**不靠**數
   反白格反推 `maxlength`。

## 測試

| 層 | 檔案 | 守什麼 |
|---|---|---|
| unit | `tests/unit/long_push_split.test.js` | 濾字、byte 長度、上限公式、分段（含全形餘裕、標點斷點、**URL 保護與硬切**） |
| unit | `tests/unit/push_screen.test.js` | §11.3 每個 PTT 字串一個 case（共用分類器，長推文與圖片上傳都吃它） |
| unit | `tests/unit/long_push_anchor.test.js` | 身分解析／截斷容忍／兩代游標／置底・刪除列 → 一律不得回 `ok` |
| unit | `tests/unit/long_push_flow.test.js` | 真 CommandQueue ＋ 假 buf/view：鍵序、冷卻、取消、flush、上限校正、**游標守門與重新定位** |
| unit | `tests/unit/long_push_modal.test.jsx` | 即時則數、濾字提示、>20 則二次確認、**插入目標註冊／游標插入／網址過長警告** |
| unit | `tests/unit/dropdown_menu_preview.test.jsx` / `pref_modal_context_menu.test.jsx` | 選單 gating、pref 預設值 |
| e2e | `tests/e2e/offline/long_push_image_upload.offline.spec.js` | 輸入框開著時拖圖 → 網址進 Textarea、**線路上一個 byte 都沒送**、點「開啟上傳紀錄」modal 不關 |
| e2e | `tests/e2e/offline/long_push.offline.spec.js` | 整條鏈（React → session → queue → WS）、遮罩擋鍵盤、取消、**真 `term_buf` → `list_session._collectFacts` → 守門**（游標飄掉時送 `#AID` 而不是 `X`）|
