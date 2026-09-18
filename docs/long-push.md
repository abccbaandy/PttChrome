# 長推文一鍵發送

輸入一大段話 → 依 PTT 單則推文的 Big5 byte 上限自動分段 → 逐則跑完完整的推文互動
送出。撞到冷卻自動等待，全程有進度遮罩與取消。

**開輸入框之前會先探路**（2026-09）：送一個 X 問 PTT「這篇推得了嗎」，推不了就直接
把 PTT 的原話顯示出來，一個字都不必打。見下面「探路（preflight）」。

**入口有兩個**：右鍵選單的「長推文一鍵發送」，以及**在文章裡按推文鍵（`X`／`%`）**
——後者預設**取代**原生推文（pref `pushKeyOpensLongPush`，見下面「攔截推文鍵」）。

PTT 端的協定事實（畫面序列、每個字串、冷卻分類）全部整理在
`docs/pttbbs-screen-protocol.md` **§11.3**，**動這個功能前先讀那一節**；本文只寫 client
這側的結構與不變量。

## 檔案地圖

| 檔案 | 責任 |
|---|---|
| `src/js/long_push.js` | 送出端純邏輯：`stripNonBig5` / `big5ByteLength` / `pushMaxBytes` / `splitPushSpans`(+`splitPushSegments`) / `findUrlSpans` |
| `src/js/push_screen.js` | **共用**的畫面判讀：`classifyPushScreen` / `detectIpLogged` / `parseVmsgText` / `parseCooldownSeconds`。另一個消費者是圖片上傳（`image_upload.js#decideInsertMode`）⇒ 改這裡要同時想兩邊，也**不准**任一邊自己另寫 regex（分歧實錄見 `docs/image-upload.md`） |
| `src/js/long_push_draft.js` | 草稿暫存（localStorage，**自帶 key、不進 `pttchrome.pref.v1`** ⇒ 推文內容不會被雲端同步／設定匯出帶走）：`readDraft` / `writeDraft` / `clearDraft`。單一份、不綁文章 |
| `src/js/long_push_anchor.js` | **游標錨定**純邏輯：`articleAnchor` / `captureCursorAnchor` / `checkCursorAnchor` / `findAnchorRowNum` / `subjectMatches`。檔頭有完整的 pttbbs 推導 |
| `src/js/long_push_session.js` | 狀態機（形狀比照 `aid_navigation.js`）：**三階段** `preflight` → `armed` → `sending`，每一步一個 `CommandQueue` command。`active`＝線路上有命令在飛、`busy`＝這個功能還握著畫面（含 armed 與冷卻倒數） |
| `src/components/ContextMenu/LongPushModal.jsx` | 輸入框（Textarea ＋ 類型 ＋ 即時則數 ＋ 濾字提示 ＋ >20 則二次確認 ＋ 圖片上傳，見下節） |
| `src/components/ContextMenu/LongPushProgressModal.jsx` | 送出中／探路中的全版遮罩（真 modal，唯一出口是取消） |
| `src/components/ContextMenu/LongPushErrorModal.jsx` | 推不出去時的錯誤框：**PTT 原文照錄** ＋ 來源標示 ＋ 已送出則數 ＋ 剩餘內容（唯讀 Textarea，按了才複製） |
| `src/components/ContextMenu/index.jsx` | gating、handler、`modalOpen` 推導、`longPush.onChange`／`onPreflight`／`onResult`／`onSent` 掛接 |
| `src/js/pttchrome.jsx` | `new LongPushSession(...)`（與 aidNavigation 共用同一條 CommandQueue）＋ `onFunctionKey`／`onPasteDone` 守門 |
| `src/js/term_view.js` | `onKeyDown`／`onTextInput` 守門 |
| `src/js/serialized_op_gate.js` | `serializedOpHint(core)`＝**四條送字入口共用**的述詞（`aidNavigation.active` / `longPush.active` → 提示字串，否則 null）。呼叫端負責吞輸入＋`flashListHint`。守護 `tests/unit/serialized_op_gate.test.js` |
| `src/js/long_push_gate.js` | **攔截推文鍵**的述詞：`isPushKey` / `longPushAvailable`（選單與攔截共用）/ `atPagerStatusRow` / `shouldInterceptPushKey` / `pushGateFacts` |
| pref | `enableLongPush`（**預設 `true`**）＋ `pushKeyOpensLongPush`（**預設 `true`**，從屬於前者），設定 → 一般 → 右鍵選單 |

## 資料流

