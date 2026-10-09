// live 錄製檔自動分流成待轉素材（`yarn triage:recordings`，project `offline-triage`，零網路零登入）。
//
// 每卷錄製檔一條 test：逐幀重放進真瀏覽器、每幀 settle 後跑 screenSanity；紅了就把
// 「最近的整頁重繪 → 紅幀」切成 cassette，redact＋把關後寫到 tests/e2e/cassettes/pending/
// （gitignored），並寫一份 `<錄製檔名>.list.json` 清單（哪一幀、哪個時間點、哪條 live test、
// 哪種違規、切段有沒有在新頁面重現）。**全綠不產出任何東西**（同時清掉該卷上一輪的產物）。
// 有紅幀時 test 判紅 ⇒ exit code 就是結論。
//
// 輸入：env TRIAGE_RECORDINGS＝逗號分隔的檔案或目錄（例：使用者給的 ptt-debug-*.json），
// 預設 tests/e2e/__recordings__/。流程與限制見 docs/offline-replay-testing.md「live 錄製檔分流」。
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { RECORDINGS_DIR } = require('../helpers/recording');
const { PENDING_DIR, pendingBase, writePending, envRedact } = require('../helpers/recording_triage');
const { triageToPending } = require('../helpers/triage_runner');

function recordingFiles() {
  const inputs = (process.env.TRIAGE_RECORDINGS || RECORDINGS_DIR).split(',').map((s) => s.trim()).filter(Boolean);
  const files = [];
  for (const p of inputs) {
    if (!fs.existsSync(p)) continue;
    if (fs.statSync(p).isDirectory())
      for (const f of fs.readdirSync(p).filter((n) => n.endsWith('.json')).sort()) files.push(path.join(p, f));
    else files.push(p);
  }
  return files;
}

const files = recordingFiles();

test.describe('錄製檔分流', () => {
  if (!files.length)
    test('沒有錄製檔', () => {
      test.skip(true, '找不到錄製檔（TRIAGE_RECORDINGS 或 tests/e2e/__recordings__/）：先跑一輪 live e2e');
    });

  for (const file of files) {
    const base = pendingBase(file);
    test(base, async ({ page }) => {
      test.setTimeout(15 * 60 * 1000);
      const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(rec.cassette && rec.cassette.steps, `${base}：不是 DebugRecorder 錄製檔（沒有 cassette.steps）`).toBeTruthy();
      if (!envRedact().ids.length)
        console.log(`[triage] ${base}：env 沒有 PTT_USER，再 redact 只能遮 IP；帳號靠錄製時的 redact`);

      const { entries, summary } = await triageToPending(page, rec, file);
      const written = writePending(PENDING_DIR, base, entries, summary);
      console.log(`[triage] ${base}: ${JSON.stringify(summary)}`);
      // 整卷沒有整頁重繪幀 ⇒ 一幀都沒檢查。這不是「全綠」，是「沒驗」，要明講。
      expect(summary.checked, `${base}：沒有可檢查的幀（找不到第一次整頁重繪）`).toBeGreaterThan(0);
      for (const e of entries)
        console.log(
          `[triage]   frame ${e.frame} (step ${e.step}, t=${e.t}ms, ${e.test || '不在 test 內'}) ` +
            `${e.violations.join('+')} ×${e.runFrames} | cut ${e.cut.kind}@${e.cut.frame} reproduced=${e.reproduced}`
        );
      expect(
        written.map((f) => path.basename(f)),
        `${base}：有 ${summary.failingFrames} 幀跑版／亂碼，待轉素材在 tests/e2e/cassettes/pending/${base}.list.json`
      ).toEqual([]);
    });
  }
});
