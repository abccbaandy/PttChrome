# `ResizeObserver loop completed with undelivered notifications` 雜訊

狀態：unknown 根因。測試全綠、使用者無回報症狀；目標＝找出是誰造成 layout 迴圈，修掉或證明無害後加守護。

## 現象（CONFIRMED，2026-10-06 本機 Windows）

- 出現在 dev server log：`[vite] (client) [Unhandled error] Error: ResizeObserver loop completed…`
  （`vite.config.mjs` `forwardConsole: true` 把頁面 `window.onerror` 轉到 server stdout，`@vite/client:363`）。
- 量：`yarn test:e2e:offline` 一輪 ~57 次，散在大量無關 spec（`alt_ctrl_keys`、`article_link_menu`、
  `comment_merge`、`blink_cursor`…，offline-mobile 也有）；`test:e2e:offline:adverse` 0 次；live 核心 0 次。
- **乾淨樹（d869f22 之前）就有**：`yarn playwright test --project=offline debug_record` 2 條測試 → 3 次。
  ⇒ 不是「⋯」浮動工具／設定頁 RWD 引入的。最小重現候選就是這支 spec（boot → feedRaw 一行 → 右鍵開設定 Modal）。
- 已知被當成雜訊吞掉：`tests/e2e/offline/ui_behavior.offline.spec.js:498` 的 pageerror 過濾 `/ResizeObserver loop/`。
  ⇒ 其他 spec 若改成「pageerror 一律算失敗」會大面積紅。

## 嫌疑（guess，未驗）

1. Mantine 元件內建 RO：Modal／ScrollArea／`Textarea autosize`（設定頁黑名單欄位）、Tabs indicator。debug_record 的重現正好開設定頁。
2. `src/render/inline_preview_slot.js#ensureSizeObserver`：回呼內量高度並改 slot 高度 ⇒ 同一幀再觸發。
   歷史上 slot grid 軌道被撐寬時出現過同一訊息（`docs/easy-reading.md` 「slot 是單欄 grid」條）。
3. `src/js/bottom_stick.js`：RO 回呼裡 `scrollTop = scrollHeight`（只改捲動，理論上不改尺寸，可能性較低）。
4. term_view resizer／`fixedResize` 在 RO 週期內改 `.main`／`.wpadding` 寬度。

## 建議做法

1. 先定位：在 offline harness（`tests/e2e/helpers/replay.js` `installReplay`）addInitScript 包一層
   `window.ResizeObserver`，記下每個 observer 建立時的 `new Error().stack`，並在 `window.onerror` 收到這則訊息時
   印出「該幀有回呼的 observer 清單」。用 debug_record spec 與 `comment_merge` spec 各跑一次。
2. 依結果：
   - 我們自己的 RO：回呼內的 DOM 寫入改到 `requestAnimationFrame`，或確保寫入後尺寸收斂（值沒變不寫）。
   - Mantine 內建：查 Mantine 9 是否已知、能否升版；屬規格允許的良性訊息（RO 下一幀補送）就**明文記錄為無害**，
     並把 `ui_behavior` 的過濾抽成共用 helper，不要散落各 spec。
3. 守護：offline harness 加計數，e2e 結束斷言「我們自己的 observer 造成的 loop = 0」（Mantine 來源若判定無害則排除）。
   規則見 CLAUDE.md「offline e2e 不接受 flaky」。

## 不要做

- 不要全域 `window.addEventListener('error')` 吞掉這則訊息了事（會蓋掉真的 layout 迴圈，例如上面 slot 撐寬那次）。
- 不要用 jsdom／happy-dom 重現（已禁用，RO 在模擬環境不是真的）。
