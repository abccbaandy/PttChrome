# 查 bug、重現偶發紅與量測的實證做法

找不到根因、測試偶發紅、要量效能或 CI 時間時先讀。這裡只收**驗證過有效**的做法；
畫面判定類（用 upstream 原始碼產畫面）見 `docs/ptt-src-screens.md`「查 bug 的做法」，
CI 紅但與被測 code 無關見 `docs/ci-troubleshooting.md`。

## 偶發紅：整批跑才紅、單跑綠

- **unit**：同時開 4～6 支 `timeout 60 sh -c 'while :; do :; done' &` 吃滿 CPU，再單跑該檔。
  lazy 元件冷載入超過 `findByText` 的 1s、O(n²) 測試超過 5s 這兩類都是這樣重現出來的（#153），
  修完在同樣壓力下驗綠。
- **offline e2e**：本機 `--repeat-each 12 --workers 6`（必要時再加 busy loop）。壓不出來就不是單純
  CPU 不足：讓失敗訊息帶出事件紀錄（例 #159：pointer／mouse／click 的 target 與節點有沒有被換掉），
  再撞到時讀紀錄，不要盲目加壓。
- **CI 紅、本機單跑綠**：`gh run download <run> -R <owner>/<repo> -n e2e-offline-shard-N-attempt-1`
  拿 `error-context.md`（page snapshot 看得到 `#t` 的值）＋影片（`ffmpeg -vf fps=1` 抽格、
  `tile=6x4` 拼成一張看）。常見根因：重放 cassette 與套 pref 的先後（列表好讀要在重放前就關）、
  F4 後沒等輸入框 focus 就打字。本機要重現 CI 的開站方式加 `E2E_SERVER=bundle`。
- 停背景的 e2e：`pgrep -fa <pattern>` 查 PID 再 `kill <PID>`。`pkill -f <pattern>` 會連下指令的 shell
  一起殺（exit 144）。

## 等待類 helper 有沒有真的等到

看 CI log 的耗時，不要只看綠紅：曾有 helper 一半的 run 每次都逾時空等 15s（android-34 映像有時沒有
`mDisplayFrozen` 欄位，#337、#338）。逾時就把原文印出來，再用 flaky hunt 收集。

## 手機「點了沒反應／點了沒開文」

- **有 debug 錄製就先看錄製**（`yarn debug:screens <檔>`）：每下列表卡片 tap 都有 `listTap` 留痕
  （outcome＋target class）。`outcome:'not-card'`＋`target:'listCard'` ＝ tap 落在卡片間距（#271 的根因：
  舊版只認 `.listCardBody`，整張卡片 3em 裡上下 padding 共 0.6em 是間距）。其他 outcome：`selection`、
  `modal`、`aid-navigation`、`listSession.clickBusy`；根本沒有 `listTap` ＝ click 沒發。
- **離線重現**：臨時 offline-mobile spec（檔名 `mobile_*`），init script 在 window capture 記
  pointerdown／pointerup／mousedown／mouseup／click 的 target、`isConnected`、`getSelection().isCollapsed`，
  再掛 MutationObserver 看 `#mainContainer` 什麼時候被改。
- 瀏覽器事實：只有在 mousedown／mouseup handler 裡換掉手指下的節點才會吃掉 tap（`tests/e2e/README.md`）。
- 已修過的同類：#152 底色重畫換掉卡片、#231 兩下 tap 隔 <400ms 被當雙擊選字、#252 原生 80 欄列表留著
  選取 ⇒ click 發給舊節點。已排除：補頁落在按下與放開之間、慢手機手勢後 tap、卡片模式 11 種設定組合 × tap。

## DOM 節點有沒有被重建

給 `[data-row]` 做記號，觸發後數還 `isConnected` 的有幾個（#223）。tap 換節點：window capture＋bubble
兩段都掛 pointer／mouse／click，各記一次 `isConnected`。

## UI 自我檢查