```
右鍵選單（gating: longPushAvailable）／按 X･% （gating: shouldInterceptPushKey）
  → ContextMenu.openLongPush（= App.openLongPushModal 注入的實作，兩個入口共用）
  → LongPushSession.startPreflight()  ── 回 true ＝ 我接手了這次按鍵
        序幕：取閱讀位置＋文章標頭錨點（ORDER INVARIANT：都要在
              _enterFunctionMode() 之前）→ easyReading._enterFunctionMode()
              → listSession.beginExternalNavigation()
              → aidNavigation.resolvePostAid()（免費路徑落空就按 Q）
        探路：X → classifyPushScreen → 收尾（Ctrl-C／␣）→ [守門] → ⏎ 回文章
              ＋ requestScrollRestore
  → onPreflight(result)
        blocked → LongPushErrorModal（PTT 原文照錄）        【結束，一個字都不必打】
        可以推 → armed（active=false，線路還給使用者）
  → LongPushModal：stripNonBig5 → splitPushSegments(校正過的 maxBytes) → 即時則數
                   ＋ 探路帶回來的事實（禁噓／已被降級成 →／冷卻剩幾秒）
  → onConfirm({ text已過濾, type })
  → LongPushSession.start()  ── **沿用 _armed 的錨點／閱讀位置／AID，不重採**
  → 每則：[守門] → X → [型別鍵] → 內容+RET → y+RET （全部走 commandQueue.enqueue）
  → onChange(progress) → ContextMenu state → LongPushProgressModal
  → 失敗／取消 → onResult → LongPushErrorModal
  → **整段送完** → onSent → clearDraft()（唯一清草稿的時機）
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

| kind | 判準（底列） | 動作 | preflight 時的動作 |
|---|---|---|---|
| `typeMenu` | 以 `您覺得這篇文章 ` 開頭 | 送**單一 byte** 型別鍵（`1`/`2`/`3`），**不帶 `\r`** | **收尾退出**（Ctrl-C ×2）→ 可以推，順便帶回 `booAllowed` |
| `inputPrompt` | `^(推\|噓\|→) <id> *:` 且**無**行尾時間戳 | 送 `u2b(內容)+'\r'`；順便讀 userId 校正上限 | **收尾退出**（Ctrl-C ×1）→ 可以推，帶回「已被降級成 →」與 `userId` |
| `confirm` | 含 ` 確定[y/N]:` | 送 `y\r` | （探路走不到這一格） |
| `angel` | 含 `要使用小天使匿名推文嗎？` | 送 `n\r`（空 Enter＝匿名 YES） | **收尾退出** → 可以推（匿名板），同樣沒有型別選單 |
| `cooldown` | ◆ 橫幅 ∈ 可等清單 | 送 `' '` 消橫幅 → 遮罩倒數 `waitSec+1s` → 重送 `X` | 送 `␣` 消橫幅 → **不算不能推**，把秒數帶回輸入框提示 |
| `fatal` | 其他所有 ◆ 橫幅（**含認不得的**） | 中止，剩餘交給錯誤框 | 送 `␣` 消橫幅 → **不能推**，PTT 原文交給錯誤框 |
| `other` | 都不是 | 步驟 1 視為沒回應；`confirm` 之後視為「已離開推文流程」＝該則送出成功 | （`accept` 擋掉，不會進 done） |

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

## 攔截推文鍵（`long_push_gate.js`）

pref `pushKeyOpensLongPush`（預設開，從屬於 `enableLongPush`）。**在文章裡**按推文鍵
時不把 byte 送給 PTT，改開長推文輸入框。

### 為什麼是三條入口

| 入口 | 路徑 | 攔截點 |
|---|---|---|
| 鍵盤 | `term_view.onKeyDown` → `term_keyboard.onKeyPress` → `view._send` | `onKeyDown`，三道自訂 hotkey 之後、`easyReading._onKeyDown` 之前 |
| 底列功能鍵按鈕 | 元素 `onClick` → `App.onFunctionKey` → `view._send` | `onFunctionKey`，`serializedOpHint` 之後、`noteListNativeInput` 之前 |
| IME | `input` 事件 → `term_view.onTextInput` → `_convSend` | `onTextInput`，`serializedOpHint` 之後、`noteTextInput` 之前 |

三條在應用層**沒有交會點**（唯一匯流在 `telnet.js` 傳輸層，太低），所以各攔一次。
IME 那條非補不可：IME 開著時 keydown 的 `keyCode` 是 229，被 `keyEventFilter` 擋在
`onKeyDown` 之外 ⇒ 少了它，「中文輸入法開著按 X」會得到原生推文（`easy_reading.js`
`noteTextInput` 的註解早就把這個情境列為 case (a)）。

### 判準（`shouldInterceptPushKey`）

`isPushKey` ∧ 無 ctrl/alt/meta ∧ `pushKeyOpensLongPush` ∧ `longPushAvailable` ∧
`atPagerStatusRow`。四個容易踩的點：

1. **`X` 與 `%` 都要攔，小寫 `x` 不可以**。`more.c:90-93` 只有這兩個 case 回
   `RET_DORECOMMEND`；`x` 在 pager 沒綁定、在文章列表是 NULL、在信件列表是轉寄。
   底列 `(X%)推文` 被 `footer_keys.tokenizeKeyGroup` 拆成**兩顆**按鈕，漏掉 `%`
   就會變成「點這顆是長推文、點旁邊那顆是原生」。
2. **`shiftKey` 絕不可列入排除條件** —— `X` 與 `%` 本來就要按 Shift，一加整個功能失效。
3. **`pageState === 3` 會過期**。`term_buf.setPageState` 沒有 reset 分支，prompt 幀
   （`s` 切板／`/` 搜尋／`#` 打 AID，底列被 prompt 蓋掉且非空）三條判斷全不命中 ⇒
   沿用上一幀的 3。所以要加 `atPagerStatusRow`（＝ `setPageState` 判 READING 用的
   同一個 `parseStatusRow`，不是第二套判準），否則按 `s` 打 `XBOX` 的第一個字會被
   吞去開輸入框。**不可**改用 `parsePagerFooterContext === 'reading'`：那個推論只能
   單向（part3 會整段消失）。
