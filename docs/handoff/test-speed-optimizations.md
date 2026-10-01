# 測試／CI 耗時：剩下可做的優化

狀態：**只剩 CI unit 耗時變異**（offline shard、adverse 每桶 matrix、build 平行都已上線，現行規則見
`.github/workflows/test.yml`／`deploy.yml` 註解與 `tests/unit/ci_playwright_container.test.js`、
`ci_deploy_concurrency.test.js`）。做完或判定不做就刪本檔。

## CI unit 耗時變異

- 現象：同一份設定 `Unit tests` step 64s～176s（run #245–#254）。vitest `Duration` 各階段比例幾乎相同
  （environment ~35%），runner region 各不相同（westus／eastus／centralus／westus2）⇒ 疑似機型差異。`guess`。
- 已做：`test-unit` 開頭的 `Runner CPU` step 印 `nproc`＋`lscpu` Model name。
- 下一步：累積 5 輪以上，對照 `Runner CPU` 與 log 的 vitest `Duration`。若與 CPU 數有關，試
  `--maxWorkers`（threads 預設＝可用核心數−1）後量。
- 剩餘成本：jsdom 仍佔 ~33%（約 124 檔宣告 `@vitest-environment jsdom`）。可選方向：
  - 逐檔檢查是否只為少數 DOM API 才用 jsdom，抽純邏輯改測純函式；
  - 評估 happy-dom（較快，但行為差異會讓既有斷言變動；依 `docs/build-modernization.md` 先寫評估紀錄）。

## 已判定不做

- **e2e 再多拆 shard／job**：每個 e2e job 固定成本 ~30–40s 拉 Playwright image（GitHub 不快取 container
  image）＋`yarn install` 10–20s；offline 兩 shard、adverse 三桶後各 job 只剩數分鐘，再拆不划算。
- **live e2e 不准並行**：共用 session 是 worker-scoped，多 worker＝多登入（CLAUDE.md「測試」節）。
- 容器裡 adverse runner 的 dev server 曾 180s 判不到（2026-10-01），根因 `unknown`。再發生時看
  `scripts/run-adverse-e2e.mjs#waitForDevServer` 附的 vite 輸出與各位址探測結果，不要重做猜測。
