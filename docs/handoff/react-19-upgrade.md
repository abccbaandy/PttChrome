# React 16 → 19 升級評估（治本：解鎖現代 UI 元件庫）

狀態：**階段一（16→18）、階段二（18→19）已完成**（commit 見 git log）。**階段二.5（清技術債）未動工**——階段二為暫留 recompose/react-test-renderer 留下 3 個過渡橋接，須在此階段治本清掉。階段三（UI 庫選型）未動工。動工前先讀本檔全文。

> 階段順序：階段二.5（清債）**先於**階段三（UI）。理由：階段三是換 UI 元件庫（治本目標），不是清債；先把 deprecated 依賴與橋接 hack 清乾淨，階段三才不會在腐朽地基上疊加。符合 CLAUDE.md「遇坑優先升級換套件、別堆疊 workaround」。

## 階段一完成紀錄（16→18，CONFIRMED）

- react / react-dom / react-test-renderer 全升 `^18.3.1`（`package.json`）。
- 新增 `src/js/react_root.js`：`renderInto`/`unmountFrom`，WeakMap cache root per container（React 18 同容器重複 `createRoot` 會警告；`#reactAlert` 多 modal 共用 → 必須 cache，unmount 後 delete 讓下個 modal 取新 root）。
- 8 處 `ReactDOM.render`/`unmountComponentAtNode` → `createRoot` API（`term_ui.js`、`pttchrome.js` ×3+2、`main.js`）。載入機制**未動**（UMD CDN global 仍在，階段二才換）。
- **`renderScreen` instance-handle**：React 18 `root.render()` 回傳 `undefined`，但 `term_view.js` 需命令式呼叫 `Screen.setCurrentHighlighted`。改用 `React.createRef()` + 穩定 handle（`screenHandles` WeakMap），handle 方法 lazy 解 `ref.current`。呼叫端 `term_view.js:393/422` 與 fallback `:100` 介面不變。
- **踩坑（重要，下次階段二務必沿用）**：React 18 `root.render()` **預設非同步 flush**。本 app 建立在 React 16 同步契約上——`term_view.js:370` 在 `_renderScreenLines` 後**立即** `setHighlightedRow`（需 `ref.current` 已 commit），好讀模式 render 後量測 scrollTop/高度。最初 live e2e「看板列表黑名單」紅（同步讀 DOM 看到舊畫面）。解法：`renderInto` 內包 `ReactDOM.flushSync(() => root.render(el))` 還原同步 commit。這些呼叫點皆來自 websocket/DOM/init handler（非 React event），flushSync 安全；React 16 本就同步，無效能回退。**階段二換載入機制/ESM 後，flushSync 仍須保留。**
- 驗證全綠：`yarn build` + `test:unit`(223) + `test:e2e:offline`(27) + live `enhance.spec.js`(12) + live `easy-reading.spec.js`(4)。

## 階段二完成紀錄（18→19，CONFIRMED）

- react / react-dom / react-test-renderer 全升 `^19.2.0`（解析到 19.2.7）（`package.json`）。
- **載入機制換 bundle**（阻點 1 清）：React 19 無 UMD。移除 `webpack.config.js` `externals` 的 react/react-dom（**保留** `jquery`）；`src/dev.html` 移除 react/react-dom 兩個 CDN `script`（保留 jQuery/hammer/bootstrap CSS）。
- **ProvidePlugin 供 global React**：`webpack.config.js` 加 `new webpack.ProvidePlugin({ React: 'react' })`，取代原 CDN 注入的 `window.React`，讓沿用 classic JSX runtime + `React.*` 的檔（`Screen.js`/`ImagePreviewer.js`/`term_ui.js` 等沒 import React 者）照常解析。
- **`react_root.js` 改顯式 import**：React 19 把 `createRoot` 移到 `react-dom/client`（`react-dom` 不再 re-export）→ `import { createRoot } from "react-dom/client"`；`flushSync` 仍 `from "react-dom"`。`flushSync` 同步契約保留不動（沿用階段一）。
- **react-bootstrap 2.10.10 × React 19：CONFIRMED ok**（阻點 4 結論）。peerDeps `react:">=16.14.0"` 上界開放不擋。`ui_behavior.offline.spec.js`（offline 27 綠內）在真 bundle 上跑通 Modal/Tab/Nav/Form/OverlayTrigger/Popover/SplitButton/NavDropdown/Fade/DropdownMenu → **無 `findDOMNode` 崩潰**，不需升 RB。
- **`recompose` × React 19：實測會炸 → 加 createFactory 橋接**。React 19 移除 `createFactory`（自 16.13 deprecated），recompose@0.26 每個 HOC 都 `createFactory(BaseComponent)` → runtime `createFactory is not a function`。橋接：`src/js/react_compat.js`（CJS spread 真 react + 補 `createFactory`）+ `webpack.config.js` `resolve.alias` `react$`→compat、`react-real$`→`require.resolve('react')`（絕對路徑繞過 react@19 `exports` 封鎖 `react/index.js`）。**這是過渡橋接，階段二.5 清。**
- **`react-test-renderer@19` 實測 render 成 null → setup.js 包 act()**。React 19 test-renderer 預設 concurrent，初次 mount 不同步 commit。`tests/unit/setup.js` 加 `global.IS_REACT_ACT_ENVIRONMENT=true` + monkeypatch `TestRenderer.create` 包 `renderer.act()`，3 個 render 測試零改動沿用。**這是過渡橋接，階段二.5 清。**
- 驗證全綠：`yarn build`（零警告）+ `test:unit`(223) + `test:e2e:offline`(27) + live(12＝connect-login 1＋easy-reading 4＋enhance 7)。

