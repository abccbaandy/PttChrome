# CI 故障對照表

`yarn ci:status` 紅了、但失敗的 job／step 看起來與被測 code 無關時查這裡；新增 CI job 前讀最後兩條。
（由 CLAUDE.md「push 後必查 CI」節搬出；那邊只留一行指標。）

- **deploy job 偶發 `actions/deploy-pages@v5` timeout**：Pages 服務端卡在 `deployment_in_progress`，輪詢約 76s 後 `##[error]Timeout reached, aborting!` 並取消部署 → **測試/build 全綠但 run 紅、站台停在舊 commit**。屬 Pages 基礎設施問題，非本專案 code。判準：該 run 只有 `deploy` 一個 job 紅、`test-*`／`build` 全綠。處置：重跑失敗 job（`POST /repos/{o}/{r}/actions/runs/{id}/rerun-failed-jobs`；`ci:status --rerun-failed` 目前只認 integration flaky，不會自動重跑它）。**事後必須確認 `github-pages` 環境最新一筆 deployment 的 sha 是本次 commit 且 state=success**，否則站台仍是舊版。
- **e2e job 紅在「裝瀏覽器」而不是測試**：`npx playwright install --with-deps` 會先跑 `apt-get update`，
  只要 runner image 內建的**第三方 apt 來源**處於發布中間態（`Release` 宣告的雜湊 ≠ 實際 `Packages.gz`），
  `apt-get update` 就整包回 100 ⇒ `Failed to install browsers` / `exited with code: 100` ⇒ 瀏覽器連下載都沒開始、
  **一條測試都沒跑**，但看起來像 e2e 整批爆炸。判準：失敗 step 的 log 只有 apt 的 `Hash Sum mismatch`，
  沒有任何 spec 名稱；`test-unit`／`test-integration` 全綠。**重跑無效**（不是隨機掉包，是上游 index 不一致，
  可直接抓 `dists/stable/Release` 與 `Packages.gz` 自行比對 sha256 確認）。
  已於 2026-09-09 移除用不到的 Google Chrome 來源（`sudo rm -f /etc/apt/sources.list.d/google-chrome*`，
  兩個 e2e job 各一步，順序必須在 install 之前）——Playwright 用自帶瀏覽器、系統依賴全來自 Ubuntu 官方 archive。
  守護 `tests/unit/ci_apt_sources.test.js`（新增 e2e job 時別漏這一步）。
- **integration job（Firebase Emulator in Docker）偶發 timeout** 是已知 flaky（CI 冷啟動拉 image + 首次 Firestore 寫入超過 poll deadline，症狀 `waitForCloud timeout: upload`）。緩解手段已用盡（`INTEGRATION_TIMEOUT_MS`、CI vitest `retry: 2`、`scripts/run-integration.mjs` 的 `waitHttp` 就緒輪詢）→ 確認非真錯後用 `yarn ci:status --rerun-failed`。本機跑 `yarn test:integration` 需 **Docker**（無 Docker 只能靠 CI）。
- **GITHUB_TOKEN 造成的事件不會再觸發 workflow**（GitHub 防遞迴，例外只有 `workflow_dispatch`／`repository_dispatch`）：任何在 Actions 內做 merge／push 的步驟若用 `secrets.GITHUB_TOKEN`，產生的 push **不會**觸發 `deploy.yml` 的 `on: push` → 站台靜默停在舊 commit（實例 PR #16）。`dependabot-auto-merge.yml` 因此改用 GitHub App installation token（secret `AUTOMERGE_APP_CLIENT_ID`／`AUTOMERGE_APP_PRIVATE_KEY`），勿改回 GITHUB_TOKEN。查驗方式：merge commit 的 SHA 上要看得到 `Deploy to GitHub Pages` run（只有 `Push on dev` 那個 `dynamic` run 是 CodeQL default setup，不算）。
- **Code scanning（CodeQL default setup）的 alert 用 REST API 處理**：`PATCH /repos/{o}/{r}/code-scanning/alerts/{n}`，body `{state, dismissed_reason, dismissed_comment}`；`dismissed_reason` 只吃 `false positive`／`won't fix`／`used in tests`。兩個硬限制：**`dismissed_comment` 上限 280 字元**（超過回 422，訊息才會說「Only 280 characters are allowed」，先寫長版會白做一次）、**已 dismissed 的 alert 不能直接改 comment**（回 400 `Alert is already dismissed.`），要改必須先 `{"state":"open"}` 再重新 dismiss。
- **新增 CI job 時步驟順序必須是 `setup-node（取 node）→ corepack enable → setup-node（帶 cache:yarn）`**（照抄現有 job）：`cache: yarn` 會在 corepack 生效前跑 `yarn cache dir`，命中 runner 內建 yarn 1.22 → 遇 `packageManager: yarn@4.x` 直接掛在 setup-node 步（症狀 `current global version of Yarn is 1.22.22`）。**例外：`test-imgur-worker` 是 npm 子專案**（`proxy/imgur-worker` 自帶 package-lock），不走 corepack，用 `cache: npm` + `cache-dependency-path`。
- **新增 CI job 後要同步分支保護的 required checks**（`dev` 分支，repo 設定、**repo 裡看不到** ⇒ 最容易漏）：目前五個 `test / *` job 全是必跑 gate。漏加的後果是 Dependabot 的 `--auto` 合併不等那個 job ⇒ 它紅著也會被併進去。用 append endpoint 加，**別用整份覆蓋的 PUT**（會把其他保護欄位清成預設）：`POST /repos/{o}/{r}/branches/dev/protection/required_status_checks/contexts`，body `{"contexts":["test / <job>"]}`。context 名是 `<workflow job 名稱前綴> / <job id>`，reusable workflow 下就是 `test / <job>`。