4. **文章列表（`pageState 2`）刻意不攔**，即使 `bbs.c:4595` 那裡按 X 也是推文：
   `start()` 的錨點要從**文章標頭**取（見上一節），在列表上取不到 ⇒ 攔了等於拆掉
   唯一擋住「推到別篇」的機制。

`longPushAvailable` 是**選單顯示條件與攔截共用的同一個函式**（`ContextMenu/index.jsx`
直接呼叫它），兩處不可能分歧。刻意的不對稱只有 `atPagerStatusRow`：攔截更嚴格，因為
**吞掉按鍵比多畫一個選單項嚴重**，而攔不到的退化結果就是原生推文＝今天的行為。

### 開輸入框的橋接

`App.prototype.openLongPushModal`，預設 `noop`，由 `ContextMenu` 的 `useEffect` 注入
真實作（比照 `onToggleLiveHelperModalState`）。**回傳值就是合約**：`true` ＝
**我接手了這次按鍵**，呼叫端才可以 `preventDefault()`／不送 byte。ContextMenu 還沒
mount、已 unmount、以及 `startPreflight` 接不下來（線路上已經有別的序列化操作）都回
falsy ⇒ 三條入口自動退回原生推文。

**`true` 不等於「輸入框已經開了」**（2026-09 起）：接手之後先跑探路，輸入框或錯誤框
要等答案回來才開，中間蓋一層遮罩。線路上仍然只有那一個 X。右鍵選單那條入口拿到
falsy 時要 `flashListHint` 說一聲——吞掉動作又沒反應是這個功能最嚴重的失敗模式。

`maxBytes` 在**開輸入框那一刻**現算（`pushMaxBytes({ userId: prefs.autoLoginUser })`）
——攔截這條沒有「開右鍵選單」那一刻，沿用開選單時算好的值會拿到保守預設，則數高估。

### 探路（preflight）

**2026-09 推翻了這一節原本的結論**（舊文寫的是「接受，不做事前偵測」）。

#### 為什麼問得到

`mbbsd/bbs.c#recommend()`（2812-2941）的**每一種**擋人判斷都在 `getdata` 讀內容
**之前**做完，而且一律 `vmsg`/`vmsgf` 印 ◆ 橫幅後 `return FULLUPDATE`：

| 擋人條件 | 出處 | 訊息（原文） |
|---|---|---|
| `BRD_NORECOMMEND` ／ `L` 開頭檔名 ／ 已解決的標記文 | bbs.c:2845 | `抱歉, 禁止推薦` |
| `CheckPostPerm2` 不過 ／ guest | bbs.c:2850 | `無法推文: <reason>` |
| `BN_ONLY_OP_CAN_ADD_COMMENT` | bbs.c:2862 | `本板推文限定管理人員使用。` |
| 已刪除文 | bbs.c:2870 | `本文已刪除` |
| `get_board_restriction_reason` | bbs.c:2884 | `未達看板發文限制: <msg>` |
| `BRD_NOFASTRECMD` | bbs.c:2894 | `本板禁止快速連續推文，請再等 N 秒` |
| 同一分鐘 > 60 則 | bbs.c:2913 | `系統禁止短時間內大量推文` |
| 檔案 > 5MB ／ > 100KB 的 10 秒冷卻 | bbs.c:2924 / 2931 | `檔案太大…` ／ `本文已過長, 禁止快速連續推文…` |
| `check_cooldown` | bbs.c:4344 | `冷靜一下吧！…` ／ `您被設退文！…` ／ `間隔太近囉！…` |

