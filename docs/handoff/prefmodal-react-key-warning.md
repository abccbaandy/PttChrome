# 一開設定頁就噴兩次 React「unique key」警告

狀態：**已知缺陷，未修**。**既有問題，非近期改動造成**（2026-09-16 做設定搜尋時盤到，
當時已用 `git stash` 在乾淨的 `dev` 上重現過，故未併入該次改動）。

## 現象（CONFIRMED，實測）

開啟 PrefModal 即固定噴兩次：

```
Each child in a list should have a unique "key" prop.
  Check the render method of `@mantine/core/Box`.
Each child in a list should have a unique "key" prop.
  Check the render method of `PrefModal`.
```

重現：`npx playwright test --project=offline ui_behavior -g "點 Settings"`，數 log 裡
`unique "key" prop` 的出現次數＝2。（**禁止接管線**取 exit code，見 CLAUDE.md；這裡只是數
字串，`grep -c` 可用。）

## 來源（`guess`，未逐行驗證）

`src/components/ContextMenu/PrefModal.jsx#replaceI18n`：

```js
i18n(id).split(/#(\S+)#/gi).map((it, index) => (index % 2 === 1 && it in replacements) ? replacements[it] : it)
```

回傳**陣列**，奇數位置換成 module 層 `replacements` 裡 `link()` 造好的 `<Anchor>` —— 那些
element 沒有 `key`。消費端是「關於」分頁的 `about_description` / `about_version_current` /
`about_version_original`。

**三處有問題但只噴兩次**（CONFIRMED，別誤以為只有兩處要修）：三個字串各含 2 個 `#...#`
佔位符、都會產出無 key 的 element；React 的 key 警告**以歸因元件型別去重**，而
`about_description` 包在 `<Text>`（→ 歸因 `@mantine/core/Box`）、另外兩個包在 `<li>`
（→ 歸因 `PrefModal`）⇒ 兩種歸因各噴一次。**修的時候三處一起修**，別只修到噴警告的那兩個
就收工（警告數會歸零，但第三處照樣沒有 key）。

Mantine Tabs 預設 keepMounted ⇒「關於」分頁不必被點開也會渲染 ⇒ 一開設定頁就噴。

排除：同分頁 `about_new_content` 的 `.map((text, index) => <li key={index}>…)` **已有 key**，不是它。

## 動手順序

1. 在 `replaceI18n` 的 map 加 key，確認警告歸零（次數由 2 → 0）。
2. **key 要加在 map 那一層，不能加在 `link()` 裡**：`replacements`（檔案模組層）是在載入時
   一次建好、三個字串共用同一批 `<Anchor>` 實例，在 `link()` 內給 key 等於三處共用同一個 key。
   純文字片段包 `<Fragment key={index}>`、或對 `replacements[it]` 用 `cloneElement(…, {key})`。
3. 補回歸測試（CLAUDE.md 強制，**先確認它在修之前是紅的**）：`tests/unit/` 新增一支
   RTL 測試，`vi.spyOn(console, "error")` 後 render `<PrefModal show />`，斷言沒有任何一次
   呼叫的訊息含 `unique "key" prop`。樣板抄 `tests/unit/pref_modal_search.test.jsx`
   （mock `pref_sync`／`prompt_api`，stub `matchMedia`／`ResizeObserver`／`scrollTo`；
   `document.fonts` 與 `Element.prototype.scrollIntoView` 已在 `tests/unit/setup.js` 補過）。

## 邊界

- 純 React 正確性，**不改任何畫面輸出** ⇒ 不動 i18n 字串、不動 `replacements` 的內容。
- 「關於」分頁的文字要可選取複製（`.PrefModal__about-selectable`），包 `Fragment` 不影響；
  若改成包 `<span>` 要確認沒破壞既有的 `user-select` 規則。
- 驗證：`yarn test:unit` 全綠 ＋ `npx playwright test --project=offline ui_behavior`。
- 這是**修 bug 不是新功能** ⇒ 不更新 README 功能列表。
