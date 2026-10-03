# 延遲載入邊界修復：live e2e 未跑

狀態：程式與 offline 驗證完成（unit 4988／offline 376／adverse 三組全綠），**live e2e 未跑**（CLAUDE.md「改渲染提交前必跑 e2e」）。
跑完 `yarn test:e2e`（至少 `easy-reading.spec.js`＋`enhance.spec.js`）全綠即刪本檔；紅了先照 CLAUDE.md 判斷是否 PTT 端問題。

## 這輪改了什麼（供 live 紅時對照）
- `src/render/inline_preview_slot.js`：IntersectionObserver `root` 改為 `.main`（`scrollRoot`／`observersFor`；不在 `.main` 內則
  `rebindIfOutsideRoot` 改綁隱式 root）⇒ 預載 1500px／卸載遲滯 6000px 首次真正生效。卸載路徑的「有媒體」判準改 `hasLoadedMedia`
  （讀取中被卸載不再釘 57px）。
- `src/css/main.css`：`.previewLoading`／`.previewError` 外框高度 `round(…, 1px)` 整數化（預載時的次像素抖動）。
- live 可能的新行為：同時掛載的圖變多（視窗 ±1500px 預載、6000px 內保留）⇒ 依賴「只有視野內的圖才掛」的 live 斷言可能變紅，
  那是斷言過時，不是回歸（offline 已修過同型：`enhance.offline.spec.js` 黑名單比對排除佔位盒 UI）。

## 守護位置
`tests/e2e/offline/lazy_preview_margin.offline.spec.js`、`tests/unit/lazy_inline_preview.test.js`（root／改綁／讀取中卸載）、
`tests/unit/preview_indicator_height.test.js`、`easy_reading_scroll_jump.offline.spec.js` 測試 1（倍率模式＋關快取，理由見
`docs/offline-replay-testing.md`）。