⇒ **送一個 X 就問得到答案**，而且答案是 PTT 自己的字。

#### 為什麼可以白按一次

| 事實 | 出處 |
|---|---|
| `lastrecommend = now` 只在**成功寫檔之後**才更新 | bbs.c:3144 |
| `check_cooldown()` 是唯讀的（只有 `diff<0` 時清 bit） | bbs.c:4344-4376 |
| 唯一的足跡：`recommend_in_minute++` 在所有檢查**之前**（上限 60/分鐘） | bbs.c:2905-2914 |

所以探路的 X ＋ Ctrl-C **不會**害真正送出時被降級成 →、也不會把冷卻計時器往後推。

#### 舊結論為什麼不成立

舊文說「先送一次 X 再取消等於在使用者決定之前就動線路」——**使用者已經按了 X**，
那個 byte 本來就要上線；攔截只是把它從「直接轉送」換成「交給 CommandQueue 送、
並讀回答案」。線路上仍然只有那一個 X，淨效果與原生按 X 一致（原生被擋也是看到
◆ 橫幅並回到文章列表，我們還多按一個 ⏎ 幫他回原文章、還原閱讀位置）。

#### 旁證

BePTT（`3rd_script/BePTT`，7.1.6 的 `classes.dex` 字串常數）內含「無法推文」「抱歉」
「禁止快速」「按任意鍵繼續」等**畫面字串的硬比對** ⇒ 同一條路（解析終端機畫面）是
client 端唯一解法，沒有別的 API。

#### 三階段與交棒

| 階段 | `active` | `busy` | 線路 | 畫面 |
|---|---|---|---|---|
| `preflight` | true | true | 我們的命令在飛 | 探路遮罩 |
| `armed` | **false** | true | **空著**（使用者在打字） | 輸入框 |
| `sending` | true | true | 我們的命令在飛 | 進度遮罩 |

`armed` 的 `active` 必須是 false，否則 `serializedOpHint` 會吞掉使用者正在打的字；
但 `busy` 必須是 true，否則 `easy_reading._wireBusy()` 會讓自動翻頁插進線路——探路
收尾按 ⏎ 回文章那一幀正好會讓 `functionMode` 退出，等於把翻頁重新打開。

#### 錯誤訊息一律原文透傳

`classifyPushScreen` 的 `message` 就是畫面那一行（已剝掉 `◆` 與 `[按任意鍵繼續]`），
`LongPushErrorModal` **不做任何字串處理、不對照翻譯、不套自己的說法**，只在下面用
一行 dimmed 小字標示「這句話是 PTT 說的」還是「這是本程式的判斷」。理由：PTT 的擋人
訊息會隨站方設定與版本變（`無法推文: <reason>` 的 reason 更是動態的），任何硬寫的
對照表都會在改版那天靜默壞掉。守護：`tests/unit/long_push_error_modal.test.jsx`
（含一條「沒看過的新訊息也照樣轉達」）與 `long_push_preflight.test.js`。

本程式自己的判斷（逾時、畫面已變更、文章位置已變動…）集中在
`long_push_session.js` 的 `MSG` 常數，**刻意不 import i18n**（會把整包語系表拉進
unit test 的冷載入成本）；錯誤框的外框文案才走 i18n。

### 型別配色（`PUSH_TYPE_COLOR`）

輸入框的「推／噓／→」比照 PTT 原生。pttbbs 裡有**兩組不同的配色**，別拿錯：

| 出處 | 推 | 噓 | → | 用在哪 |
|---|---|---|---|---|
| `bbs.c:2822-2826` `ctype_attr` | `1;33` 亮黃 | `1;31` 亮紅 | `1;37` 亮白 | 型別選單（`bbs.c:2993`）＋推文輸入列前綴（`bbs.c:3085`） |
| `comments.c:21` `ctype_attr2` | `1;37` 亮白 | `1;31` 亮紅 | `1;31` 亮紅 | 寫進檔案、文章裡看到的推文列（`FormatCommentString`） |

採用**前者**（`ctype_attr`）：這個浮層取代的就是那個型別選單，而且三色互不相同。
term.ptt.cc 送來的實錄（`ptt-debug-20260917-221112` t=9736，`\e[1m` 已開著所以選單上
只補 `33`／`31`）：

```
您覺得這篇文章 [33m1.值得推薦 [31m2.給它噓聲 [0;1;37m3.只加→註解 [m[1]?
```

