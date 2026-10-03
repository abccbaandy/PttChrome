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
  **現況：e2e job 已不跑 apt**——一律跑在 Playwright 官方 Docker image（`mcr.microsoft.com/playwright:v<版本>-noble`，
  瀏覽器與系統依賴內建；apt 另一個問題是鏡像站慢，實測同輪兩 job 37 秒 vs 414 秒）。image 版本由
  `playwright-version` job 從 yarn.lock 讀出（`scripts/playwright-version.mjs`），**不准寫死**（Dependabot 只改 yarn.lock）。
  新增 e2e job 照抄 `container:` 區塊（含 `--user 1001 --ipc=host`），不要加 `playwright install`。
  守護 `tests/unit/ci_playwright_container.test.js`。若 image 拉不到（`manifest unknown`）＝該版 image 尚未發布，等官方發布即可。
- **部署鎖只鎖 `deploy` job**（`deploy.yml`，`concurrency: pages`）：放 workflow 層級會讓連續 push 的測試整輪排隊
  （畫面「waiting for Deploy to GitHub Pages #N to complete」）。代價是舊 commit 可能晚於新 commit 拿到鎖 ⇒
  deploy job 拿鎖後先比對 branch head，不是最新就略過部署（step 顯示 skipped 屬正常）。新 commit 若測試紅，
  站台停在更早的版本，修好再 push 即可。守護 `tests/unit/ci_deploy_concurrency.test.js`。
- **integration job（Firebase Emulator in Docker）偶發 timeout** 是已知 flaky（CI 冷啟動拉 image + 首次 Firestore 寫入超過 poll deadline，症狀 `waitForCloud timeout: upload`）。緩解手段已用盡（`INTEGRATION_TIMEOUT_MS`、CI vitest `retry: 2`、`scripts/run-integration.mjs` 的 `waitHttp` 就緒輪詢）→ 確認非真錯後用 `yarn ci:status --rerun-failed`。本機跑 `yarn test:integration` 需 **Docker**（無 Docker 只能靠 CI）。
- **GITHUB_TOKEN 造成的事件不會再觸發 workflow**（GitHub 防遞迴，例外只有 `workflow_dispatch`／`repository_dispatch`）：任何在 Actions 內做 merge／push 的步驟若用 `secrets.GITHUB_TOKEN`，產生的 push **不會**觸發 `deploy.yml` 的 `on: push` → 站台靜默停在舊 commit（實例 PR #16）。`dependabot-auto-merge.yml` 因此改用 GitHub App installation token（secret `AUTOMERGE_APP_CLIENT_ID`／`AUTOMERGE_APP_PRIVATE_KEY`），勿改回 GITHUB_TOKEN。查驗方式：merge commit 的 SHA 上要看得到 `Deploy to GitHub Pages` run（`event: dynamic` 的 run 是 GitHub 動態 workflow，不算）。
- **CodeQL 是 advanced setup（`.github/workflows/codeql.yml`），default setup 已停用，勿再開**：default setup 對 java-kotlin 只能 `build-mode: none`，而 Kotlin（`android/`）必須編譯 ⇒ 每次 push 紅 `could not process any of it using the 'none' build mode`。兩者不能並存（advanced 上傳會被拒）。新增語言改 matrix；category 維持 `/language:<lang>`（與舊 default setup 相同，alert 才延續）。
- **`test-e2e-android` 紅**：先看 log 末行結論。`exit 2`（失敗全帶 `[android-env]`）＝環境：下載 artifact `e2e-android-attempt-N` 的 `device-screen.png`（整個螢幕，系統／Chrome 對話框只拍得到這張）與 `logcat-crash`，對照 `docs/android-e2e.md` 踩坑表；新的對話框類型 ⇒ 在 fixture 處理，不是重跑了事。`exit 1`＝斷言紅，當真失敗處理（spike 40 輪 0 次）。開機逾時屬 runner 問題，可 `--rerun-failed`。
- **`Android APK`（`android.yml`）不可加進 required checks**：它有 `paths` 過濾，沒動 `android/**` 的 PR 永遠不會跑 ⇒ required 會讓那些 PR 卡在 pending。
- **Code scanning 的 alert 用 REST API 處理**：`PATCH /repos/{o}/{r}/code-scanning/alerts/{n}`，body `{state, dismissed_reason, dismissed_comment}`；`dismissed_reason` 只吃 `false positive`／`won't fix`／`used in tests`。兩個硬限制：**`dismissed_comment` 上限 280 字元**（超過回 422，訊息才會說「Only 280 characters are allowed」，先寫長版會白做一次）、**已 dismissed 的 alert 不能直接改 comment**（回 400 `Alert is already dismissed.`），要改必須先 `{"state":"open"}` 再重新 dismiss。
- **新增 CI job 時步驟順序必須是 `setup-node（取 node）→ corepack enable → setup-node（帶 cache:yarn）`**（照抄現有 job）：`cache: yarn` 會在 corepack 生效前跑 `yarn cache dir`，命中 runner 內建 yarn 1.22 → 遇 `packageManager: yarn@4.x` 直接掛在 setup-node 步（症狀 `current global version of Yarn is 1.22.22`）。**例外：`test-imgur-worker` 是 npm 子專案**（`proxy/imgur-worker` 自帶 package-lock），不走 corepack，用 `cache: npm` + `cache-dependency-path`。
- **新增 CI job 後要同步分支保護的 required checks**（`dev` 分支，repo 設定、**repo 裡看不到** ⇒ 最容易漏）：目前七個 `test / *` job 全是必跑 gate。漏加的後果是 Dependabot 的 `--auto` 合併不等那個 job ⇒ 它紅著也會被併進去。用 append endpoint 加，**別用整份覆蓋的 PUT**（會把其他保護欄位清成預設）：`POST /repos/{o}/{r}/branches/dev/protection/required_status_checks/contexts`，body `{"contexts":["test / <job>"]}`。context 名是 `<workflow job 名稱前綴> / <job id>`，reusable workflow 下就是 `test / <job>`。
