# 用實測位元組把「動態指令列改版」的新格式從 guess 升成 CONFIRMED

狀態：**guess**（唯一來源是 2026-09-20 公告「介面調整: 動態指令列與看板資訊改版」，非 source 非實測）
觸發：PTT1 10/18（預定）上線之後，或更早能連到 PTT2（09/20 起已在跑新版）
姊妹 handoff：`status-row-recalibrate.md`（主選單狀態列，同一種作法；可一次登入一起錄）

## 為什麼這張還開著

`src/js/screen_captions.js` 的新 caption、`term_buf.js#EDITOR_STATUS_BOX_RE`、
`isCursorOnInputField` 的狀態列例外，都是照公告**文字**寫的；該改動還沒進公開的 pttbbs repo
（03cdf5eb 仍無 `vs_cmd_bar`）。規則已放寬到「新舊都吃、猜錯退原生」，但那不等於驗過。
背景與對照表：`docs/pttbbs-screen-protocol.md` §11.10。

## 要做什麼

1. 取得新版真實位元組（`yarn record:cassette`，guest-only；登入預算：**一輪就收手**，見 CLAUDE.md／§11.2）。需要的畫面：
   - 文章列表（一般／`/` 搜尋結果／Tab 文摘）、信箱列表的**底列**
   - 看板列表三種（`F` 我的最愛、`C` 分類子層、全部看板）的**底列**：確認 caption 字樣、前後空白數，
     以及中段是否還有 `(a)增加看板`／`(y)只列最愛`／`(m)加入/移出最愛`（class vs all 的唯一依據）
   - 編輯器底列：右側狀態框實際字元（公告範例是 `||插入|5ipr||  1:  1`，與 edit.c 的 `%s│%c%c%c%c%3d:%3d` 有落差）
   - 空看板（或搜尋無結果）：游標位置與 (23,79) 那格的實際配色
   - pmore 底列右半：是否仍含 `(y)回應`（`parsePagerFooterContext`）、col 79 配色
2. 校準：
   - `screen_captions.js` 的集合與「行首 token」規則
   - `board_list_parse.js#boardListHintVariant`：若新版「看板列表」提示不足以分 class/all，改用其他指紋
     （row0 中段？row1？）——**不可**退化成只認新版
   - `term_buf.js#EDITOR_STATUS_BOX_RE`
3. fixture 換成實測位元組並把註解的 guess 改 CONFIRMED：
   - `tests/unit/screen_captions.test.js`（新格式那兩組）
   - `list_session.test.js`「PTT 動態指令列改版」那組、`board_list_parse.test.js`「新版 caption（guess）」
   - `term_buf_page_state.test.js` 新編輯器、`term_buf_input_field.test.js`「游標停在狀態列右下角」
   - `footer_keys.test.js`／`string_util.test.js`／`list_accumulate.test.js`／`board_list_accumulate.test.js` 的新格式 case
   帳號一律換成同長度佔位符（本 repo 公開）。
4. 更新 `docs/pttbbs-screen-protocol.md` §11.10 的旗標。

## 不要做的事

- 不要刪舊格式（CONFIRMED）的判定或測試：PTT1/PTT2 上線差約一個月，兩種格式並存。
- 不要把 caption 判定放寬成 `indexOf`：中段提示是動態的，會誤命中。
