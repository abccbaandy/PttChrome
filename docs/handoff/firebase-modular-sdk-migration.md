# Firebase compat CDN → modular SDK 回遷

## 為什麼

webpack5 升級（2026-06）已解除「`yarn add firebase` 炸 build」的限制（webpack4 acorn 不認 ES2020 的歷史成因見 `docs/pref-sync-firestore.md`）。目前 `src/js/pref_sync.js` 仍用 runtime 注入 gstatic compat scripts（pin `10.14.1`）＋全域 `window.firebase`，可改成 npm modular SDK：版本由 lockfile 管理、tree-shaking、不依賴 gstatic CDN。

## 範圍

| 項目 | 動作 |
|---|---|
| `yarn add firebase` | 新增 dependency（modular v10+） |
| `src/js/pref_sync.js` | 移除 compat script loader，改 `import { initializeApp } from 'firebase/app'` 等。API 對應：`firebase.auth()` → `getAuth`、`signInWithPopup`、`firebase.firestore().collection("users").doc(uid)` → `doc(db, "users", uid)`、`onSnapshot(docRef, cb)` |
| lazy-load 語意保留 | 現在是「曾登入或按登入鈕才載 SDK」→ modular 下改 dynamic `import()`（webpack 拆 chunk），維持未登入者零下載 |
| `tests/unit/pref_sync.test.js` | **大工程**：現以假 `window.firebase` compat 全域（攔 `document.head.appendChild` 餵假 SDK）重播全流程；modular 後需改 `jest.mock('firebase/app')` 等模組層 mock，全部重寫 |
| 不動 | `pref_sync_logic.js`、`pref_storage.js`、PrefModal（介面不變） |

## 驗收

- `yarn test:unit` 全過（pref_sync 流程測試改寫後仍涵蓋：啟動還原 / 他機推播 / echo skip / offline 守門 / signIn / signOut / TDZ 回歸）
- 手動：登入 → 改偏好 → 另一瀏覽器同步收到；登出不噴 permission-denied
- 未登入開頁：network 無任何 firebase 請求（lazy chunk 未載）
