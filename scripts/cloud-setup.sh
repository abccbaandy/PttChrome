#!/bin/bash
# pttchrome 雲端 session（Claude Code on the web）初始化。
# 雲端環境設定的 Setup script 欄位只放這兩行（不假設當下工作目錄就是 repo）：
#   f="$(find / -maxdepth 6 -path '*/scripts/cloud-setup.sh' -not -path '*/node_modules/*' 2>/dev/null | head -1)"
#   if [ -n "$f" ]; then bash "$f"; else echo "[setup] 找不到 scripts/cloud-setup.sh"; fi
# 改這份檔就好，不必再進環境設定改；新 session 生效。
#
# 這份會被環境快取：之後 dev 升了依賴（yarn.lock、@playwright/test），新 session 拿到的仍是舊快取。
# 那部分由 SessionStart hook 補（scripts/check-remote-commits.mjs 在 CLAUDE_CODE_REMOTE=true 時
# 自動 yarn install＋補裝瀏覽器），這裡只負責「從零到可用」。
# 非必要步驟失敗只印警告，不讓 session 起不來。說明見 docs/run-local.md「雲端 session」。
set -uo pipefail
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# ── 全程記 log（環境設定頁看不到輸出；session 裡 `cat` 這個檔就知道 setup 當時的狀況）──
LOG=/root/.cache/pttchrome-cloud-setup.log
mkdir -p "$(dirname "$LOG")" 2>/dev/null && exec > >(tee "$LOG") 2>&1
echo "[setup] $(date -u +%FT%TZ) 呼叫端工作目錄 = $PWD"

# ── 找到 repo 根目錄 ──
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)"
if [ -z "$REPO" ] || ! grep -q '"name": "pttchrome"' "$REPO/package.json" 2>/dev/null; then
  REPO="$(git rev-parse --show-toplevel 2>/dev/null || true)"
fi
if [ -z "$REPO" ] || ! grep -q '"name": "pttchrome"' "$REPO/package.json" 2>/dev/null; then
  REPO="$(dirname "$(grep -l '"name": "pttchrome"' $(find / -maxdepth 5 -name package.json -not -path '*/node_modules/*' 2>/dev/null) 2>/dev/null | head -1)" 2>/dev/null)"
fi
echo "[setup] repo = ${REPO:-<not found>}"
cd "$REPO" || { echo "[setup] 找不到 repo，略過專案安裝"; exit 0; }

# ── Node 24（對齊 CI）。雲端映像檔只有 /opt/node22、沒有 nvm；
#    /root/.local/bin 在 PATH 最前面，symlink 進去即可蓋過 22 ──
export PATH="/root/.local/bin:$PATH"
if [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 24 ]; then
  case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) ARCH="" ;; esac
  BASE=https://nodejs.org/dist/latest-v24.x
  TARBALL="$(curl -fsSL "$BASE/SHASUMS256.txt" | grep -o "node-v24[^ ]*-linux-$ARCH.tar.xz" | head -1)"
  if [ -n "$ARCH" ] && [ -n "$TARBALL" ]; then
    mkdir -p /opt/node24 /root/.local/bin
    curl -fsSL "$BASE/$TARBALL" | tar -xJ -C /opt/node24 --strip-components=1
    for b in node npm npx corepack; do ln -sf "/opt/node24/bin/$b" "/root/.local/bin/$b"; done
  else
    echo "[setup] WARN: 下載 Node 24 失敗，沿用 $(node -v)（Vitest 5 需 ≥22）"
  fi
fi
echo "[setup] node $(node -v) @ $(command -v node)"

# ── Yarn 4（版本由 packageManager 鎖定）──
corepack enable --install-directory /root/.local/bin
yarn --version

# ── 依賴 ──
yarn install --immutable || { echo "[setup] yarn install 失敗"; exit 1; }

# ── Playwright 瀏覽器 ──
# chromium 一併帶 headless shell（unit-browser 與 headless e2e 跑的是它）與 ffmpeg（失敗錄影）；
# firefox 給 offline-firefox project。版本跟著 node_modules 的 @playwright/test。
yarn playwright install --with-deps chromium firefox \
  || echo "[setup] WARN: Playwright 瀏覽器安裝失敗（可能是網路白名單），unit-browser／e2e 不能跑"

# ── 字型對齊 CI：排除 CI image 沒有的 DejaVu（否則 monospace 落到它，screen_sanity 格線必紅）──
# 理由與實測見 scripts/cloud-fonts.mjs 檔頭。舊環境（快取）由 SessionStart hook 補做。
node scripts/cloud-fonts.mjs || echo "[setup] WARN: 字型對齊失敗"

# ── pttbbs 原始碼（.gitignore 忽略，CLAUDE.md「PTT 邏輯不准猜」要讀它）──
# 之後的更新由 SessionStart hook scripts/sync-3rd-script.mjs 負責。
mkdir -p 3rd_script
[ -d 3rd_script/pttbbs/.git ] || git clone --depth 1 https://github.com/ptt/pttbbs 3rd_script/pttbbs \
  || echo "[setup] WARN: pttbbs clone 失敗"
[ -d 3rd_script/ptt-term/.git ] || git clone --depth 1 https://github.com/ptt/ptt-term 3rd_script/ptt-term \
  || echo "[setup] WARN: ptt-term clone 失敗"

echo "[setup] done"
