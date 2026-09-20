# 用實測位元組把新版狀態列／標題列從 guess 升成 CONFIRMED

狀態：**guess**（唯一來源是 2026-09-20 公告文字，非 source 非實測）
觸發：PTT1 10/04 之後，或更早能連到 PTT2（09/20 起已在跑新版）

## 為什麼這張還開著

`parseListRow`（`src/js/string_util.js`）與 `screen_titles.js` 的去括號分支，是照公告
「介面調整: 標題列與主選單底部狀態列改版」的**文字描述**寫的。該改動還沒進公開的
pttbbs repo（`3rd_script/pttbbs` HEAD 的 `menu.c#show_status`、`vtuikit.c#vs_header`
都還是舊的），所以沒有 source 可對。

這正踩在 `docs/pttbbs-screen-protocol.md` §5.1 那次事故的坑邊上：
「程式錯 ＋ 測試錯互相背書」＝ fixture 與被測程式共用同一個假設。
目前的緩解是**把指紋放到最寬**（只認兩個一定存在的錨點），猜錯也不會壞；
但那不等於驗過。

## 要做什麼

1. 取得新版畫面的**真實位元組**。二選一：
   - PTT1 10/04 之後直接錄：`yarn record:cassette`（guest-only，capture 是 article-scoped）。
     需要的是**主功能表與一個子選單**的底列與 row 0，不是文章。
   - 或先確認 PTT2 的 WebSocket endpoint 能不能從本專案的 dev proxy 連（`vite.config.mjs`
     的 `/bbs` proxy 目前寫死 `wss://ws.ptt.cc/bbs`）。若可行，一次登入就夠。
     ⚠️ 登入預算：PTT 有登入頻率限制，對照實驗**一輪就該收手**（見 CLAUDE.md 與 §11.2）。
2. 拿真實位元組校準：
   - `src/js/string_util.js` 的 `LIST_ROW_DATE_RE` / `LIST_ROW_ONLINE_RE`
     —— 若實際格式與公告一致就只改註解狀態旗標；不一致則改 regex。
   - `src/js/screen_titles.js` 的 ` X ` 分支（前後各一格半形空白這件事要驗）。
3. 把 fixture 換成實測位元組並標 CONFIRMED：
   - `tests/unit/string_util.test.js` 的 `describe("parseListRow（新版狀態列…；guess）")`
   - `tests/unit/term_buf_page_state.test.js` 的 `newStatusRow` / `newSubMenuScreen`
   - `tests/unit/screen_titles.test.js` 的「公告描述的去括號形狀」那一組
   帳號一律換成同長度佔位符（本 repo 公開，見既有 fixture 的作法）。
4. 更新 `docs/pttbbs-screen-protocol.md` §11.9 的旗標與 §11 對照表列。
5. 順手確認兩件**公告有提、目前沒驗**的事：
   - 新底列的 `(?)回到上層` 會不會被 `footer_keys.js` 正確 tokenize 成可點的 `?`
     （`keyBytesFor('?')` 回傳 `'?'`，理論上會，但沒實測過）。
   - `list_session.classifyListScreen` 與 `board_list_parse.boardListContextKind`
     在新版畫面下的 `menu` 判定（unit 已有 guess fixture，e2e 沒有）。

## 不要做的事

- 不要改成「只辨識最開頭的分類標籤」（公告的建議 2）。標籤集合無法窮舉，
  舊格式又沒有這一段 ⇒ 會退化成只認新版。PTT1/PTT2 上線差兩週，兩種格式會並存。
- 不要刪掉 CONFIRMED 的舊格式測試。理由同上。
