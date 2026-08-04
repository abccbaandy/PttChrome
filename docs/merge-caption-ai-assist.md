# 圖文並排（merge-caption）裝置端 AI 輔助配對

recommendation: **已實作**（2026-08，opt-in、預設關）。2026-07／2026-08 兩次評估的「暫緩」結論已被
使用者實測回報推翻，重啟理由與現行架構見下。純規則見 `src/js/image_caption_group.js` 檔頭註解。

| 模組 | 角色 |
|---|---|
| `src/js/image_caption_group.js` | 純規則（就近段落）。**行為零改動**，只多 export 兩個判準給 AI 層重用 |
| `src/js/caption_ai_logic.js` | 純函式：候選段切分、keep→塊重建、prompt/schema、cache key |
| `src/js/caption_ai.js` | 瀏覽器層：`window.LanguageModel` session／佇列／逾時／fallback |
| `src/components/Screen.jsx` | 接線：spans 掛在 annotations、effect 逐塊推論、結果回填 re-render |
| `src/components/MergeImageCaptionAiButton.jsx` | 第二顆浮動按鈕（`#mergeImageCaptionAiBtn`，bottom:112） |
| `tools/caption-ai-eval.html` | 能力評估頁（dev-only，用真 Chrome 開） |

## 重啟理由（2026-08，使用者回報）

原評估把殘餘 case 定義成「規則配太多」，實際回報的是**反向**：規則配太少。
素材 `tests/e2e/cassettes/cchat-caption-mosquito.json`（C_Chat 打蚊子那篇，累積頁列號）：

```
8  http://i.imgur.com/Z4gDlVE.jpg   圖行
9  (空)
10 在某家風俗店裡…                   ← 規則只配到這一行
11 (空)                              ← imageFirst 分支遇空行即 finalize()
12-18 對話 7 行                       ← 以下全部留在原地全寬 render
19 (空)
20 60 分鐘方案結束。
21 (空)
22-24 收尾 3 行
```

翻譯漫畫的說明天生被空行切成多段 → 圖文並排等於沒作用。「這幾段是否還在講同一張圖」是語意問題，
純結構規則無解（放寬成「吃到下一張圖」則反過來把前言／結語／下一個話題吸進右欄）。

## 契約：AI 只回答一個整數

```
buildCaptionSpans(rowTexts, direction)
  → [{ imageRow, captionFirst, imageUrl, paragraphs[{start,end}], texts[],
       ruleKeep, ruleBlock, closed, aiEligible }]   // 由近而遠排序
applyAiKeep(ruleBlocks, spans, {[imageRow]: keep}) → blocks
```

- 候選段＝以空行為界的段落，段頭尾的中性 sole-URL 行剝掉、整段中性者丟棄
  （與規則的「中性行不開塊、不延伸 captionEnd」一致；典型是下一張圖的 x.com 來源連結）。
- AI 輸出只有 `keep ∈ [0..N]`（由近而遠保留幾段），`responseConstraint` JSON schema 約束上下界。
  keep 缺席／非整數／超界／逾時／例外 → 一律退回 `ruleKeep`。
- **零回歸是結構性保證，不是靠測試碰運氣**：
  - `aiEligible` = 「用 ruleKeep 重建的塊」必須與規則原塊逐欄位相等，否則該圖永遠沿用原塊。
  - 由此得 `applyAiKeep(blocks, spans, {})` ≡ `blocks`（`tests/unit/caption_ai_logic.test.js`
    對既有規則測試的**全部**素材跑這條不變量，兩個 direction 都跑）。
- `closed=false`（好讀還沒載完、最後一塊的候選段還會長）不送 AI，避免對半截文章推論並汙染 cache。
- `spanNeedsAi()`：`aiEligible && closed && 段數>1 && ruleKeep<段數`——規則已無可改空間就不浪費推論。

## 執行面

- **cache key 是內容型**（`spanKey`＝FNV-1a of 圖 URL＋候選段文字＋方向＋段數）：好讀翻頁會重算
  spans，內容沒變就不重跑推論；換文章（`articleId` 變）整包丟掉。
