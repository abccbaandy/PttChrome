# CI 故障對照表

`yarn ci:status` 紅了、但失敗的 job／step 看起來與被測 code 無關時查這裡；新增 CI job 前讀最後兩條。
（由 CLAUDE.md「push 後必查 CI」節搬出；那邊只留一行指標。）

- **nightly `Flaky Hunt`（`.github/workflows/flaky-hunt.yml`）**：每天在 dev 上把 unit／integration 各連跑 N 輪、offline e2e 與逆境圖片 e2e（adverse 三桶）`--repeat-each=N`（預設 10）；Android 模擬器 e2e 每週一次（窗起點週六 UTC＝台灣週日 05:00 那輪，`--repeat-each` 預設 5，`scripts/flaky-hunt-gate.mjs#decideAndroid`；手動 dispatch 要明確選 `suite=android`，`all` 不含）。它的紅＝**真的 flaky**（框架層不 retry），處置是照該 issue 找根因修，不是重跑。`yarn ci:status` 不把它算進 push 的 CI（同 sha 也排除）。完整流程：
  - **排程保證**：GitHub schedule 會延遲（實測天天晚 ~3h、最多 +5h）也可能被丟，所以掛三個非整點 cron（UTC 21:17／03:17／09:17＝台灣 05:17／11:17／17:17）。最前面的 `gate` job 查本 workflow 在 dev 上自最近一次 UTC 21:00 起、**比自己早**建立的 run：有 success／failure 或還在跑／排隊的 ⇒ 其餘 job 全跳過（gate-only 的短 run）；cancelled 不算。`workflow_dispatch` 永不跳過，但在 dev 上手動跑過也算「今天跑過」（`scripts/flaky-hunt-gate.mjs`）。concurrency 按 ref 分組、`cancel-in-progress: false`：後到的排隊等前一輪結束再由 gate 跳過；PR branch 的驗證 dispatch 與 dev 的 nightly 互不取消。
  - **紅了開 issue**：report job 開／續寫 issue「Nightly flaky hunt 失敗」（掛 label `flaky-hunt`，查詢走 label 不走搜尋索引；body 含 run／ref／commit）。只有 dev 上的 run 會寫；在工作分支 dispatch 用來驗修正或收證據，紅了看 run 本身。
  - **routine 修復**：**新開 issue 會觸發 Claude routine「fix Nightly flaky hunt 失敗」（trigger＝Issue opened＋標題＋作者 `github-actions[bot]`）**，session 開 PR → CI 綠 → 在 PR branch dispatch 驗證（可選 `suite`＋`grep` 只跑出事的那條、把 `repeat` 拉到 ≥50）→ merge → 關 issue。
  - **去重規則**（`scripts/flaky-hunt-report.mjs`，守護 `tests/unit/flaky_hunt_report.test.js`）：只有「`schedule`＋沒有 open 的同名 issue＋這輪跑的 commit 仍是 dev HEAD」才新開；其餘只續寫 open 的、否則最近關掉的那個（不 reopen）。`workflow_dispatch` 不新開：PR 的 `Fixes #N` 先把 issue 關了、驗證又紅，會再 fire 一個 session 連鎖下去。**過時紅**（nightly 晚開跑，跑的期間修正已 merge）不新開：留言標註「此 run 的 commit 已非 dev HEAD」，下一個 session 回頭看。留言不觸發 routine。
  - **watchdog**：每次 run（不管紅綠，只在 dev）檢查 open 的 flaky issue，`createdAt` 超過 3 天且沒有 label `flaky-stalled` ⇒ 加 label 並 @ repo owner 一次（session 中途結束時 issue 會一直開著、nightly 只留言，沒人知道；`actions/stale` 會被 nightly 留言重置，不能用）。見 `scripts/flaky-hunt-watchdog.mjs`。
  - 靜態守護（cron ≥2 條非整點、concurrency 含 `github.ref` 且不 cancel、gate 被所有 job needs、watchdog `always()`）＋gate／watchdog 純函式：`tests/unit/flaky_hunt_workflow.test.js`。

