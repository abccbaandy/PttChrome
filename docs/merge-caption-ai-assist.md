# 圖文並排（merge-caption）裝置端 AI 輔助配對 — 評估報告

recommendation: **暫緩**（旗標；重啟條件見文末）。現行純規則見 `src/js/image_caption_group.js` 檔頭註解（就近段落原則，2026-07 起）。

## 問題定義

純結構規則無法語意判斷「這段字是否描述這張圖」。規則覆蓋狀況：

| case | 規則 | 狀態 |
|---|---|---|
| 緊貼段落即相關文（翻譯漫畫、參數測試文） | 就近段落 | CONFIRMED（unit 守護） |
| 多段無關前言/結語 | 空行=段落邊界，只取緊貼段 | CONFIRMED |
| 一張圖配多段說明（段間空行） | 只取最近一段，其餘照常 render | 已知取捨（寧少配不誤配） |
| 緊貼段其實與圖無關（無空行分隔的混排文） | 無法判斷 | unknown，唯一需要語意的殘餘 case |

殘餘 case 影響小（誤配內容零遺失、按鈕可關），是否值得上 AI 的門檻要高。

## 候選方案（限零金錢成本）

| 方案 | 可用性 | 成本 | 工程量 | 穩定性 |
|---|---|---|---|---|
| Chrome Prompt API（Gemini Nano，`LanguageModel`） | 僅 Chrome 138+ desktop；需 4GB+ VRAM、22GB 磁碟；首次下載約 2–4GB；`LanguageModel.availability()` 偵測 | 免費、無 API key | 中～大（見下） | 中：有 structured output（JSON schema 約束）可壓，但語意判斷仍會漂 |
| WebLLM / transformers.js 生成式小模型 | 跨瀏覽器（WebGPU） | 模型需自 host（GitHub Pages 流量）或第三方 CDN；首載數百 MB～數 GB | 大＋bundle/部署負擔 | 小模型中文語意判斷更弱 |
| transformers.js embedding 相似度（非生成式） | 跨瀏覽器 | 小模型數十 MB | 中 | 比的是「段落 vs 段落」相似度，但圖片本身無文字可比——只能比段落間主題斷裂，效果存疑 |

共同架構性障礙（與方案無關）：
- 分組目前在 **render 期同步計算**（`src/components/Screen.js` `computeAnnotations`，render 每次重算）。任何 AI 都是 async → 必須改為 settle 時預算＋per-article cache，AI 結果回來後觸發 re-render。架構改動不小。
- 每篇文章一次推論，長文 token 多、裝置端延遲秒級；使用者切三態按鈕時體感卡。
- 不可用環境（手機、低配、非 Chrome）必須 fallback 純規則 → 永遠要維護兩套行為＋兩套測試，AI 路徑難以 unit 守護（輸出不定）。

## 若未來做：建議架構

1. 規則先配（同步、現行路徑不動），畫面先出。
2. `LanguageModel.availability()` === "available" 才啟用校正層；"downloadable" 不主動觸發下載（尊重使用者流量/磁碟），設定頁 opt-in。
3. AI 只做二次校正：輸入＝規則產出的 blocks＋鄰近段落文字，輸出＝JSON schema 約束的 `{imageRow, keep: bool}`；只允許 AI **剔除**配對、不允許新增（維持寧少配不誤配）。
4. 結果 cache（key: 文章 AID 或 rowTexts hash），切三態/重render 不重推論。
5. 測試：AI 層只能 e2e mock `LanguageModel` global 驗流程，語意品質不進 CI。

## 結論

- 純規則（就近段落）已修掉回報 case；殘餘誤判屬「無空行混排」少數文章，且 opt-in＋零遺失，風險低。
- 重啟條件（任一）：(a) Prompt API 出現在 stable 且免大額下載（隨 Chrome 內建）、(b) 使用者再回報就近段落規則仍大量誤判的實例文章、(c) 專案已有其他功能引入裝置端模型（攤提架構成本）。

## 附：推文合併排版 AI 評估（2026-07，同結論暫緩）

「連續同作者推文合併」（`src/js/comment_merge.js`）的合併段落排版曾評估上裝置端 AI（語意重新斷行／
分段）。結論同上：**暫緩、規則先行**（v1＝內容串接＋ `pre-wrap` 自然換行）。理由與本報告完全同構：

- 架構障礙相同：分組在 render 期同步計算（`Screen#computeAnnotations`），AI async → settle 期預算
  ＋per-article cache＋雙套 fallback，成本一樣大。
- 語意增益更小：推文每則是作者**主動送出**的獨立單位（無自動換行訊號），串接後自然換行已可讀；
  AI 只能猜「哪裡該斷行」，錯了反而破壞原意，且輸出不定無法 unit 守護。
- 重啟條件**共用**上節 (a)(c)；(b) 對應版＝使用者回報串接排版明顯不可讀的實例文章。屆時架構照上節
  「若未來做」：規則先出畫面、AI 只做二次校正、JSON schema 約束、結果 cache。