色碼取 `term_buf.js#termColors` 的 bright 槽位 11/9/15（＝終端機自己畫出來的同一份），
常數放在 `long_push.js`（純邏輯，**不 import `term_buf`**，避免 DOM 耦合的大模組進到
每個 unit test 的冷載入），一致性由 `tests/unit/long_push_type_color.test.js` 守。

呈現成**黑底小色塊**而不是單純把文字染色：Mantine 的色彩主題可切（設定頁），亮色主題
下亮黃與亮白等於看不見；黑底同時解決可讀性與「跟終端機長得一樣」。禁噓板時「噓」那一項
是 `disabled`，**不上色**——內聯 `color` 會蓋掉 Mantine 用來表示 disabled 的調暗樣式。

## 不變量

1. **推文流程之內不用 `fullRepaint`、不用 `probe`**（兩者都送 `\f`）。型別選單是 `vkey()` 取單一 byte，
   非數字一律當「推」——萬一 `\f` 沒被 `io.c#system_key_hook` 完全吃掉，就是在使用者沒選的
   情況下推出去。這個功能會把內容寫進公開看板，**送錯遠比失敗嚴重**，所以逾時直接失敗。
   界線是「**推文流程之內**」：人在列表／文章時沒有 `vkey()` 在等單一 byte，
   `longpush-orient` 與 `longpush-relocate-*` 用 `fullRepaint` 是既有且安全的作法。
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
   （`showsLongPush || longPushProgress || longPushError`），**不可手動賦值**。
   交棒那一瞬間（探路完 → 開輸入框／錯誤框）必須落在**同一次 `update()`**，否則
   `modalShown` 會 true→false→true，中間那一幀終端機會把焦點搶回隱藏 input `#t`。
9. **攔截時不可以提前 `_enterFunctionMode()`**。那個函式結尾的同步 redraw 會把
   `mainDisplay.scrollTop` 歸零，而序幕的 ORDER INVARIANT 要在那之前用 scrollTop
   算閱讀位置、並讀文章標頭錨點 ⇒ 提前進入＝送完回不到原閱讀位置。這就是三個
   攔截點都排在各自分派鏈**最前面**的原因（`startPreflight()` 自己會在正確時機
   呼叫它）。
10. **沒接手就不准 `preventDefault()`／吞 byte**。順序永遠是「先接手成功、再吞」，
    見上面的橋接合約。吞掉按鍵又什麼都不做＝使用者按 X 完全沒反應，是這個功能最嚴重
    的失敗模式。
11. **ORDER INVARIANT 的採樣權屬於 `startPreflight()`**：閱讀位置、文章標頭錨點與
    **AID** 都只在那裡採一次，`start()` 一律沿用 `_armed`、**絕不重採**（那時畫面早就
    進過 functionMode，scrollTop 已歸零、游標列可能換人，重採等於把污染當成基準）。
    AID 尤其不能留到 `start()`：`aid_navigation.findLocalPostAid` 要 `pageState === 3`，
    那時人可能已經在列表上，免費路徑必落空 ⇒ 退回按 `Q`，而在列表按 Q 是別的功能。
12. **`armed` 期間 `active` 必須是 `false`、`busy` 必須是 `true`**。前者是因為線路
    真的空著、使用者正在打字（`serializedOpHint` 吞掉他的鍵就是 bug）；後者是因為
    `easy_reading._wireBusy()` 只看 `inFlightKind` 會漏掉這段（以及冷卻倒數那段最長
    240 秒的空窗），自動翻頁會插進線路。
13. **剩餘內容不得自動覆寫剪貼簿**。交給 `LongPushErrorModal` 的唯讀 Textarea，
    使用者按了「複製剩餘內容」才走 `App.doCopy`。
14. **草稿只有整段成功送完才清**（`_finish({kind:'done'})` → `onSent`）。送到一半失敗、
    被 PTT 擋下來、使用者取消，草稿一律留著——那是他打的字，我們沒有替他丟掉的權力。
    已知取捨（2026-09-17 使用者拍板）：失敗時草稿留的是**整段原文**，重開直接送會把
    已送出的前幾則再推一次；錯誤框另有「剩餘內容」可以複製。**不要自作主張把草稿
    改寫成 `rest`**。
15. **型別每次開框都重設為「推」**。以前刻意不重置，於是上次選的噓會沿用到下一次開框；
    按 X 的預期一律是推，而噓錯了收不回來（PTT 沒有撤回 API）。禁噓板那條 effect
    （`booAllowed` false 且 type==='boo' → 推）照舊並存。