- 臨時 offline spec（不 commit）截圖看圖：手機／桌機、暗色／淺色（localStorage `mantine-color-scheme-value`）、
  窄螢幕。手機的 offline-mobile 視窗只有 390 高，打開按鍵面板就是「放不下」的情境；會捲動視口的畫面
  （列表卡片、好讀）要查內容有沒有躲在 App Bar 後面（#320、#321）。
- CI 上點彈窗按鈕沒反應（#232、#244）：點之前 `helpers/layout.waitDialogSettled`／`waitRectStable`。
- 看 PTT 提問畫面要走真按鍵流程（#343）：直接餵 ptt-src-screens 的幀截不到我們自己的浮層（提示泡泡、
  底部導覽）；先餵到列表、tap 底部導覽鈕、再餵提問幀（`post_flow`／`reply_prompt`），才看得到浮層蓋不蓋提問。
- e2e 跑的期間改 `src/` 會 HMR 重載：下一項改動開 `git worktree` 寫。

## 效能

- 執行期：臨時 offline spec＋CDP `Emulation.setCPUThrottlingRate`（4 倍）量 rAF 間隔與 longtask。
- 冷開站：`yarn build`＋`npx vite preview`＋CDP `Network.emulateNetworkConditions`。

## CI／test 時間

- job 時間：`gh api repos/<owner>/<repo>/actions/runs/<id>/jobs`；step 時間：
  `gh api repos/<owner>/<repo>/actions/jobs/<id> --jq '.steps[]'`。android log 有
  `[android] launchBrowser／openScreen` 的秒數。
- 已做的加速：e2e 開站用打包版（`PTTCHROME_E2E_BUNDLE=1` 保留探針的 build＋vite preview，`E2E_SERVER=bundle`；
  dev server 的未打包模組是每條開站的大宗，#346、#347、#350）；android 的 APK 背景建跟系統映像還原重疊（#353）；
  android 模擬器 e2e 拆三片（#372、#373）。unit 的大宗是 `pref_modal_*`（PrefModal 整份 re-render）。
- 沒有 `/dev/kvm` 的環境跑不了 `yarn test:e2e:android`：android 的對照實驗用 Flaky Hunt dispatch
  （`suite=android`、`repeat=5`，ref 可以是 PR 分支），`grep` 吃 JS regex，排除測試用負向前瞻
  `^(?!.*(標題片段A|B))`；一次約 20 分鐘。
- 收斂 job 紅在 `test "abandoned" = success`、matrix job 根本沒出現在 jobs 清單 ＝ GitHub Actions 端故障：
  先查 `https://www.githubstatus.com/api/v2/incidents/unresolved.json`，有 Actions incident 就等恢復再整輪重跑
  （`rerun-failed` 只會重跑收斂 job，沒用）。
- Dependabot 升 Playwright 後 unit-browser 報「Executable doesn't exist」⇒
  `yarn install --immutable`＋`yarn playwright install chromium`。

## 依賴安全警示

- `yarn npm audit --all --recursive`；`proxy/*/` 各自 `npm audit --package-lock-only`。
- 傳遞相依的修正版在範圍內就 `yarn up -R <套件>`（#279）。
- Dependabot 警示由每天的 `Dependabot alerts` workflow 帶到 issue（`docs/ci-troubleshooting.md`）。

## 寫碼時的雷

- `term_view.js` 的 prototype 是一個大物件字面值：同名方法會靜默覆蓋，加方法前先 grep。
- 加設定分頁要改三處分類數守護：`pref_modal_narrow.test.jsx`、`pref_search_index.test.js`（含
  `PREF_SEARCH_TABS`）、`mobile_float_tools.offline.spec.js`。
- 重用同名工作分支開下一個 PR 時，查 CI 一定用 `yarn ci:status --sha <新 head 全長>`：剛 push 就用
  `--branch` 會拿到上一個 PR 的舊綠 run。