## 階段二.5（清技術債，CONFIRMED 待動工）

階段二為「暫留 deprecated 套件」留下的橋接須在此治本，並一併清其他過時依賴/寫法。**用升級/換套件治本，不再堆 workaround（CLAUDE.md 規範）。**

優先（階段二橋接的根因，三者連動）：

| # | 債 | 現有橋接（要刪） | 治本 |
|---|---|---|---|
| 1 | **recompose@0.26 deprecated**（用 React 19 已移除的 `createFactory`；peer 僅 react^16） | `src/js/react_compat.js` + `webpack.config.js` `react$`/`react-real$` alias | 6 元件改 hooks（`PrefModal`/`ContextMenu/index`/`InputHelperModal`/`LiveHelperModal`/`DropdownMenu`/`ConnectionAlert`，`useState`/`useCallback`/`useEffect`）→ 移 recompose dep + 整個 compat shim + alias。`index.js` 的 `withProps` side-effect 反模式要轉 `useEffect`。守門：`ui_behavior.offline.spec.js`。 |
| 2 | **react-test-renderer@19 deprecated**（且需 act() 才 render） | `tests/unit/setup.js` 的 `create` monkeypatch + `IS_REACT_ACT_ENVIRONMENT` | 遷 `@testing-library/react` + jsdom env（`jest.config.js` `testEnvironment` 改 jsdom 或 per-file docblock）→ 改寫 `row_render`/`image_preview`/`screen_dropHidden` → 移 test-renderer dep + setup patch。 |
| 3 | **classic JSX runtime + ProvidePlugin（global React）** 為舊寫法 | `ProvidePlugin({React})` + 各檔靠 global `React` | babel `@babel/preset-react` 三段加 `runtime:"automatic"`；對用 `React.Component`/`createRef`/`Fragment`/`PureComponent` 的檔補顯式 import（`Screen.js`/`ImagePreviewer.js`/`term_ui.js` 等）→ 移 ProvidePlugin + setup.js 的 `global.React`。 |

其他過時依賴/警告（同階段一併清，動工前各自確認版本與 breaking change）：

- `prettier ^1.19.1`（current 3.x；升版會改格式 → 需一次 reformat + 對 lint-staged）。
- `husky ^4.2.3`（current 9.x，設定格式大改）、`lint-staged ^10`（current 15.x）。
- `bootstrap` peer 缺 `@popperjs/core@^2`（yarn install warning）→ 補 devDep（RB 用到 Popper 定位）。
- `@babel/plugin-syntax-dynamic-import` + `babel-plugin-dynamic-import-node`：dynamic import 早已原生，preset-env 已含 → 可移。
- yarn install 的 `url.parse()` DEP0169：來自某工具鏈，升級相依後應消。
- 動工前重跑 `yarn build` 收集當下所有 webpack warning、`yarn install` 收集所有 peer warning，逐條歸零或記錄為已知。

下列原始評估內容保留供階段二.5/三參考。

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
| react / react-dom | `^19.2.0`（階段二已升） | `package.json` |
| 載入機制 | **bundled**（階段二已換）：webpack bundle + `ProvidePlugin({React})`；`externals` 只剩 jquery；dev.html 只剩 jQuery/hammer CDN | `webpack.config.js`、`src/dev.html` |
| react-bootstrap | `^2.10.10`（bundled import；× React 19 已 CONFIRMED ok） | `package.json:13` |
| recompose | `^0.26.0`（**deprecated**；React 19 需 `react_compat.js` 補 `createFactory` 才跑；階段二.5 清） | `package.json:15`、`src/js/react_compat.js` |
| 單元測試渲染器 | `react-test-renderer ^19.2.0`（deprecated；需 setup.js act() patch；階段二.5 遷 testing-library） | `package.json`、`tests/unit/setup.js` |
| 渲染入口 | `createRoot`（`src/js/react_root.js` 集中，已改 `react-dom/client` 顯式 import） | `term_ui.js`、`pttchrome.js`、`main.js` |

