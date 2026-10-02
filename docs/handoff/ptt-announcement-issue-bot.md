# PttCurrent 公告 bot：上線剩餘步驟

狀態：code＋unit 已完成（設計與 CONFIRMED 搬到 `docs/ptt-announcement-bot.md`）。剩下都要使用者動手或等時間：

1. push 到 `dev` → Actions 手動跑 `PttCurrent announcements`，`dry_run=true`：確認 runner 抓得到 feed
   （沒被 Cloudflare 擋），應印「官方 [開發資訊] 12 篇」＋ 11 篇 closed／1 篇 open。
2. 再跑一次 `seed=true`：建 12 個 issue（11 closed、VCOL 那篇 open），不 fire。
3. claude.ai/code/routines 建 routine（repo＝本 repo、環境 Default、prompt 用 `docs/ptt-announcement-bot.md`
   那段）→ 加 API trigger → 把 URL／token 存成 repo secret `CLAUDE_ROUTINE_FIRE_URL`／`CLAUDE_ROUTINE_TOKEN`
   （**不准寫進 repo**）。
4. 手動跑一次（無 input）或等排程：應 fire VCOL 那篇，issue 被加上 `claude-queued`＋留言 session 網址。
5. 2026-10-05 03:17 UTC 後確認 fork 的 schedule 有 run（查法見 bot 文件 UNVERIFIED）。

全部完成後刪掉本檔。
