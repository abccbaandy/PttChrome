# 貼 ASCII art 的一字雙色：PTT 編輯器關閉 Raw mode 之後要改送 SGR 66

狀態：**現在不動**（PTT 編輯器的改動還沒進公開 source，照公告文字猜會違反
`docs/pttbbs-screen-protocol.md` 開頭的研究方法規範）
觸發：以下任一
- PTT 編輯器的改動進 `3rd_script/pttbbs`（`mbbsd/edit.c`，搜 raw mode / SGR66）
- 使用者回報「貼 ASCII art 的一字雙色進 PTT 之後顏色跑掉」
公告時程：**今年底前**（2026-09-20 公告「SGR 66 一字雙色」的推進步驟 3）

## 問題

`src/js/string_util.js#ansiHalfColorConv` 是送出方向的一字雙色轉換，消費端：
`telnet.js#convSend/convSendUserKey`、`list_session.js`、`board_list_session.js`、
`long_push_session.js`。

它認的是 `\x15[...;50m`（`\x15` ＝ Ctrl-U ＝ PTT 編輯器的「插入控制碼」，`;50m` 是
**PttChrome 自有的**一字雙色慣例，不是 PTT 也不是 ANSI 的東西），把色碼重排成
`\x00` ＋ 半形色 ＋ 原序列，也就是**靠 raw mode 把一個裸 ESC 塞進 DBCS 字中間**。

公告的推進步驟 3：「PTT 的編輯器關閉 Raw mode，強制新文章只能使用 SGR 66（今年底前）」
⇒ 那條注入路徑會失效。

## 要做什麼（等觸發條件成立再做）

1. 先讀 `mbbsd/edit.c` 確認新的接受格式與拒絕行為（**不要從公告文字反推**）。
2. 把 `ansiHalfColorConv` 的輸出從 `\x00` 注入改成送 `ESC[66;<後半>m`
   （線路格式見 `docs/pttbbs-screen-protocol.md` §1.1「SGR 66 一字雙色」）。
   輸入側的 `;50m` 慣例要不要同時收 `;66m`，看屆時 ASCII art 工具的實際產出。
3. 守護：`tests/unit/` 既有的 `ansiHalfColorConv` 相關測試要改成「新格式」，
   並保留一條舊格式的負例（確認我們不再送 raw 注入）。

## 讀碼備忘

- 這個函式的正規表示式含 `\x15`，**改它一律用 Write/Edit 工具**，不要用 Bash heredoc
  裡的 python 腳本（heredoc 會折掉一層反斜線，見 CLAUDE.md）。
- 與 `docs/handoff/sgr66-render.md` 無關：那張是**收**的方向（Big5 連線收不到，不用做）。
