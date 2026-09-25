# 本機 e2e 環境問題對照表

判準通則：零 AssertionError、失敗案例耗時 0ms 或整批在 launch 階段就掛、同一支 spec 在別的 project／CI 全綠 ⇒ 環境問題，不要改被測 code。
（由 CLAUDE.md「測試」節搬出；那邊只留一行指標。）

- **Playwright 升版後（含 Dependabot bump）本機必跑 `yarn playwright install chromium`**：新版綁新 browser binary，
  沒裝會整批 e2e 秒掛（症狀：`browserType.launch: Executable doesn't exist`），與被測 code 無關。CI 每次都重裝所以不受影響。
  - 更早一步的症狀：`yarn test:e2e*` 直接 `command not found: playwright`＝**本機 node_modules 落後 lockfile**
    （Dependabot 升版後沒重裝）。修法 `yarn install --immutable` → `yarn playwright install chromium`，不是 script 壞了。
- **本機（Windows）連續開太多 Chromium 會整個 worker 掛掉**：`worker process exited unexpectedly
  (code=3221225794)`＝`STATUS_DLL_INIT_FAILED`（新進程連 DLL 都初始化不了）。判準＝**零
  AssertionError、失敗案例耗時 0ms、同批 spec 在一般 offline 全綠** ⇒ 環境問題，
  **不要因此去改被測 code**。這條已自動化：該 script 走 `scripts/run-adverse-e2e.mjs`
  （一桶一個獨立 playwright 進程＋冷卻＋只在命中指紋時 `--last-failed` 補跑；本機關掉錄影）。
  **exit code 分三種：0 綠／1 真失敗／2 環境問題**。逃生門 `--only=<桶,桶>`／`--batch=spec`／
  `--no-retry`。細節與「為何重用 BrowserContext 沒用」見 `docs/offline-replay-testing.md`。
- **Windows 上 Firefox 的 content sandbox 起不來時，那一批會整包 `browserContext.newPage: Test timeout`**
  （瀏覽器 log 只有 `RenderCompositorSWGL failed mapping default framebuffer`＋`remoteTab is null`＝content
  process 沒生出來，連空白頁都開不了，看起來卻像被測 code 大爆炸）。判準：**還原 code 後照樣紅**＝環境問題。
  修法已寫進 `playwright.config.js` 的 `offline-firefox` project：`launchOptions.env` 加
  `MOZ_DISABLE_CONTENT_SANDBOX=1`（2026-08-15 實測：headless/有頭、關 WebRender、關硬體加速、
  `security.sandbox.content.level=0`、關 fission/e10s 全都無效，只有這個有用）。
- **`browserType.launch: spawn UNKNOWN` ＝這台機器的 Firefox 二進位根本起不來**（2026-09-17 實測）：
  整批在 launch 階段就掛、**零 AssertionError**，`yarn playwright install firefox` 重裝也沒用，
  直接執行那顆 `firefox.exe` 會回 `Permission denied`（Windows 端的防毒／執行阻擋，非 Playwright
  也非被測 code）。判準：同一支 spec 在 `offline` (Chromium) project 全綠。處置＝**本機略過
  `offline-firefox`，靠 CI 那一輪**（Linux runner 不受影響），不要為此改被測 code 或 config。
