// 錄製檔分流（tools/triage-recordings.spec.js）的自證：工具本身要有牙齒、也要安靜。
//
// 真的 live 錄製檔是 gitignored 的，CI 拿不到 ⇒ 這裡用已入庫的 scenario 卷合成一份
// 「錄製檔」（events＋cassette，同 DebugRecorder 的 schema），再在中間某個 step 尾端
// 注入一個壞幀（Big5 `0x81 0x30` 在轉碼表裡查不到 ⇒ decodeFail）：
//   1. 乾淨的卷：零紅幀、writePending 什麼都不寫（連目錄都不建）。
//   2. 注入的卷：恰好在注入那一幀第一次紅；切出來的段在新頁面重放 buf 逐格相同且違規重現；
//      寫出的待轉 cassette 本身再拿去分流，紅在最後一幀（素材自足、可直接重放）。
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { loadCassette } = require('../helpers/replay');
const T = require('../helpers/recording_triage');
const { triageRecording, triageToPending } = require('../helpers/triage_runner');

const SOURCE = loadCassette('scn-list-bracket');
const BAD_STEP = 3;
const BAD_FRAME = '\x1b[?2026h\x1b[5;10H\x81\x30\x1b[?2026l';

const b64d = (s) => Buffer.from(s || '', 'base64').toString('latin1');
const b64e = (s) => Buffer.from(s, 'latin1').toString('base64');

// cassette → DebugRecorder 形狀的錄製檔（每個 step：一個 send＋一個 recv 事件）。
function synthRecording(cassette, inject) {
  const steps = cassette.steps.map((s, i) =>
    Object.assign({}, s, i === inject ? { recv: b64e(b64d(s.recv) + BAD_FRAME) } : {})
  );
  const events = [{ t: 0, dir: 'log', tag: 'test.begin', info: { title: 'synthetic' } }];
  steps.forEach((s, i) => {
    if (s.on !== 'start') events.push({ t: i * 10 + 1, dir: 'send', data: s.send || b64e('x') });
    events.push({ t: i * 10 + 5, dir: 'recv', data: s.recv });
  });
  return { meta: { mode: 'debug' }, events, cassette: { cols: cassette.cols, rows: cassette.rows, steps } };
}

test.describe('錄製檔分流（自證）', () => {
  test.skip(!SOURCE, '尚無 scn-list-bracket cassette');

  test('乾淨的錄製檔：零紅幀、不產出任何檔', async ({ page }, testInfo) => {
    test.setTimeout(120000);
    const rec = synthRecording(SOURCE, -1);
    const { entries, summary } = await triageToPending(page, rec, 'synthetic-clean.json');
    expect(summary.checked).toBeGreaterThan(0);
    expect(summary.failingFrames).toBe(0);
    const dir = testInfo.outputPath('pending');
    expect(T.writePending(dir, 'synthetic-clean', entries, summary)).toEqual([]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  test('注入壞幀：切段從整頁重繪起、重現、寫出的素材可自足重放', async ({ page }, testInfo) => {
    test.setTimeout(180000);
    const rec = synthRecording(SOURCE, BAD_STEP);
    const frames = T.planFrames(rec.cassette);
    const bad = frames.find((f) => f.step === BAD_STEP && f.bytes === BAD_FRAME);
    expect(bad, '注入的壞幀要自成一幀（以 ESU 切幀）').toBeTruthy();

    const { entries, summary } = await triageToPending(page, rec, 'synthetic-bad.json');
    expect(summary.runs, JSON.stringify(summary)).toBe(1);
    const [e] = entries;
    expect(e.frame).toBe(bad.idx);
    expect(e.violations).toContain('decodeFail');
    expect(e.reproduced).toBe(true);
    expect(e.sameBuf).toBe(true);
    expect(e.test).toBe('synthetic');
    // 切點不早於「壞幀之前最近的整頁重繪」（候選只會更短，不會更長）。
    const lastClear = T.cutCandidates(frames, bad.idx).slice(-1)[0];
    expect(frames[lastClear].clear).toBe(true);
    expect(e.cut.frame).toBeGreaterThanOrEqual(lastClear);
    // 段的 recv 串接 ＝ 原串流 [切點幀開頭, 壞幀結尾)。
    const stream = rec.cassette.steps.map((s) => b64d(s.recv)).join('');
    const seg = e.cassette.steps.map((s) => b64d(s.recv)).join('');
    expect(seg).toBe(stream.slice(frames[e.cut.frame].globalStart, bad.globalEnd));
    expect(e.cassette.steps[0].on).toBe('start');

    const dir = testInfo.outputPath('pending');
    const written = T.writePending(dir, 'synthetic-bad', entries, summary);
    expect(written.length).toBe(1);
    const list = JSON.parse(fs.readFileSync(`${dir}/synthetic-bad.list.json`, 'utf8'));
    expect(list.items.map((i) => i.frame)).toEqual([bad.idx]);

    // 寫出的待轉素材自足：單獨拿去分流，紅在它的最後一幀。
    const pending = JSON.parse(fs.readFileSync(written[0], 'utf8'));
    expect(pending.meta.mode).toBe('pending');
    const page2 = await page.context().newPage();
    const again = await triageRecording(page2, { events: [], cassette: pending });
    expect(again.failing.map((f) => f.idx)).toEqual([again.frames.length - 1]);
    await page2.close();
  });
});
