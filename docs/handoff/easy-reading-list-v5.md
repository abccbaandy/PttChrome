# 文章列表好讀模式 — v5 互動合約改造（封閉互動＋確定性交易）

## 狀態（CONFIRMED）

- 基線：`feature/easy-reading-list` @ `b75cc15`（v4＋6 輪修復；測試全綠但體感不穩＝結構性，論證見 `docs/easy-reading-list-research.md` §2/§4，動工前先讀）。
- 決策（使用者 2026-07-05 拍板）：**放棄 parity 合約**（「與原生無可感知差異」），改「外觀近似＋封閉互動＋確定性交易」。本檔＝實作藍圖，未動工。
- **動工第一步＝改寫 `docs/easy-reading-list.md`「核心原則」段**——舊原則明寫「違反＝方向錯誤」，不先改掉，本方向會被下個 session 當 bug 修回去。
- 完工＝刪本檔＋`docs/easy-reading-list.md` 全面改寫為 v5 合約版。

## 新合約（取代舊核心原則）

1. 外觀近似原生（24 行視窗＋游標 `●`＋鍵盤習慣近似），**不再承諾無可感知差異**。
2. 好讀中無任意鍵直通：操作集合＝下表枚舉；未列鍵 no-op（可淡出提示）。
3. server 互動一律 CommandQueue 交易；高風險交易尾附 `\f`（Ctrl+L）→ 必得一幀全幅畫面，timeout 降為真異常。
4. 交易期間 render=frozen＋吞鍵＋讀取中指示（現有 opening 態泛化）。
5. 失敗顯性化：timeout → 送 `\f` 探針拿全幅畫面重分類 → 恢復或 banner＋切原生。禁止靜默墜落。

## 操作分類（枚舉即合約）

| 類 | 操作 | 處置 |
|---|---|---|
| T1 本地 | ↑↓ jk／PgUp PgDn／Home End（buffer 內）／滾輪／**點擊選取（解禁）** | 零 server。視窗/游標語意簡化為 web 慣例，不再 read.c 逐格對齊（lockstep 測試退役） |
| T2 列表內交易 | 開文、數字跳號、`[` `]` `=`、`/` 搜尋、`v` 已讀設定、End/Home 邊界確認 | 腳本交易；要參數的（`/`、`v`）web UI（對話框/選單）收參後代打 |
| T3 顯式氣閘 | Ctrl-P 發文、`z` 精華區、`i` 板設、`b` 進板畫面、`y`/`X` 推文、其餘一切 | 選單「切原生操作」→ 原生模式 → 回 clean-list 再 re-engage。**不再任意鍵自動墜落** |
| T4 非請自來 | 水球/廣播（server 主動寫入） | 唯一自動切原生路徑：banner 明示＋氣閘 |

## 關鍵協定事實（本輪新增 CONFIRMED）

- **`\f`＝igetch 全域熱鍵** → `redrawwin()+refresh()` 全幅重繪（`mbbsd/io.c:530-532`）。與 typeahead 跳繪的交互＝BePTT 實證：`指令+\f` 同送 → 中間增量重繪被 server 吞 → **恰一幀全幅**。使用規則：
  - 只放交易結尾（igetch 情境）；勿進 vget/getdata 中途。
  - 預讀 PgDn 鏈**不加**（回應已確定性，加了流量×2）。
  - 單獨 `\f`＝零副作用「我在哪」探針（timeout 復原標準程序）。
  - `\f` 不取代 settle：全幅重繪仍拆包（OBUFSIZE 3072），settle 判「何時看」、全幅保證「必有得看」。
- **`v` → `b_mark_read_unread`**（`mbbsd/bbs.c:4223`，鍵表 `:4559` flag 1）：清底 4 列 → 提示行 → getdata 底列單字元 prompt「(U)未讀 (V)已讀 (W)前已讀後未讀 (Q)取消 [Q]」→ **return FULLUPDATE**（完成後 server 自行全幅重繪＝交易天生確定性收尾，免 `\f`）。W 以游標文章檔名時間戳為分界。交易形＝`v` → expect prompt 指紋 → 送 `u`/`v`/`w`/`\r`(取消) → expect clean-list。
- 開文交易（list→article）：pmore 對 Ctrl+L 未驗（待驗 2），v1 開文尾不附 `\f`（article settle 既有謂詞已足）。

