# `mouse.offline.spec.js` 好讀捲動斷言在 adverse 桶偶發紅

狀態：**未修**，斷言不夠嚴謹（不是時序問題）
觸發：隨時。`yarn test:e2e:offline:adverse` 三桶連跑時最容易出現

## 現象

`tests/e2e/offline/mouse.offline.spec.js:779`
「文章好讀：上半／下半＝捲動一頁，底列＝捲到文末，0 byte 送給 PTT」
在 `offline-broken` 桶（圖片全部 404）偶發失敗，失敗點是第 797 行：

```js
const down = await plainPointInHalf(page, 'down');
expect(down, '找不到不是連結／預覽的可點處').not.toBeNull();
expect(await clickAt(page, down.x, down.y)).toBe('');
const afterDown = await scrollTop();
expect(afterDown).toBeGreaterThan(0);   // ← 量到 0
```

2026-09-20 實測：完整三桶連跑（`offline-slow` 8.6m 跑完之後、機器上同時 36 個 chrome
進程）紅一次；之後單獨重跑該 spec、單獨重跑整個 `offline-broken` 桶各一次都全綠。

**判準：這是真失敗，不是環境問題。** 有真的 AssertionError 與截圖；CLAUDE.md 記的那個
Windows DLL 指紋（`STATUS_DLL_INIT_FAILED`）特徵是**零 AssertionError、失敗案例耗時 0ms**，
與此不符。

## 為什麼要修而不是重跑

CLAUDE.md：「offline e2e 不接受 flaky：不是時序問題，是斷言不夠嚴謹。」

## 懷疑的根因（未證實，請自行查證）

`plainPointInHalf`（同檔 `mouse.offline.spec.js:662`）用 `document.elementFromPoint`
找「不是連結也不是預覽佔位盒」的點，跳過 `.inlinePreviewSlot`。broken 桶的圖片是 404，
佔位盒的最終高度與載入完成時機和一般桶不同；測試前雖有 `waitPreviewsSettled(page)`，
但**取得座標之後到 `clickAt` 之間若版面又位移，點擊就落在別的元素上**，結果退化成
「沒捲動」這個沉默的 0 —— 正是 `docs/offline-replay-testing.md` 與 50fa35c 記載的那一類。

## 要做的事

1. 先確認根因：在該桶把 `plainPointInHalf` 回傳的座標與**實際被點到的元素**印出來，
   設法穩定重現（人為加負載，或在取得座標後刻意延遲再點）。
2. 用 `tests/e2e/helpers/layout.js` 既有的 helper 收斂：`waitRectStable`、
   `assertElementUnder`、`plainLeftEdge`。關鍵是「量到座標之後、點下去之前」要再確認
   該座標底下仍是預期的元素。
   **禁止**用 `waitForTimeout` 當版面等待（靜態守護 `tests/unit/e2e_layout_settle.test.js`）。
3. 同檔其他用 `plainPointInHalf` 的測試（如 `:814`）一併檢查。
4. 驗證：`node scripts/run-adverse-e2e.mjs --only=offline-broken`
   （**exit code 就是結論，不可接管線**；0 綠／1 真失敗／2 環境問題）
   ＋ `npx playwright test --project=offline mouse.offline`。

## 與 2026-09-20 那次改動無關（已排除，不必重查）

該次（PTT 改版公告相容性）動了 `ansi_parser.js` 與 `term_buf.setPageState`，但：

- parser：19 份 cassette 的全部位元組逐 chunk 餵給新舊兩版 parser，**每一格字元＋六個
  屬性＋游標座標完全相同** ⇒ 對真實 PTT 資料可證明 inert。
- `setPageState`：文章畫面在更前面就被 `parseStatusRow` 判成 pageState 3，根本走不到
  這次改的 row0／狀態列分支。
