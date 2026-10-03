# 測試／CI 耗時：剩下可做的優化

狀態：**只剩 CI unit 耗時變異**（offline shard、adverse 每桶 matrix、build 平行都已上線，現行規則見
`.github/workflows/test.yml`／`deploy.yml` 註解與 `tests/unit/ci_playwright_container.test.js`、
`ci_deploy_concurrency.test.js`）。做完或判定不做就刪本檔。

## CI unit 耗時變異

- 根因 CONFIRMED（run #255–#267＋PR Test #51，共 14 輪）：`nproc` 恆 4，耗時只跟 CPU 型號有關。
  - AMD EPYC 7763：115–121s（9 輪，很穩，可當對照組）
  - EPYC 9V74／9V45、Xeon 8573C／6973P-C：70–107s
  - vitest `Duration` 各階段比例每輪都一樣（environment ~35%、tests ~34%、setup 14%、import 12%）
  - ⇒ runner 機型無法選，這部分變異不用處理。
- 試驗中：`test-unit` 改成 `yarn test:unit --maxWorkers=4`（vitest 5 預設＝`availableParallelism()-1`＝3）。
  本機 16 核量到 3 worker 73.5/74.1s、4 worker 65.3/58.5s；4 核 runner 上的效果 `unknown`，因為第 4 個
  worker 會跟主執行緒搶核心。
- 下一步：累積 ≥3 輪 **EPYC 7763** 的 run，`Unit tests` 的 Duration 跟基準 115–119s 比。沒有明顯變快
  （< 5%）或 flaky 變多 ⇒ 改回不帶參數。撈資料方式：runs API → 找名稱含 unit 的 job → job logs，
  用 regex 抓 `Model name:` 和 `Duration`。
- 剩餘成本：jsdom 仍佔 ~35%（約 124 檔宣告 `@vitest-environment jsdom`）。可選方向：
  - 逐檔檢查是否只為少數 DOM API 才用 jsdom，抽純邏輯改測純函式；
  - 評估 happy-dom（較快，但行為差異會讓既有斷言變動；依 `docs/build-modernization.md` 先寫評估紀錄）。

## 已判定不做

- **e2e 再多拆 shard／job**：每個 e2e job 固定成本 ~30–40s 拉 Playwright image（GitHub 不快取 container
  image）＋`yarn install` 10–20s；offline 兩 shard、adverse 三桶後各 job 只剩數分鐘，再拆不划算。
- **live e2e 不准並行**：共用 session 是 worker-scoped，多 worker＝多登入（CLAUDE.md「測試」節）。
- 容器裡 adverse runner 的 dev server 曾 180s 判不到（2026-10-01），根因 `unknown`。再發生時看
  `scripts/run-adverse-e2e.mjs#waitForDevServer` 附的 vite 輸出與各位址探測結果，不要重做猜測。