16. **序列進行中不可以有第三者往線路送 byte**，`serializedOpHint` 之外還有一個容易漏的：
    **anti-idle**。`''` 在 server 端會實際產生一個 `KEY_ESC`，落在型別選單那一格
    就是 `vkey()` 讀到非數字 ⇒ 型別靜默變「推」、畫面照樣推進 ⇒ 整段用錯的型別送出。
    守門在 `serialized_op_gate.js#shouldSkipAntiIdle`（`App.antiIdle` 呼叫）。
17. **序列的每一步送完都要讓 server 的 vtkbd 回到 `VK_NORMAL`**。這是「機器送出一律
    化解懸空 ESC 態」那條守門能安全的前提：化解只會發生在序列的**第一個**命令（人在
    pager／列表，多出來的 `KEY_ESC` 是 no-op），不會落在型別選單或 ◆ 橫幅那兩格。
    守護 `tests/unit/long_push_flow.test.js`，各畫面的反應表見
    `docs/pttbbs-screen-protocol.md` §1.2。
18. **`busy` 翻 false 時必須主動通知好讀**（`_releaseWire()`，掛在 `disarm()` —— `busy`
    唯一的共同出口）。`easy_reading._wireBusy()` 的三個來源裡，`longPush.busy` 是**唯一
    一個 CommandQueue 管不到的**：`armed`（使用者在輸入框打字）與冷卻倒數（最長 240 秒）
    期間 queue 空著、`onIdle` 早就發過了，`busy` 卻要等到關框才翻 false ⇒ 那一刻沒有第
    二次 idle 能叫醒好讀被延後的自動翻頁。少了它的症狀：按 X 叫出長推文再取消，文章
    永遠停在當前頁、怎麼捲都不會讀到結尾（沒送鍵就沒有新幀，不會再評估第二次 ⇒ 死結，
    只能離開文章再進）。實錄 `ptt-debug-20260917-221112`：最後三筆 `easyReading.pageDown`
    全是 `{action:"blocked", inFlightKind:null}`。
    通知走 `easyReading.onWireIdle({ force: true })`：`force` 是因為待補送的鍵未必還在
    （取消路徑會退出文章再 ⏎ 重開，那個文章邊界的 `_resetPagingState` 就把
    `_deferredPageDownKeys` 清成 null 了），要不要真的送鍵仍由 `nextPageDownDecision` 決定。
    守護 `tests/unit/long_push_wire_release.test.js`、
    `tests/unit/easy_reading_send_gate.test.js`、
    `tests/e2e/offline/long_push.offline.spec.js`「取消長推文之後，好讀的自動翻頁要接得回去」。

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

`cancel()` → `queue.flush()` → 依當下底列送收尾鍵，最多 `MAX_ABORT_STEPS(4)` 次：

- 輸入列／確認列 → `\x03`（Ctrl-C：`vgetstring` 清空 + abort ⇒ `getdata` 回 0 ⇒
  `recommend()` 什麼都不寫就 return）
- ◆ 橫幅 → `' '`
- 已回到文章／列表 → 不送任何鍵

型別選單**沒有取消**（任何非數字都會被當成預設值），所以那一步是先進到輸入列再 Ctrl-C
出來。`MAX_ABORT_STEPS` 是 **4**：小天使板（`BRD_ANGELANONYMOUS`）上 Ctrl-C 會被 `vans`
當成「非 n」＝匿名 YES，比一般情況多一步。同一個迴圈也是**探路**退出推文流程用的
（`_enqueueAbort(onSettled, onLost)`：`onLost` 是收尾鍵逾時／被 flush 的出口，那時畫面
狀態未知，**不可以**再往下送 ⏎）。

已經送出的推文收不回來——PTT 沒有這種 API，遮罩上寫明了。剩餘內容**不再自動寫進
剪貼簿**（2026-09 使用者定案：那會無聲蓋掉他手上的東西），改由 `LongPushErrorModal`
顯示在唯讀 Textarea，要不要複製由他按。

收工的每一條路（關框 `disarm`、送出失敗 `_finish`、送出取消、斷線）都會把 `busy`
翻成 false，而那一刻**必須主動叫醒好讀**（不變量 18）。

### 關框那一下的 Esc（兩種症狀，同一個根因）

**用 Esc 關掉輸入框，那一下一定會漏到終端機。** 2026-09-17 在 offline e2e 實測：
Mantine Modal 的 Escape handler 比 `term_view` 的 keydown listener 先跑，等 term_view
那條跑到時 `modalShown` **已經翻成 false** ⇒ `shouldAcceptInput()` 放行。所以「有彈窗
就不送鍵」修不了這個（而且框關掉之後順手多按的那一下，本來就是合法的終端機輸入）。
⇒ server 的 vtkbd 停在 `VKSTATE_ESC` 是**常態不是例外**。