- 逐塊序列化推論、逐塊回填：規則結果先畫出來，AI 只是漸進式修正，**不擋畫面**。按鈕顯示剩餘塊數。
- 每塊用 `session.clone()` 推論：同篇相鄰圖塊內容相似，共用 context 會讓答案互相帶偏。
- 兩顆按鈕分開（使用者要求）：`#mergeImageCaptionBtn` 三態不變；`#mergeImageCaptionAiBtn` 開 AI
  時若尚未合併會順手開成 imageFirst，再按只關 AI；三態循環回「還原排版」時 AI 一併關掉。
- 設定：pref `enableCaptionAi`(false) ＋ 「檢查／下載裝置端 AI 模型」按鈕（`#captionAiEnableBtn`，
  `ensureCaptionAiReady`）。**`availability()` 非 available 時絕不自動 `create()`**——模型下載數 GB，
  只在使用者按下按鈕（有 user activation）時才觸發。

## 平台事實（developer.chrome.com/docs/ai/prompt-api，2026-08 查證）

| 項目 | 現況 | 影響 |
|---|---|---|
| 穩定性 | Chrome 148 起 stable，桌機免 flag | 可用 |
| **語言** | 官方只支援 `en/ja/es/de/fr`，**中文不在清單**；`expectedInputs` 傳不支援語言可能丟 `NotSupportedError` | **一律不傳語言**；指令用英文、內容維持原文中文。中文能力是本案最大不確定性 → 用評估頁實測 |
| 硬體 | 22GB 可用空間、16GB RAM 或 >4GB VRAM、4 核；模型 per-origin 首次使用才下載 | 多數機器會是 `unavailable` |
| 瀏覽器 | 仍僅 Chrome | 其他瀏覽器按鈕不出現，行為與沒這功能時完全相同 |

**踩坑**：Playwright 的 Chromium **有** `window.LanguageModel` 這個 global，但沒有模型元件
（`availability()` 回 `'unavailable'`）。所以按鈕的顯示條件是 **availability 探測結果**，不是
global 存不存在——否則 Chromium／未下載模型的 Chrome 會出現一顆按下去每塊都 fallback 的假按鈕。

## 能力評估頁（`tools/caption-ai-eval.html`）

```
yarn start   # 然後用你自己的 Chrome 開 http://localhost:8080/tools/caption-ai-eval.html
```
Playwright 的臨時 profile 沒有模型元件，**只能手動用真 Chrome 開**（模型是 per-profile 下載的）。

- 語料走 app 自己的真實路徑重建：cassette bytes → `AnsiParser` → `TermBuf.getRowText` →
  `resolvePageOverlap` 累積（鏡像 `term_view.js#accumulatePageLines`），不手抄文章文字。
  **踩坑**：`isLeadByte` 只在 buf 的 update pass 才標記（notify 30ms + settle 50ms），
  每頁餵完必須讓事件回圈跑一下，否則 `getRowText` 吐出未轉碼的 Big5 位元組。
- golden 在 `tools/caption-ai-cases.json`：cassette 案以**圖片 URL** 為鍵（列號會隨累積頁變動），
  另有 synthetic 負例（前言／結語／下一個話題）——**沒有負例的話，一個永遠回答 N 的模型也會拿 100%**。
- 報表同時列三欄對照：AI／規則 baseline（永遠 1）／取滿 baseline（永遠 N），外加中文理解 smoke test
  （全錯＝語言問題，不是 prompt 問題）與每塊延遲。

### 實測結果

| 日期 | 環境 | availability | 中文 smoke | AI 正確率 | 規則 baseline | 取滿 baseline | 平均延遲 |
|---|---|---|---|---|---|---|---|
| 2026-08-04 | 使用者桌機 Chrome 149 | available | 2.5/3（第 3 題「這句是角色對白嗎」時對時錯） | **78%（7/9）** | 33%（3/9） | 56%（5/9） | 1147 ms/塊 |
| 2026-08-04 | 同上，prompt v2（停止規則具體化＋3 個 few-shot） | available | — | **78%（7/9）** | 33%（3/9） | 56%（5/9） | 1167 ms/塊 |