良性現況：自家 code **無** `findDOMNode`、**無** 舊式 lifecycle（`componentWillReceiveProps` 等已遷走，見 `Screen.js:141`）、**無** string ref。遷移面比典型 React 16 專案乾淨。

## 硬阻點（CONFIRMED，動工必處理）

1. ~~**React 19 移除 UMD build**~~ **階段二已解**：bundle React 進 webpack + `ProvidePlugin({React})`，移除 `externals` react/react-dom、dev.html 拿掉兩個 CDN `script`。（原文保留供回顧。）

2. ~~**`ReactDOM.render` → `createRoot`**~~ **階段一已完成**：集中到 `src/js/react_root.js`（WeakMap cache root per container + `flushSync` 同步契約）。`unmountComponentAtNode` → `unmountFrom`（unmount 後 delete cache）。

3. **`react-test-renderer` 在 React 19 deprecated**（且需 act()）→ 階段二暫以 setup.js act() patch 橋接；**階段二.5** 改寫 `row_render`/`image_preview`/`screen_dropHidden` 到 `@testing-library/react`（+ jsdom env）。

4. ~~**react-bootstrap 2 × React 19 相容性 `unknown`**~~ **階段二已查證 CONFIRMED ok**：RB2 在 React 19 無 `findDOMNode` 崩潰（`ui_behavior.offline.spec.js` 跑通全部 RB 元件），不需升 RB。

5. **`recompose` deprecated**（且用 React 19 已移除的 `createFactory`）→ 階段二暫以 `react_compat.js` createFactory shim 橋接；**階段二.5** 把 6 元件改寫成 hooks 後移除 shim。pointer：各檔 `from "recompose"`。

## 相容性待查清單（動工前各打一個 CONFIRMED/紅）

- `firebase ^12`：支援 React 19？（與 React 版本基本解耦，預期 ok）
- `classnames`、`hammerjs`、`jquery`：與 React 無關，預期 ok
- `react-bootstrap`：見阻點 4
- jest/babel 鏈：`@testing-library/react` 取代 test-renderer 後的 env 設定

## 建議階段（先穩後治本）

- ~~**階段一 16→18**（風險低）：升 react/react-dom 18；`ReactDOM.render`→`createRoot`（阻點 2）；UMD 仍在、載入機制不動；`react-test-renderer` 18 仍可用暫留。~~ **已完成**（見頂部完成紀錄；額外需 `flushSync` 還原同步契約）。
- ~~**階段二 18→19**：處理阻點 1（bundle React、改載入）、3（測試遷移）、4（RB 相容）。~~ **已完成**（見「階段二完成紀錄」；阻點 1/4 清，3 暫以 act() patch 橋接留階段二.5；recompose 以 createFactory shim 橋接留階段二.5）。
- **階段二.5 清技術債**：見上「階段二.5」段。清 3 個橋接（recompose→hooks、test-renderer→testing-library、JSX automatic runtime）+ 過時依賴（prettier/husky/lint-staged 升版、補 @popperjs/core peer、移冗餘 babel dynamic-import plugin）。**先於階段三**。
- **階段三 選型 + 試點**：選一套元件庫（Mantine/MUI/Chakra，皆 React 18+），**以 `PrefModal` 為第一個試點**（最痛、最受益、e2e 守門已備：`tests/e2e/offline/ui_behavior.offline.spec.js`），逐步替換手刻 UI。

## 決策點（`guess`/`unknown`，動工時與使用者確認）

- UI 庫選型：Mantine（自帶完整表單/設定型元件、CSS 變數主題）vs MUI（生態最大）vs Chakra。`guess`：Mantine 最貼「設定頁、少寫 CSS」訴求。
- 保留 react-bootstrap 並存，還是一次換掉？`unknown`：取決於阻點 4 的查證結果。
- 直接 16→19，或經 18 落地？建議**經 18**（階段一可獨立交付、可回退）。

## e2e 重測範圍（階段一/二後必跑）

渲染/畫面耦合路徑（CLAUDE.md 強制）：`term_view.js`、`term_ui.js`、`pttchrome.js`、`src/components/**`、`easy_reading.js`、`term_buf.js`。
至少 `yarn test:e2e`（`easy-reading.spec.js`+`enhance.spec.js`）+ `yarn test:e2e:offline` 全綠。