- **nightly `PTT Source Screens`（`.github/workflows/ptt-src-screens.yml`）**：每天用 upstream pttbbs HEAD 的原始碼產生畫面
  （`tools/ptt-src-screens/`，不架站）餵給本專案的解析器。紅了開／續寫 issue「PTT 原始碼畫面檢查失敗」（label `ptt-src-screens`，
  新開會觸發 routine；去重與連鎖防護同 flaky hunt）。`generate` job 紅＝upstream build／driver 壞了（環境），`check` job 紅＝解析器判錯。
  全綠但畫面與 repo 的 fixture 不同 ⇒ 低優先 issue「PTT 原始碼畫面有變動」（不接 routine，更新 fixture 即可）。
  只有 PR 觸發的 run 算進 `yarn ci:status`（schedule／dispatch 的 run 與 flaky hunt 同為 `isSideRun`，連結論都不進）；
  有 paths 過濾 ⇒ 不可加進 required checks。完整說明見 `docs/ptt-src-screens.md`。
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
- **integration job（Firebase Emulator in Docker）timeout**：舊的偶發 `waitForCloud timeout: upload` 根因是 emulator「回 HTTP」不等於「暖好」——首次 Firestore 寫入要付 JVM 暖機（本機量 ~1.5s，4 核滿載 ~2s），落在第一條測試的 poll deadline 裡。現由 `scripts/run-integration.mjs#warmUp` 在 vitest 前先做一次 auth signUp＋Firestore 寫入付掉；**測試框架層不准 retry**（守護 `tests/unit/no_test_retry.test.js`，重試會把 flaky 吞成綠）。之後再紅一律當真錯查根因；只有 `not ready in …ms`／`warm-up failed`（image 拉取或 emulator 起不來，測試還沒跑）才屬基礎設施，可用 `yarn ci:status --rerun-failed`。本機跑 `yarn test:integration` 需 **Docker**（無 Docker 只能靠 CI）。
- **GITHUB_TOKEN 造成的事件不會再觸發 workflow**（GitHub 防遞迴，例外只有 `workflow_dispatch`／`repository_dispatch`）：任何在 Actions 內做 merge／push 的步驟若用 `secrets.GITHUB_TOKEN`，產生的 push **不會**觸發 `deploy.yml` 的 `on: push` → 站台靜默停在舊 commit（實例 PR #16）。`dependabot-auto-merge.yml` 因此改用 GitHub App installation token（secret `AUTOMERGE_APP_CLIENT_ID`／`AUTOMERGE_APP_PRIVATE_KEY`），勿改回 GITHUB_TOKEN。查驗方式：merge commit 的 SHA 上要看得到 `Deploy to GitHub Pages` run（`event: dynamic` 的 run 是 GitHub 動態 workflow，不算）。
- **CodeQL 是 advanced setup（`.github/workflows/codeql.yml`），default setup 已停用，勿再開**：default setup 對 java-kotlin 只能 `build-mode: none`，而 Kotlin（`android/`）必須編譯 ⇒ 每次 push 紅 `could not process any of it using the 'none' build mode`。兩者不能並存（advanced 上傳會被拒）。新增語言改 matrix；category 維持 `/language:<lang>`（與舊 default setup 相同，alert 才延續）。
- **`test-e2e-android` 紅**：先看 log 末行結論。`exit 2`（失敗全帶 `[android-env]`）＝環境：下載 artifact `e2e-android-attempt-N` 的 `device-screen.png`（整個螢幕，系統／Chrome 對話框只拍得到這張）與 `logcat-crash`，對照 `docs/android-e2e.md` 踩坑表；新的對話框類型 ⇒ 在 fixture 處理，不是重跑了事。`exit 1`＝斷言紅，當真失敗處理（spike 40 輪 0 次）。開機逾時屬 runner 問題，可 `--rerun-failed`。
- **`Android APK`（`android.yml`）不可加進 required checks**：它有 `paths` 過濾，沒動 `android/**` 的 PR 永遠不會跑 ⇒ required 會讓那些 PR 卡在 pending。
- **Code scanning 的 alert 用 REST API 處理**：`PATCH /repos/{o}/{r}/code-scanning/alerts/{n}`，body `{state, dismissed_reason, dismissed_comment}`；`dismissed_reason` 只吃 `false positive`／`won't fix`／`used in tests`。兩個硬限制：**`dismissed_comment` 上限 280 字元**（超過回 422，訊息才會說「Only 280 characters are allowed」，先寫長版會白做一次）、**已 dismissed 的 alert 不能直接改 comment**（回 400 `Alert is already dismissed.`），要改必須先 `{"state":"open"}` 再重新 dismiss。
- **誤判一律寫進 `.github/code-scanning-dismissals.json`，由 workflow `code-scanning-dismiss.yml` 自動 dismiss**（dev 的 CodeQL 跑完接著跑，也可手動 Run；用 GITHUB_TOKEN 的 `security-events: write`，不需 PAT）。以 rule＋path 比對、不比行號，所以同檔同規則的新 alert 也會被關：加列前先確認該檔沒有別的真問題。雲端 Claude session 打不到 code scanning API（agent proxy 把 api.github.com 的認證換成 Claude App token，env 放 PAT 也沒用），只能走這條。
- **新增 CI job 時步驟順序必須是 `setup-node（取 node）→ corepack enable → setup-node（帶 cache:yarn）`**（照抄現有 job）：`cache: yarn` 會在 corepack 生效前跑 `yarn cache dir`，命中 runner 內建 yarn 1.22 → 遇 `packageManager: yarn@4.x` 直接掛在 setup-node 步（症狀 `current global version of Yarn is 1.22.22`）。**例外：`test-imgur-worker` 是 npm 子專案**（`proxy/imgur-worker` 自帶 package-lock），不走 corepack，用 `cache: npm` + `cache-dependency-path`。
- **新增 CI job 後要同步分支保護的 required checks**（`dev` 分支，repo 設定、**repo 裡看不到** ⇒ 最容易漏）：目前七個 `test / *` job 全是必跑 gate。漏加的後果是 Dependabot 的 `--auto` 合併不等那個 job ⇒ 它紅著也會被併進去。用 append endpoint 加，**別用整份覆蓋的 PUT**（會把其他保護欄位清成預設）：`POST /repos/{o}/{r}/branches/dev/protection/required_status_checks/contexts`，body `{"contexts":["test / <job>"]}`。context 名是 `<workflow job 名稱前綴> / <job id>`，reusable workflow 下就是 `test / <job>`。
- **`test-unit` 也跑在 Playwright image 裡**（unit-browser project 要真 Chromium，見 `docs/build-modernization.md`「Vitest Browser Mode」）：容器規則與 e2e job 相同。`Executable doesn't exist` ＝ `playwright` 與 `@playwright/test` 版本不一致（守護 `ci_playwright_container.test.js`）。
- **unit 耗時看 runner 抽到的 CPU 型號，不是核心數**（CONFIRMED，14 輪：`nproc` 恆 4，AMD EPYC 7763 比較新的 EPYC 9V74／Xeon 8573C 等慢約 1.5 倍）：同一份 code 耗時差一倍屬正常，`Runner CPU` step 印了型號可對照。`--maxWorkers` 調參沒有意義。
- **CI 耗時（shard 數怎麼定）**：整輪牆鐘＝最慢的測試 job＋build＋deploy。e2e job 每個固定付 ~50s
  （拉 image ~30s＋checkout／setup-node／`yarn install`），測試本體則隨條數線性長。2026-10-08 量 24 輪
  （GitHub API 的 job／step 時間＋Playwright log）：offline 從 2×184 條長到 2×215 條，單片測試本體
  200s→200–350s，整輪 4.5→6.5–9 分，關鍵路徑是 offline 兩片，其次 adverse slow 桶（~4 分）。
  ⇒ offline 拆 4 片、slow 桶拆 2 片（其餘 job 都在 3 分內）。同一份 code 單片耗時可差 1.5 倍
  （runner CPU 型號，見上一條；e2e job 的 `Runner resources` 也印機型），比較前先對機型、看多輪。
  **再慢時的判準**：最慢的 e2e job 測試本體 > ~3 分就加片；加到單片本體 < ~1.5 分就不划算
  （固定成本過半）。不改 worker 數：4 vCPU 跑 4 workers 已吃滿 CPU（slow 桶例外，見 test.yml）。