## 待驗證（M0；結果補進 `docs/pttbbs-screen-protocol.md`）

1. `\f` 誤入 getdata 中途的行為（讀 pttbbs getdata；規則上已繞開，確認誤送不炸即可）。
2. pmore 內 Ctrl+L（決定開文/退文交易是否可附 `\f`）。
3. 水球/廣播畫面指紋（T4 觸發判準；pttbbs 逆向）。
4. `v` prompt 的 getdata echo 細節（單字元後是否需 `\r`）＋prompt 畫面指紋 → 錄 cassette。
5. MODE_SELECT（`/`）交易進出對：搜尋清單無置底、序號空間獨立（protocol §3）；退出鍵與回主列表指紋。

## Milestones（每步獨立可驗；pref 預設 off 護航）

| # | 內容 | 驗證 |
|---|---|---|
| M0 | 協定補課（上五項）＋**改寫 easy-reading-list.md 核心原則**＋錄 `v`/`/` cassette（`RECORD_LIST_SCRIPT` 擴充） | 錄製跑通＋protocol doc 更新 |
| M1 | 交易核心：queue 交易泛化（`fullRepaint` 選項＋timeout→`\f` 探針復原）；退役 timeout-as-signal（7 自適應退役；**3 不退役**——`\f` 重繪不補 feeter、jump 落點恆 transient，見 protocol §6 M1 更正；12 第二腿 M3 處理） | unit＋offline |
| M2 | 互動封閉：keyClass 改枚舉白名單（未列鍵 no-op＋提示）；functionMode catch-all 縮到 T4；T3 顯式選單入口；點擊選取解禁 | unit（keyClass 表）＋offline |
| M3 | T2 交易化：`/`（對話框收參→MODE_SELECT 子狀態→退出對）、`v`（四選項選單）、`[` `]` `=`（沿用配對改 `\f` 收尾、刪 RTT timeout） | offline（每操作一案）＋live |
| M4 | 體驗：到邊讀取中/骨架列；退文回列表改 re-seed（`←` 交易＋`\f`，順帶刷新推文數；退役 restore 逐行 parity）；T4 banner | offline diff 案改寫＋人工 |
| M5 | 測試收斂：退役 read.c lockstep（`list_window.test` 全枚舉）與雙模比對案；live soak 改「枚舉操作輪播」 | 全綠 |

## 不變量重審規則（M1–M5 逐條過 `docs/easy-reading-list.md` 16 條）

- **退役類**：因「零回應歧義」而生（3 跳號底列特例、7 自適應 timeout、12 第二腿 timeout）；因「任意鍵直通/鏡像閃現」而生（12 的 frozen 例外簡化）；read.c 逐格對齊（6 的 fromTop 等細節）。
- **保留類**：畫面解析正確性（5 pinned key、13 relabel 回填、10 隱藏規則同步）；settle gating（1、2、2b）；8、9。
- 判準一句話：凡守護「猜 server 何時說完」的，隨 `\f` 消失；凡守護「讀懂 server 說了什麼」的，保留。

## 風險

- **cassette 全面重錄**：交易加 `\f` 後 byte 流不同，nav/pinned 卷作廢（再錄指令見 `docs/easy-reading-list.md` §素材再錄）。
- 舊測試大量紅：M5 前 lockstep 測試與新行為衝突——動 M1 時先標 skip 並在 commit message 註明，M5 統一清，**不可為過測試而保留 parity 行為**。
- T4 指紋沒把握前不拆安全網：「非 clean-list ∧ 無 in-flight 的 settle」保底仍走 banner＋氣閘（＝現 catch-all 顯性化，觸發頻率因封閉互動大降，但路徑保留）。
