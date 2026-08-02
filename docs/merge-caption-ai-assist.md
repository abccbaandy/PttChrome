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
- 分組目前在 **render 期同步計算**（`src/components/Screen.jsx` `computeAnnotations`，render 每次重算）。任何 AI 都是 async → 必須改為 settle 時預算＋per-article cache，AI 結果回來後觸發 re-render。架構改動不小。
- 每篇文章一次推論，長文 token 多、裝置端延遲秒級；使用者切三態按鈕時體感卡。
- 不可用環境（手機、低配、非 Chrome）必須 fallback 純規則 → 永遠要維護兩套行為＋兩套測試，AI 路徑難以 unit 守護（輸出不定）。

## 若未來做：建議架構

1. 規則先配（同步、現行路徑不動），畫面先出。
2. `LanguageModel.availability()` === "available" 才啟用校正層；"downloadable" 不主動觸發下載（尊重使用者流量/磁碟），設定頁 opt-in。
3. AI 只做二次校正：輸入＝規則產出的 blocks＋鄰近段落文字，輸出＝JSON schema 約束的 `{imageRow, keep: bool}`；只允許 AI **剔除**配對、不允許新增（維持寧少配不誤配）。
4. 結果 cache（key: 文章 AID 或 rowTexts hash），切三態/重render 不重推論。
5. 測試：AI 層只能 e2e mock `LanguageModel` global 驗流程，語意品質不進 CI。

## 結論與重啟條件

純規則（就近段落）已修掉回報 case；殘餘誤判屬「無空行混排」少數文章，且 opt-in＋零遺失，風險低。

重啟條件（任一）：(a) Prompt API 進 stable **且免大額下載**（隨 Chrome 內建）、(b) 使用者回報現行規則仍大量誤判／排版不可讀的實例文章、(c) 專案已有其他功能引入裝置端模型（攤提架構成本）。

## 2026-08 複評（使用者要求，起因＝推文合併改版）

recommendation 不變：**暫緩**。

平台面（查 developer.chrome.com/docs/ai + GoogleChrome/modern-web-guidance）：

| 項目 | 2026-07 評估 | 2026-08 現況 | 對重啟條件的影響 |
|---|---|---|---|
| 可用性 | Chrome 138+，部分需 flag/OT | 桌機 Chrome **預設開啟、不需 flag**（Win10/11、macOS 13+、Linux、Chromebook Plus） | (a) 前半達成 |
| 瀏覽器 | 僅 Chrome | **仍僅 Chrome**（Edge/Firefox/Safari 皆不支援） | 與 CLAUDE.md「目標＝主流桌機瀏覽器現代版（含 Firefox/Safari）」衝突 → 仍須兩套行為＋兩套測試 |
| 硬體/下載 | 4GB VRAM、22GB 磁碟、首載數 GB | **不變**：22GB 可用空間、16GB RAM（或 >4GB VRAM）、4 核；模型**每個 origin 首次使用才下載** | (a) 後半（免大額下載）**未達成** |

功能面（新增，比 2026-07 更關鍵）：推文合併已於 2026-08 改為**一則一行**（不再猜續行，見
`docs/enhanced-addon.md`），AI 的角色因此質變——

- 舊：猜「哪裡該斷行」，是**必答題**且錯了破壞原意（把兩句黏成一句 / 把一句切兩半）。
- 新：選擇性把「被輸入欄截斷的續行」接回，是**加分題**：不做也完全可讀（等同原生畫面），
  做錯最壞只是多接一行；輸入是相鄰兩則的短文字（token 極省，非整篇文章），輸出是 binary，
  可用 structured output 約束，且能整段 cache（key: AID）。
- 也就是說 pttbbs 反查證實「寬度訊號無資訊量」（`docs/pttbbs-screen-protocol.md` §11.1）之後，
  這是**唯一**還能改善的方向；但它已不是 bug，只是錦上添花。

因此 (b) 不成立（現行排版無「不可讀」回報，反而是移除猜測後才變可讀）、(a) 只達成一半、(c) 未發生
→ 維持暫緩。若未來重啟，走上節「若未來做：建議架構」，並把推文續行接回當作**第一個**目標
（比 caption 配對更容易驗證、失敗代價更小）。