兩種症狀：

1. **下一個方向鍵跳到同主題的上一篇**（2026-09-16）：方向鍵開頭的 ESC 被吃成 esc_arg，
   `[` 與 `D` 變成字面鍵，而 `[` ＝ `RELATE_PREV`。
2. **下一次按 X 出現「讀不到文章代碼（miss）」**（2026-09-17，本節的主角）：探路送出的
   第一個機器 byte（`Q` 或 `X`）被吃成 esc_arg、回一個在 pager 沒有消費者的 `KEY_ESC`
   ⇒ **畫面不動、零輸出** ⇒ CommandQueue 700ms soft timeout 送 `` 探針 ⇒ 探針幀是完整
   文章畫面、`expect` 仍找不到 AID ⇒ 判成 `miss`。這也是「取消長推文之後立刻再按 X
   特別容易觸發」的原因。證據樣本 `ptt-debug-20260917-012944.json#t=529/1229/1241/1326`。

修法是把送出端守門的**預設反轉**（`vtkbd_send_state.js`）：`conn.send`／`convSend`
（機器路徑）停在 `ESC` 態就一律補一個 ESC 化解；ESC 組合鍵的保護縮到
`conn.sendUserKey`／`convSendUserKey`，而那兩個**只有 `term_view._send`／`_convSend`
會叫**。界線是**送出入口不是位元組內容** ⇒ 日後新增的送出路徑預設就是安全的那一邊。
推導、各畫面對多出來的 `KEY_ESC` 的反應表、與不變量 17 的關係見
`docs/pttbbs-screen-protocol.md` §1.2；入口靜態守護
`tests/unit/user_key_send_wiring.test.js`。

### 鍵盤送出（Ctrl+Enter）

輸入框的 `<form>` 掛 `onKeyDown`（不是掛 Textarea ⇒ 游標在型別選單／按鈕上也送得出去），
與送出鍵共用同一個 `trySubmit()`（二次確認語意因此自動一致）。三條硬規則：

| 規則 | 為什麼 |
|---|---|
| 收 `ctrlKey \|\| metaKey`，**不偵測平台** | 同 `term_keyboard.js:236-242` 的立場：判錯的人不是退化成沒快捷鍵，而是按了沒反應 |
| `nativeEvent.isComposing` / `keyCode === 229` 一律放行 | 組字中的 Enter 屬於 IME 上字 |
| 命中就 `preventDefault()`，但**不** `stopPropagation()` | 前者擋 textarea 自己插的換行；後者不需要——`modalShown` 已經讓 `term_view` 的 global keydown 整組噤聲（`shouldAcceptInput()`） |

按鈕上的提示由 `src/js/platform.js#modEnterShortcutLabel` 決定（Mac `⌘Enter`／其他
`Ctrl+Enter`）。**該模組只准用於文案**，行為端永遠兩個修飾鍵都收。快捷鍵字串硬寫、
不進 i18n（同 `DropdownMenu.jsx` 的 `rightSection={<span>Ctrl+C</span>}`）。

提示那個 `span` **必須 `aria-hidden`**：否則它會被算進送出鍵的 accessible name，
`getByRole('button', { name: i18n('longPushModal_confirm') })` 這種完整字串比對（unit 與
offline e2e 各有數處）會一起靜默失效。輔助技術那份改由 `aria-keyshortcuts` 提供。

## 尚待 live 驗證

1. ~~推完落在文章列表還是文章~~ → **CONFIRMED 落在文章列表**（`bbs.c:2471-2473`
   對 `RET_DORECOMMEND` 一律 `recommend(...); return FULLUPDATE;`，2026-09 使用者
   實測的推錯文災情也印證）。設計仍對兩者免疫；落在 clean-list 且起點是文章時，
   **先過守門**再補 `\r` 回去。
2. 反白欄顏色（`docs/pttbbs-screen-protocol.md` §5.1 與 `vgetstring` 相左）⇒ 目前**不靠**數
   反白格反推 `maxlength`。
3. **探路**：禁推板／未達發文限制的實際橫幅字串是否與開源碼一致（term.ptt.cc 有私有
   commit，見 §12）；以及 `BRD_ANGELANONYMOUS` 板上退出推文流程實際要幾步。

## 測試

