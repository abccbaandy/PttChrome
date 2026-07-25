# PttChrome 來源與 Origin 白名單約束

調查日期 2026-06-02。**結論：term.ptt.cc 就是 `robertabcd/PttChrome @ dev` 的建置產物；本 repo 以該 upstream 為唯一基底**（來源驗證 CONFIRMED——本機 build 的 logo asset 與線上站台逐位元相同）。

- **上游狀態**：`robertabcd/PttChrome:dev` 自 2023-12-08 起零提交（停滯但穩定，且為 PTT 實際服務之碼）。需要現代化就自己做，不追 upstream。
- **血緣**：`iamchucky/PttChrome`（最初 Chrome extension）→ `robertabcd/PttChrome`（web/term 版，term.ptt.cc 採用，預設分支 `dev`）。
- 曾評估兩個維護中 fork（`cf5146` TS+Vite 現代化、`ccns` Docker 部署）作為基底，**已棄用**（前者相對線上實證版分歧過大＋單人維護；後者含 CCNS 品牌與部署設定）。兩者仍在 GitHub，需要時可選擇性 cherry-pick。

## Origin 白名單（決定部署設計的根本約束）

實測（headless WebSocket）：

| Case | 連線 | Origin | 結果 |
|---|---|---|---|
| A | `wss://ws.ptt.cc/bbs` | `https://term.ptt.cc` | **OK**，101 + 首訊息 `HTTP/1.1 200 OK` + 畫面 |
| B | 同上 | `http://localhost:8080` | **拒絕**，`Expected 101 status code`、close 1002、0 bytes |

瀏覽器無法自設 `Origin`（forbidden header）⇒ 從 localhost／自有網域**直連必被擋**，必須有一層把 Origin 改寫成 `https://term.ptt.cc` 的東西。三條路：

1. **本機開發**：Vite dev server 內建 `/bbs` proxy 已改寫 Origin（`yarn start` 直連真 PTT，見 `run-local.md`）。
2. **純靜態部署**：自備會改寫 Origin 的反向 proxy（設定頁的「透過 proxy 連線」即為此），或部署在白名單網域。
3. **瀏覽器擴充**在網路層改寫 Origin（見 `origin-rewrite-extension.md`，延遲最低）。

## 端點（稽核 ground truth）

- 官方 BBS websocket：`wss://ws.ptt.cc/bbs`（Origin allowlist：`https://term.ptt.cc`）
- 連線 scheme：`wsstelnet://` → `wss:443`、`wstelnet://` → `ws:80`（解析於 `src/js/pttchrome.jsx`）