CONFIRMED：**中文讀得懂**（smoke 前兩題穩過），且顯著優於現行規則（33%）。

### 關鍵拆解（v2 重測後才看得出來，比總分重要）

語料的 9 塊剛好可分成兩群，且 **golden 與 N 的關係決定了 baseline**：

| 群 | 塊數 | golden | 「取滿(N)」會不會對 | AI 兩輪表現 |
|---|---|---|---|---|
| 擴張群（說明被空行切成多段，全部屬於該圖） | 5 | == N | 對 | **5/5，兩輪皆然** |
| 停止群（負例：作者心得／前言／下一個話題） | 4 | < N | 錯 | 2/4，且**兩輪錯的不是同兩題** |

⇒ `AI = 取滿 baseline + 4 個負例中的 2 個`。也就是說：
- **模型在本功能的主用途（該擴張時擴張）上穩**：兩輪、兩種 prompt，5/5。
- **負例側不穩**：v1 錯「翻譯後接作者心得提問」「整塊都是別的話題」；v2 那兩題翻正，卻換成
  「圖後參數＋整體心得」「captionFirst 多段前言」錯。總分不動、失敗集合換人 → 已在雜訊底線附近。
- prompt v2 因此**無法判定有沒有變好**：9 題的解析度是 ±11 個百分點，分不出 78% 與 89%。

另外，負例 #7（captionFirst 多段前言）的 golden 本身可爭議：`在我的環境下 相同種子下各設定值的
生成速度` 是**所有圖共用的方法說明**，標 1 或 2 都講得通 → 部分「失誤」其實是標註的判斷。

### 決策（2026-08-04）

**停止 prompt 調校，以現狀交付**（opt-in、預設關）：
- 在 9 題語料上繼續調 prompt ＝ 對雜訊過擬合，改善與波動分不開。
- 負例答錯的代價有界：內容零遺失、可逆、且只有「答比 1 多」才構成相對現況的新回歸。
- 要再往下推，**先擴語料**（錄 2~3 篇「圖文＋真實心得/結語混排」的文章，那正是取滿 baseline 會
  垮、AI 才有價值的形狀），有了解析度再談調 prompt。

不做 best-of-3 一致性投票：投票壓的是變異不是偏誤；且從兩輪結果看，負例失敗更像是**能力邊界**
而非單純抖動，投票只會穩定地錯，長文還多付 2~3 倍延遲。

未解 / 已知限制：
- **輸出非決定性**（Nano 有取樣溫度）：同一篇文章重進可能配出不同結果。
  同一 session 內由 `spanKey` cache 壓住不會跳動；跨 session 不保證一致。**接受此限制**。
- 語料只有 9 個可評估塊，且負例全是合成的（真實 cassette 的 3 塊都屬擴張群）→
  **「AI 比取滿 baseline 好」在真實素材上尚未被證實**，只在合成負例上看到一半。
- ~1.2 秒/塊：10 張圖的文章約 12 秒跑完，逐塊回填不擋畫面（規則結果早就畫出來了）。

## 測試

| 層 | 檔案 | 守什麼 |
|---|---|---|
| unit | `tests/unit/caption_ai_logic.test.js` | 打蚊子篇回歸（4 段候選、ruleKeep=1、keep=4 → 右欄涵蓋到 row 23）、零回歸不變量、closed、keep 檢核、prompt/schema/解析 |
| unit | `tests/unit/caption_ai_client.test.js` | availability 五態、clone 推論、逾時／例外／垃圾回覆全部 fallback 回規則、abort、`ensureCaptionAiReady` 不偷下載 |
| unit(jsdom) | `tests/unit/merge_image_caption_ai_render.test.jsx` | 按鈕出現條件（含「有 API 沒模型」）、右欄擴張、可逆、換文章重置 |
| offline e2e | `tests/e2e/offline/merge-image-caption-ai.offline.spec.js` | 真瀏覽器／真渲染：stub LanguageModel → 右欄列數 > 純規則、總列數不變（零遺失） |

真實模型能力**不進 CI**（輸出不定、且 CI runner 沒有模型）——那是評估頁的工作。