| 層 | 檔案 | 守什麼 |
|---|---|---|
| unit | `tests/unit/long_push_draft.test.js` | 草稿：round-trip、localStorage 被關掉／存到壞值一律降級不炸、**key 不等於 `pttchrome.pref.v1`**、重複寫同值只寫一次 |
| unit | `tests/unit/vtkbd_send_state.test.js` / `telnet_esc_guard.test.js` / `user_key_send_wiring.test.js` | 機器送出一律化解懸空 ESC 態、真鍵盤仍保留 ESC 組合鍵、**userKey 入口只有 `term_view` 一個**（靜態掃描） |
| unit | `tests/unit/long_push_split.test.js` | 濾字、byte 長度、上限公式、分段（含全形餘裕、標點斷點、**URL 保護與硬切**） |
| unit | `tests/unit/push_screen.test.js` | §11.3 每個 PTT 字串一個 case（共用分類器，長推文與圖片上傳都吃它） |
| unit | `tests/unit/long_push_anchor.test.js` | 身分解析／截斷容忍／兩代游標／置底・刪除列 → 一律不得回 `ok` |
| unit | `tests/unit/long_push_flow.test.js` | 真 CommandQueue ＋ 假 buf/view：鍵序、冷卻、取消、flush、上限校正、**游標守門與重新定位**、**每一步送完 vtkbd 都回 `VK_NORMAL`**（不變量 17）、**`onSent` 只在整段成功送完響一次**（harness 與畫面常數抽在 `tests/unit/helpers/long_push_harness.js`，與下一列共用） |
| unit | `tests/unit/long_push_preflight.test.js` | **探路**：只送一個 X、各 kind 的收尾鍵序、**PTT 原文逐字照錄**（含沒看過的新訊息）、冷卻不算不能推且不倒數、逾時一個收尾鍵都不送、ORDER INVARIANT（scrollTop 歸零前採樣）、`start()` 不重採錨點也不重解 AID |
| unit | `tests/unit/long_push_error_modal.test.jsx` | 錯誤框：原文照錄、來源標示兩態、已送出則數、剩餘內容唯讀可讀回、**按了才複製** |
| unit | `tests/unit/long_push_modal.test.jsx` | 即時則數、濾字提示、>20 則二次確認、**插入目標註冊／游標插入／網址過長警告**、**型別每次開框回到推**、**草稿還原／還原提示／清除／開框不覆寫**、**鍵盤送出**（ctrl 與 meta 都收、單獨 Enter 不送、組字中不送、提示不進 accessible name） |
| unit | `tests/unit/platform_label.test.js` | 快捷鍵提示的平台判斷（userAgentData 優先、UA 退路、拿不到 navigator 不 throw）|
| unit | `tests/unit/dropdown_menu_preview.test.jsx` / `pref_modal_context_menu.test.jsx` | 選單 gating、pref 預設值（含攔截開關的從屬關係與 disabled） |
| unit | `tests/unit/long_push_gate.test.js` | 攔截判準：`x` 不是推文鍵、`shiftKey` 仍要攔、prompt 幀不攔、列表不攔、開關從屬 |
| unit | `tests/unit/push_key_intercept.test.js` | 三條入口各自的分派：不落到 `_keyboard`／`_convSend`／`view._send`、不提前進 functionMode、**沒開成就不吞** |
| unit | `tests/unit/long_push_open_bridge.test.jsx` | `App.openLongPushModal` 注入／回 true／卸載還原 noop、**沒開過右鍵選單也算對 maxBytes** |
| e2e | `tests/e2e/offline/long_push_image_upload.offline.spec.js` | 輸入框開著時拖圖 → 網址進 Textarea、**線路上一個 byte 都沒送**、點「開啟上傳紀錄」modal 不關 |
| e2e | `tests/e2e/offline/long_push.offline.spec.js` | 整條鏈（React → session → queue → WS）、遮罩擋鍵盤、取消、**真 `term_buf` → `list_session._collectFacts` → 守門**（游標飄掉時送 `#AID` 而不是 `X`）、**攔截**（按 X／%、點底列按鈕、關 pref 回原生、列表不攔）、**Ctrl+Enter 送出**（空的時候不插換行、不漏 byte）、**探路**（按 X 只送一個 X 且輸入框要等答案；被擋時錯誤框裡是 Big5 畫面一路解出來的 PTT 原文；被擋之後回到文章）、**關輸入框後漏出去的 Esc 不會吃掉下一次按 X**（真 DOM keydown → `term_view` → `telnet._vkState` → CommandQueue → WS 是唯一交會點，unit 任一層都測不到）|

`function_keys.offline.spec.js` 的 `(X%)` 逐鍵可點與 `pref_close_in_prompt.offline.spec.js`
都**刻意在 prefs 裡關掉 `pushKeyOpensLongPush`**：它們量的是「送出去的 byte」與「原生
鏡像」，預設攔截會讓 X 一個 byte 都不送。改那兩支之前先看它們的註解。
