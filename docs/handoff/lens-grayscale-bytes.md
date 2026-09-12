# 灰階圖送進智慧鏡頭後，切換 Lens 內功能會變回原彩

狀態：**已知缺陷，未修**。主功能（`docs/easy-reading.md`「單張圖的暫時性灰階」）已上線可用，
這裡只處理「灰階撐不過 Lens 的模式切換」這一段。

## 現象（CONFIRMED，2026-09-12 使用者手動實測）

| 步驟 | 結果 |
|---|---|
| 好讀畫面點灰階鈕 | 圖變灰階 `CONFIRMED` |
| 圖上右鍵 →「使用 Google 智慧鏡頭搜尋」 | Lens 覆蓋層**吃得到灰階** `CONFIRMED` |
| 在 Lens 內切換其他功能（換分頁／模式） | Lens 那側**變回原彩**；PTT 頁面本身仍是灰階 `CONFIRMED` |

⇒ A（灰階入口）與 B（放行原生選單）對這條動線**基本成立**，只差最後這一段。

## 根因

`guess`：Lens 覆蓋層初開是**對視窗截圖再框選** ⇒ 看到的是 render 後的像素（含 CSS filter）；
在 Lens 內切模式時改以**圖片來源**重新取一次原圖 ⇒ CSS filter 不在位元組裡，還原成原彩。
與此一致的硬事實：CSS `filter: grayscale()` 是 render-time 效果，**不動圖片位元組**。

## 唯一可能的修法方向：產出真正灰階的位元組

`canvas.drawImage(img)` → `toBlob()` → 換 `img.src`。三道關卡，**第一道沒過就整個方向作廢**：

1. **`unknown`（分水嶺，先做這一步）**：`img.src` 換成 `blob:` / `data:` 之後，Chrome 的
   「使用 Google 智慧鏡頭搜尋」到底是**上傳位元組**還是**送 URL**？送 URL ⇒ Lens 那側取不到
   blob（跨 context 不可解析）⇒ 整條路無效，**直接刪掉本檔**並在 `docs/easy-reading.md`
   把「灰階只在 Lens 初開時成立」記成 CONFIRMED 限制。
   驗法：手動開一篇有圖文章 → console 裡把某張 `img.hyperLinkPreview` 的 `src` 換成任一
   `blob:`／`data:` URL → 右鍵送進 Lens → 看送出去的是什麼。不必先寫任何產品 code。
2. **canvas taint**：預覽圖跨網域、且刻意帶 `referrerPolicy="no-referrer"`、沒有
   `crossorigin` 屬性（`src/components/ImagePreviewer.jsx:275`）⇒ 畫進 canvas 即 taint、
   `toBlob()` 直接 throw。
   - **不可**把 `crossorigin="anonymous"` 全面加上去：大量圖床沒有 CORS header ⇒ 改為載入失敗。
   - 唯一縫隙：走自家 Cloudflare Worker 代理的那批（imgur／tenor）**有** CORS ——
     `proxy/imgur-worker/src/index.js:195` 的 `access-control-allow-origin: *`。作法是**另開
     一個** `crossorigin="anonymous"` 的 `Image` 重載同一個代理網址（不動畫面上那張），
     畫進 canvas 取灰階 blob。
     - 陷阱：worker 有 `redirectToOrigin()` 分支（301 到 `i.imgur.com`），走到那條就沒有
       CORS ⇒ 仍會 taint，要能安靜退回「只做 CSS filter」。
3. **覆蓋率**：非 imgur/tenor 的圖床一律沒有 CORS ⇒ 就算 1、2 都過，也只覆蓋一部分圖。
   ⇒ 產品上必須是 **CSS filter 為底、位元組灰階為加值**，兩條路的視覺結果要一致
   （同一條 `grayscale(1)`），使用者不該看得出差別。

## 邊界（動手前先讀）

- 現行實作與硬不變量見 `docs/easy-reading.md`「單張圖的暫時性灰階」與
  `src/render/inline_preview_slot.js` 的 `grayHrefs` 註解。
- 換 `img.src` 會觸發 `ResizeObserver` → `onResize`，那條路徑同時管佔位高度與灰階鈕，
  改動前先讀 `inline_preview_slot.js` 檔頭的疊層佔位硬不變量（slot/content 不得有 inline style）。
- `blob:` URL 要記得 `URL.revokeObjectURL`，否則長文數百張圖會漏。
- 產出的灰階位元組**不得**改變 `naturalWidth/Height`（`recordSlotAspect` 靠它算替身盒）。
- 補測試：純函式（「這個 href 能不能走代理取 CORS」）下放 unit；換 src 之後的行為上
  offline e2e（cassette 的圖走 `tests/e2e/helpers/offline_images.js`，可自行決定要不要給 CORS header）。
