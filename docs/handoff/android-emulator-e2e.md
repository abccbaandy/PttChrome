# Android 模擬器 e2e：剩 CI 這一段

狀態：**本機完成**（`yarn test:e2e:android`；設計／踩坑／CONFIRMED 事實全在 `docs/android-e2e.md`，先讀它）。
本機驗證：全新 AVD 冷開機＋連跑共 5 輪全綠；修法改回舊規則 ⇒ 主 spec 紅（exit 1）。
剩下：在 CI 上量抖動，決定要不要接成 job。**CI 從未跑過這套**，spike workflow 是寫好未執行的。

## 待辦

1. 跑 spike：`.github/workflows/android-e2e-spike.yml`（matrix 20 次平行＋`summary` job 把結果表寫進 step summary）。
   - 檔案已在 `dev`（預設分支）⇒ 直接 dispatch，**不用開分支**：
     `POST /repos/{owner}/{repo}/actions/workflows/android-e2e-spike.yml/dispatches`，body `{"ref":"dev"}`（`GH_TOKEN`）。
     workflow 另留 `push: spike/android-e2e` 觸發，用不到可刪。
   - 每個 run 的 artifact `spike-N`：`result.json`（verdict／bootSeconds）、`e2e.log`、`test-results/`
     （失敗時有 `device-screen.png`＝整個螢幕、`logcat-crash` 附件）。
   - verdict 定義（Classify step）：`pass`＝exit 0；`test-fail`＝exit 1；`env`＝exit 2；`boot-fail`＝emulator-runner
     沒跑到 script（沒有 `e2e.exit`）。
2. 結果填進 `docs/android-e2e.md`「CI spike」節（verdict 次數、開機秒數 min／中位數／max、失敗分類）。
   判準：`test-fail` 一次都不接受（先查是不是新的環境因素被誤判成斷言紅，例如本機曾發生的 `device.wait`
   漏看）；`env`／`boot-fail` 是基礎設施 ⇒ 可在 job 內重試**開機**（不重試測試）。
3. 數據可接受 ⇒ `.github/workflows/test.yml` 加平行 job `test-e2e-android`（每次都跑，使用者已同意），
   內容＝spike 的單次 job 去掉 matrix／Classify，script 直接 `node scripts/run-android-e2e.mjs --no-boot`
   讓 exit code 決定紅綠；失敗上傳 `test-results/`。新增 job 的步驟順序與 required checks 見
   `docs/ci-troubleshooting.md`。降不下來 ⇒ 先 non-required，判讀方式寫進 `docs/ci-troubleshooting.md`。
4. 做完刪掉 spike workflow，再刪本檔。

## 已知要注意（CI 才會遇到）

- 本機跑的是 Windows＋WHPX；CI 是 ubuntu＋KVM（workflow 已有 udev 開 `/dev/kvm` 權限的 step）。
- `run-android-e2e.mjs --no-boot` 只用已在跑的模擬器；emulator-runner 開的序號是 `emulator-5554`，
  `pickEmulatorSerial` 會自己挑到。fixture 的 `hide_error_dialogs`／通知權限／斷網／轉送在 CI 一樣會做。
- `playwright install android`（driver APK）由執行器每次呼叫，CI 不用另加 step。

## UNVERIFIED（只有 CI 能回答）

- ubuntu runner 上 vite 綁哪個位址：fixture 的 IPv4 轉送兩種都能接，理論上無差。
- emulator-runner 用 sdkmanager 裝的 `system-images;android-34;google_apis;x86_64` 是否與本機同版
  （本機 r14，Chrome 113）。Chrome 版本若不同，`docs/android-e2e.md` 的 GPU 當機結論要重驗。
- 本機抓到的偶發源（Chrome GPU 當機對話框、`device.wait` 漏看、`launchBrowser` 卡住）都已處理；
  Linux＋無 GPU 可能有新的，看 artifact 的 `device-screen.png`／`logcat-crash`。
