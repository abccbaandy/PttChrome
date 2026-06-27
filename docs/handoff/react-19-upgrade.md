# React 16 → 19 升級評估（治本：解鎖現代 UI 元件庫）

狀態：**階段一（16→18）已完成**（commit 見 git log）。階段二（18→19）、階段三（UI 庫選型）`評估`未動工。動工前先讀本檔全文。

## 階段一完成紀錄（16→18，CONFIRMED）

- react / react-dom / react-test-renderer 全升 `^18.3.1`（`package.json`）。
- 新增 `src/js/react_root.js`：`renderInto`/`unmountFrom`，WeakMap cache root per container（React 18 同容器重複 `createRoot` 會警告；`#reactAlert` 多 modal 共用 → 必須 cache，unmount 後 delete 讓下個 modal 取新 root）。
- 8 處 `ReactDOM.render`/`unmountComponentAtNode` → `createRoot` API（`term_ui.js`、`pttchrome.js` ×3+2、`main.js`）。載入機制**未動**（UMD CDN global 仍在，階段二才換）。
- **`renderScreen` instance-handle**：React 18 `root.render()` 回傳 `undefined`，但 `term_view.js` 需命令式呼叫 `Screen.setCurrentHighlighted`。改用 `React.createRef()` + 穩定 handle（`screenHandles` WeakMap），handle 方法 lazy 解 `ref.current`。呼叫端 `term_view.js:393/422` 與 fallback `:100` 介面不變。
- **踩坑（重要，下次階段二務必沿用）**：React 18 `root.render()` **預設非同步 flush**。本 app 建立在 React 16 同步契約上——`term_view.js:370` 在 `_renderScreenLines` 後**立即** `setHighlightedRow`（需 `ref.current` 已 commit），好讀模式 render 後量測 scrollTop/高度。最初 live e2e「看板列表黑名單」紅（同步讀 DOM 看到舊畫面）。解法：`renderInto` 內包 `ReactDOM.flushSync(() => root.render(el))` 還原同步 commit。這些呼叫點皆來自 websocket/DOM/init handler（非 React event），flushSync 安全；React 16 本就同步，無效能回退。**階段二換載入機制/ESM 後，flushSync 仍須保留。**
- 驗證全綠：`yarn build` + `test:unit`(223) + `test:e2e:offline`(27) + live `enhance.spec.js`(12) + live `easy-reading.spec.js`(4)。

下列原始評估內容保留供階段二/三參考。

## 動機（why）

設定/選單 UI 反覆出小 bug（漏 id、脆弱 CSS、BS adapter shim）的根因＝**手刻 CSS 在補/打架框架**。
治本＝**改用有人維護、自帶一致樣式的元件庫**（Mantine/MUI/Chakra…）。但這些庫幾乎全要 **React 18+**。
React 16 是那道關著的門。故「換掉手刻 UI」與「升 React」是**同一個專案**，React 升級是前置。

## 紅利落點（誠實分層）

| 面向 | 幫助 | 說明 |
|---|---|---|
| UI/開發 | **大** | 解鎖現代元件庫 → 設定頁不再手刻 CSS。`useId`（本可免去這輪 checkbox 漏 id bug）、React 19 Actions/`useFormStatus`（設定表單適用）、React Compiler 自動 memo |
| 依賴健康 | **中** | 清掉 deprecated `recompose`；脫離 React 16 生態漂移（越來越多套件棄 16） |
| 終端機核心功能 | **幾乎無** | app 瓶頸在 canvas/DOM 逐列渲染，非 React reconciliation；concurrent/自動批次對 BBS 本體**使用者無感**。不要用「app 變快」說服自己 |

結論：值得升，但價值是「解鎖 UI 庫 ＋ 清死依賴」，非「更快/更多功能」。

## 現況（CONFIRMED）

| 項 | 值 | pointer |
|---|---|---|
| react / react-dom | `^18.3.1`（階段一已升） | `package.json` |
| 載入機制 | **CDN UMD global**（`React`/`ReactDOM`），webpack `externals` 映射 + `dev.html` CDN `script` 標籤（階段一未動，階段二要換） | `webpack.config.js:38-42`、`src/dev.html` |
| react-bootstrap | `^2.10.10`（bundled import，非 CDN） | `package.json:13` |
| recompose | `^0.26.0`（**deprecated 套件**，peer dep 警告 react16，仍可跑；階段三清） | `package.json:15` |
| 單元測試渲染器 | `react-test-renderer ^18.3.1`（階段一已升；19 deprecated，階段二遷 testing-library） | `package.json`、`tests/unit/row_render.test.js` |
| 渲染入口 | 階段一已改 `createRoot`（`src/js/react_root.js` 集中） | `term_ui.js`、`pttchrome.js`、`main.js` |