- **已判定不做**：關掉每條都錄的 video（失敗現場唯一的影像，見 `playwright.config.js`）；live e2e 並行（共用 session 是 worker-scoped，多 worker＝多登入）。
- **runner 變慢（整個 job 慢數倍、開頭一批 `page.goto` 逾時）**：e2e job 都有 `Runner resources`（`scripts/ci-resource-monitor.mjs start`：機型＋記憶體，背景每 10s 取樣）與 `if: always()` 的 `Runner resources report`（摘要＋逐筆），失敗 artifact 另帶 `ci-diagnostics/resources.jsonl`。**綠 run 基準（2026-10-10，`5deea56`，4 vCPU）**：offline 分片／adverse 各桶 `user+sys` avg 77–97%（本來就設計成吃滿 4 核）、`steal` 0、`iowait` avg ≤1%、load1 max 9–24（slow 桶 8 workers 最高）；Android job `user` avg 53%、開跑前等系統穩定 21s（閒置 75%）。⇒ **`user+sys` 滿是常態，不能單獨當異常訊號**。判讀：`steal` 明顯 >0＝同主機其他 VM 搶 CPU，換台機器就好 ⇒ 重跑失敗 job；`iowait` 遠高於 ~1%＝卡磁碟；兩者都正常、job 卻慢數倍 ⇒ 看取樣時間軸是不是某段 CPU 反而閒下來（卡在等待而不是算不完）。實例：adverse slow 2/2 一次 17 分（平常 3 分）、重跑即綠，當時尚無取樣，根因 `unknown`。
- **容器裡 adverse runner 的 dev server 180s 等不到**（2026-10-01 發生一次，根因 `unknown`）：再發生時看 `scripts/run-adverse-e2e.mjs#waitForDevServer` 附的 vite 輸出與各位址探測結果，不要從頭猜。
