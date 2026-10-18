// 雲端 session 的字型對齊 CI：把 CI image 沒有的 DejaVu 從 fontconfig 排除。
//
// 為什麼：終端機字型是 `MingLiu, monospace`（src/css/main.css），Linux 上沒有 MingLiu ⇒ 落到
// fontconfig 的 monospace。CI 的 e2e 跑在 Playwright 官方 image（.github/workflows/test.yml），
// 那裡 monospace＝WenQuanYi Zen Hei Mono；雲端容器多裝了 fonts-dejavu ⇒ monospace＝DejaVu Sans Mono，
// 字寬不同 ⇒ screen_sanity 的 gridMisaligned、recording_triage 的紅幀在雲端必紅、CI 卻綠
// （2026-10-18 實測：排除 DejaVu 後兩支 spec 17/17 綠；只排除 Inter 等其他多出來的字型仍紅）。
//
// 做法：`rejectfont` 設定檔（不 apt remove：別的套件相依它，也不必動系統套件）。冪等。
// 呼叫端：scripts/cloud-setup.sh（新環境）、scripts/check-remote-commits.mjs（SessionStart；
// Setup script 的結果被快取，舊環境靠它補）。只在雲端（CLAUDE_CODE_REMOTE=true）用，本機不碰。
// 守護 tests/unit/cloud_fonts.test.js。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const FONT_CONF_PATH = '/etc/fonts/conf.d/99-pttchrome-ci-parity.conf';
export const REJECT_DIRS = ['/usr/share/fonts/truetype/dejavu'];

export function fontConfXml(dirs = REJECT_DIRS) {
  const globs = dirs.map((d) => `      <glob>${d}/*</glob>`).join('\n');
  return `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<!-- pttchrome 雲端 session：字型對齊 CI 的 Playwright image（scripts/cloud-fonts.mjs）。 -->
<fontconfig>
  <selectfont>
    <rejectfont>
${globs}
    </rejectfont>
  </selectfont>
</fontconfig>
`;
}

// 回傳 'written'（這次寫了）／'present'（已經是這份內容）／'absent'（容器沒有這些字型，不必排除）。
// 寫不進去（權限）就 throw，由呼叫端決定要不要只印警告。
export function ensureCiFontParity({ fsImpl = fs, confPath = FONT_CONF_PATH, dirs = REJECT_DIRS } = {}) {
  const present = dirs.filter((d) => fsImpl.existsSync(d));
  if (!present.length) return 'absent';
  const xml = fontConfXml(present);
  try {
    if (fsImpl.readFileSync(confPath, 'utf8') === xml) return 'present';
  } catch {
    // 還沒寫過
  }
  fsImpl.mkdirSync(path.dirname(confPath), { recursive: true });
  fsImpl.writeFileSync(confPath, xml);
  return 'written';
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    console.log(`[cloud-fonts] ${ensureCiFontParity()}（${FONT_CONF_PATH}）`);
  } catch (e) {
    console.log(`[cloud-fonts] WARN: 寫不進 ${FONT_CONF_PATH}：${e.message}`);
  }
}