良性現況：自家 code **無** `findDOMNode`、**無** 舊式 lifecycle（`componentWillReceiveProps` 等已遷走，見 `Screen.js:141`）、**無** string ref。遷移面比典型 React 16 專案乾淨。

## 硬阻點（CONFIRMED，動工必處理）

1. **React 19 移除 UMD build** → 現行「CDN global + `externals`」模式在 19 **不可行**。
   必須改成 bundle React 進 webpack（移除 `externals` 的 react/react-dom，dev.html 拿掉 React/ReactDOM 的 CDN `script`），或改用 ESM CDN（esm.sh）。**這是 18→19 的最大架構改動。**
   注：**React 18 仍有 UMD** → 階段一可暫不動載入機制，降風險。

2. ~~**`ReactDOM.render` → `createRoot`**~~ **階段一已完成**：集中到 `src/js/react_root.js`（WeakMap cache root per container + `flushSync` 同步契約）。`unmountComponentAtNode` → `unmountFrom`（unmount 後 delete cache）。

3. **`react-test-renderer` 在 React 19 deprecated** → `tests/unit/row_render.test.js` 需改寫到 `@testing-library/react`（+ jsdom env）。

4. **react-bootstrap 2 × React 19 相容性 `unknown`** → RB2 內部用 `findDOMNode`（React 19 已移除）。
   動工前先查 RB 官方對 React 19 的支援狀態；可能需升 RB、或**正好接力換成新 UI 庫**（見下）。

5. **`recompose` deprecated** → 6 元件用它（`PrefModal`/`index`/`InputHelperModal`/`LiveHelperModal`/`DropdownMenu`/`ConnectionAlert`），改寫成 hooks（`useState`/`useCallback`/`useEffect`）。React 16.8 起就能做，升級是順手清的時機。pointer：各檔 `from "recompose"`。

## 相容性待查清單（動工前各打一個 CONFIRMED/紅）

- `firebase ^12`：支援 React 19？（與 React 版本基本解耦，預期 ok）
- `classnames`、`hammerjs`、`jquery`：與 React 無關，預期 ok
- `react-bootstrap`：見阻點 4
- jest/babel 鏈：`@testing-library/react` 取代 test-renderer 後的 env 設定

## 建議階段（先穩後治本）

- ~~**階段一 16→18**（風險低）：升 react/react-dom 18；`ReactDOM.render`→`createRoot`（阻點 2）；UMD 仍在、載入機制不動；`react-test-renderer` 18 仍可用暫留。~~ **已完成**（見頂部完成紀錄；額外需 `flushSync` 還原同步契約）。
- **階段二 18→19**：處理阻點 1（bundle React、改載入）、3（測試遷移）、4（RB 相容）。
- **階段三 選型 + 試點**：選一套元件庫（Mantine/MUI/Chakra，皆 React 18+），**以 `PrefModal` 為第一個試點**（最痛、最受益、e2e 守門已備：`tests/e2e/offline/ui_behavior.offline.spec.js`），逐步替換手刻 UI。

## 決策點（`guess`/`unknown`，動工時與使用者確認）

- UI 庫選型：Mantine（自帶完整表單/設定型元件、CSS 變數主題）vs MUI（生態最大）vs Chakra。`guess`：Mantine 最貼「設定頁、少寫 CSS」訴求。
- 保留 react-bootstrap 並存，還是一次換掉？`unknown`：取決於阻點 4 的查證結果。
- 直接 16→19，或經 18 落地？建議**經 18**（階段一可獨立交付、可回退）。

## e2e 重測範圍（階段一/二後必跑）

渲染/畫面耦合路徑（CLAUDE.md 強制）：`term_view.js`、`term_ui.js`、`pttchrome.js`、`src/components/**`、`easy_reading.js`、`term_buf.js`。
至少 `yarn test:e2e`（`easy-reading.spec.js`+`enhance.spec.js`）+ `yarn test:e2e:offline` 全綠。
