# live e2e `easy-reading.spec.js` 的「好讀模式自動行內開圖」**間歇性**紅

狀態：`CONFIRMED` 為**既有問題**，與 2026-08-29 的 FIXME 清理無關（乾淨樹對照一輪，
同一篇文章、同一組數字重現）。尚未定位根因。

**2026-08-29 修正：不是「必紅」，是間歇性。** 同一天三輪整包 live 的結果是
紅／紅／綠（第三輪同一條 spec、同一份 code 自己就過了）。這件事改變修法：

- **一次綠不能當作修好**。要嘛連跑數輪（受登入預算限制，見本 repo 規範），要嘛
  先在 offline 重現（offline 的行內預覽測試一直是綠的 ⇒ 目前重現不出來）。
- 反過來，**看到它紅也不能當成「這次改壞了」**。判準：其他 live spec 是否同時紅、
  offline 是否全綠。

## 症狀

```
attempt 0: previewable links = 7 ["https://i.verb.tw/ojzLOMs3.jpg","https://i.meee.com.tw/L9OU2X3.jpg","https://i.imgur.com/DIxMaZf.jpg"]
LAZY SEEK: {"found":0,"scrollTop":1752}
TimeoutError: page.waitForSelector（'#mainContainer img.hyperLinkPreview, …'）10000ms
```

`tests/e2e/easy-reading.spec.js:179`。找得到 7 個可預覽連結，但由上往下掃完整篇
**一個預覽節點都沒掛出來**（連 `.previewLoading` / `.previewError` 佔位盒都沒有）。

## 已排除

| 假設 | 結論 |
|---|---|
| 本次 FIXME 清理造成 | `CONFIRMED 否`：`git stash -u` 後跑同一條，失敗完全相同 |
| 圖床慢／掛掉 | `CONFIRMED 否`：三個 host `curl -I` 都 200，0.6～0.9 s |
| 渲染鏈壞掉 | `guess 否`：offline 全套 224 條（含 adverse 的 slow/404/301/mixed 四桶）全綠，行內預覽在 offline 掛得出來 |

## 下一步線索

- `LAZY SEEK` 的 `scrollTop` 停在 **1752**（= `scrollHeight - clientHeight` 的上限）。
  對一篇 a11y 快照 725 行的長文來說太小 ⇒ **懷疑 `document.querySelector('.main')`
  在 live 好讀下拿到的不是真的捲動容器**，或整篇還沒累積完就開始掃。
  先驗這個，不要先動 `inline_preview_slot.js`。
- 對照組：offline 的 `tests/e2e/offline/` 行內預覽測試走的是
  `helpers/layout.js#waitPreviewsSettled` + `seekInlineMedia`（`helpers/replay.js`），
  **這條 live spec 自己手寫了一份 seek 迴圈**，兩邊不同步。可能的修法是讓 live spec
  改用同一組 helper，而不是各自維護。
- 重現：`rm -f .claude/.dev-server-running; yarn test:e2e easy-reading.spec.js -g "自動行內開圖"`
  （前景跑；整輪只登入一次，**不要為了對照連跑多輪**，見 CLAUDE.md 登入預算）。
