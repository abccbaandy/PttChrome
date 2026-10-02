# PttCurrent 公告 bot：上線剩餘步驟

狀態：code＋測試完成，執行環境改成 Cloudflare Worker（Actions runner 被 ptt.cc 擋 403）。
設計、設定表、指令都在 `docs/ptt-announcement-bot.md`。剩下要使用者動手：

1. `wrangler login`＋`wrangler deploy`（`proxy/ptt-announcements-worker`）。
2. `wrangler secret put` 設 `MANUAL_TOKEN`，打手動入口 `?dry_run=1`：應印「官方 [開發資訊] 12 篇」
   ＋11 篇 closed／1 篇 open。**被擋（403）就停**，改走本機排程（bot 文件 UNVERIFIED）。
3. 建 fine-grained PAT（本 repo、Issues: Read and write、Expiration 選 No expiration）→ `secret put GH_TOKEN`。
4. 打一次 `?seed=1`：建 12 個 issue，不 fire（subrequest 額度不夠時會留一部分，再打一次補完）。
5. claude.ai/code/routines 建 routine（prompt 用 bot 文件那段）→ API trigger →
   `secret put CLAUDE_ROUTINE_FIRE_URL`／`CLAUDE_ROUTINE_TOKEN`。
6. 等 cron（或打一次不帶參數的手動入口）：應 fire VCOL 那篇，issue 被加上 `claude-queued`＋session 網址留言。
7. 第 2 步確認打得通 PTT 之後，分支保護 required checks 加 `test / test-ptt-announcements-worker`
   （使用者已同意由 Claude 用 API 加，見 `docs/ci-troubleshooting.md`）。打不通就改走本機排程，Worker
   子專案連同這個 job 一起移除，不必加。

全部完成後刪掉本檔。
