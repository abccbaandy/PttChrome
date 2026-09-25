# 新版 read.c／board.c 改寫成 PSB 之後，逐條稽核列表類功能依賴的 CONFIRMED 事實

狀態：**unknown**（尚未稽核）
觸發：PTT1 10/18（預定）上線前；上線後再錄一次 cassette 做驗證
來源：`3rd_script/pttbbs` 分支 `origin/piaip.newui`（7e35b24e 起）。`git -C 3rd_script/pttbbs fetch` 後讀；Big5，
讀片段 `git show origin/piaip.newui:mbbsd/<f>.c | iconv -f BIG5 -t UTF-8 -c`。

## 為什麼開這張

caption／狀態列指紋已讀碼校準（protocol §11.9／§11.10）。但同一批改動把 `read.c#i_read` 與
`board.c#choose_board` **整體搬到 `psb.c#psb_main`**（P&S Browser System），列表好讀
（`list_session.js`／`command_queue.js`）與看板平滑捲動（`board_list_session.js`）依賴的那些「舊碼 CONFIRMED」
事實，全都要對新碼重新驗一遍。已順手確認成立的：
- 分頁對齊：`psb_sync_cache` 仍 `base = (curr / rows) * rows`（鍵盤路徑）
- 看板序號 `%7d`＝`idx + 1`（`board.c#brdlist_renderer`）
- 空列表游標 (23,79)（`psb_main`）

## 要稽核的（依 docs 逐條對）

- `docs/easy-reading-list.md`：翻頁鍵、`\f` 重繪交易、跳號後底列留空與否、typeahead、置底文（`.DIR.bottom` 已改成
  `boardheader_t`，commit 4e61f87b）、搜尋結果（`search.svc` 取代 SR.*，commit 8ae6bcca）
- `docs/board-list-smooth-scroll.md` §2：`search_num` 夾值、**導覽鍵 wrap**（§2.1）、Enter 三種落點、`num` 跨進出保留
- `psb_main` 的局部重畫（`redraw_header_lines`／`redraw_footer_lines`、只重畫游標兩列）是否破壞「一幀＝完整列表」假設
- 伺服器端滑鼠（`vs_locator_*`、`cmd_bar_*hotspot*`、滾輪移 `base` 會打破分頁對齊）：確認只在 client 送 xterm
  滑鼠回報時才生效；本專案若日後送回報，必須先處理 base 不對齊

## 產出

逐條在對應 doc 標 CONFIRMED（附 `<file>#<func>`）或修實作＋補測試（先紅後綠）；做完刪本檔。
