# upstream pttbbs 原始碼畫面檢查：建 Claude routine

狀態：repo 端全部完成（多畫面 driver／逐鍵擷取／畫面有變動 issue／routine 用的去重與連鎖防護，見
`docs/ptt-src-screens.md`）。**只剩一步要在 claude.ai 網頁上做**（session 裡沒有建 issue trigger routine 的工具）：

- 照 `docs/ptt-src-screens.md`「routine」建 routine：trigger＝Issue opened＋標題完整等於「PTT 原始碼畫面檢查失敗」
  ＋作者 `github-actions[bot]`；環境 PttChrome；model 明確指定；prompt 照抄該節。
- 建好後把該節的「狀態：尚未建立」改成已建（名稱、日期），刪掉這個 md。
