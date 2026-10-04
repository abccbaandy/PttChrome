// 錄製檔分流的瀏覽器那半：逐幀重放＋screenSanity＋切段驗證。純邏輯（切幀、切點、
// redact、寫檔）在 helpers/recording_triage.js，流程說明見該檔開頭。
//
// 重放方式刻意是「直接餵 App.onData、不經送鍵門控」：錄製檔的 send 是 live 測試／使用者
// 當下按的鍵，新開的 app 不會自己再按一次。所以所有接管畫面的功能（好讀、列表好讀、看板
// 列表平滑捲動）一律關掉，驗的是**終端機渲染鏈**本身：server 送什麼、buf 就是什麼、DOM
// 就畫什麼。好讀累積這類「要 client 送鍵才長得出來」的畫面不在這裡的範圍。
const ptt = require('./ptt');
const { bootOffline, applyCassetteTermSize, SCENARIO_BASE_PREFS } = require('./replay');
const { screenSanity, describeSanity, sanityViolations } = require('./screen_sanity');
const T = require('./recording_triage');

const TRIAGE_PREFS = Object.assign({}, SCENARIO_BASE_PREFS);

async function bootTriagePage(page, cassette, frameBytes) {
  await bootOffline(page, ptt);
  await ptt.applyPrefs(page, TRIAGE_PREFS);
  await applyCassetteTermSize(page, cassette);
  await page.evaluate((a) => {
    window.__triageFrames = a;
  }, frameBytes);
}

// 餵第 i 幀並等它真的畫完：30ms／1ms 的 notify debounce、50ms settle、BSU 保險絲都清空
// （同 replay.js#waitScreenSettled 的判準；notify 內同步寫 DOM）。
async function feedFrame(page, i) {
  await page.evaluate((k) => window.__app.onData(window.__triageFrames[k]), i);
  await page.waitForFunction(() => {
    const b = window.__app.buf;
    return !b.timerUpdate && !b._settleTimer && !b.inSyncUpdate;
  });
}

// buf 逐格指紋（字＋全部屬性旗標）：判斷「從切點餵」與「從頭餵」得到的是不是同一個畫面。
async function bufSnapshot(page) {
  return page.evaluate(() =>
    window.__app.buf.lines
      .map((line) =>
        line
          .map((c) =>
            Object.keys(c)
              .filter((k) => k !== 'needUpdate' && typeof c[k] !== 'object')
              .map((k) => c[k])
              .join('\u0001')
          )
          .join('\u0002')
      )
      .join('\n')
  );
}

// 整卷逐幀跑一次。回傳 { frames, firstCheckable, checked, failing:[{idx, violations, detail, snapshot?}] }。
// 連續同種違規只在第一幀拍 buf 指紋（groupFailures 只切那一幀）。
async function triageRecording(page, rec) {
  const cassette = rec.cassette;
  const frames = T.planFrames(cassette);
  const firstCheckable = T.firstCheckableFrame(frames);
  const failing = [];
  let checked = 0;
  await bootTriagePage(page, cassette, frames.map((f) => f.bytes));
  for (let i = 0; i < frames.length; i++) {
    await feedFrame(page, i);
    if (firstCheckable < 0 || i < firstCheckable) continue;
    checked++;
    const r = await screenSanity(page);
    const violations = sanityViolations(r);
    if (!violations.length) continue;
    const prev = failing[failing.length - 1];
    const continues = prev && prev.idx === i - 1 && prev.violations.join() === violations.join();
    failing.push({
      idx: i,
      violations,
      detail: describeSanity(r, `frame ${i}`),
      snapshot: continues ? null : await bufSnapshot(page),
    });
  }
  return { frames, firstCheckable, checked, failing };
}

// 在新頁面只餵 cutIdx..failIdx：buf 是否逐格相同、違規是否重現（至少一種相同）。
async function verifyCut(context, cassette, frames, cutIdx, fail) {
  const page = await context.newPage();
  try {
    await bootTriagePage(page, cassette, frames.slice(cutIdx, fail.idx + 1).map((f) => f.bytes));
    for (let i = 0; i <= fail.idx - cutIdx; i++) await feedFrame(page, i);
    const violations = sanityViolations(await screenSanity(page));
    return {
      sameBuf: (await bufSnapshot(page)) === fail.snapshot,
      reproduced: violations.some((v) => fail.violations.includes(v)),
    };
  } finally {
    await page.close();
  }
}

// 依 cutCandidates 的順序找第一個「buf 相同且違規重現」的切點；都不成立退回最後一個
// （＝最近的 clear），並如實標記 reproduced／sameBuf。
async function chooseCut(context, cassette, frames, fail) {
  const candidates = T.cutCandidates(frames, fail.idx);
  let res = null;
  for (const c of candidates) {
    res = Object.assign({ cut: c, kind: frames[c].clear ? 'clear' : 'home' }, await verifyCut(context, cassette, frames, c, fail));
    if (res.sameBuf && res.reproduced) return res;
  }
  return res;
}

// 一卷錄製檔 → writePending 吃的 entries（＋摘要）。source 只用 basename（隱私：不寫絕對路徑）。
async function triageToPending(page, rec, source, opts = {}) {
  const max = opts.max || T.MAX_PENDING_PER_RECORDING;
  const base = T.pendingBase(source);
  const res = await triageRecording(page, rec);
  const runs = T.groupFailures(res.failing);
  const entries = [];
  for (const run of runs.slice(0, max)) {
    const fail = res.failing.find((f) => f.idx === run.first);
    const cut = await chooseCut(page.context(), rec.cassette, res.frames, fail);
    const frame = res.frames[run.first];
    const t = T.eventTimeAt(rec, frame.globalEnd);
    const info = {
      frame: run.first,
      step: frame.step,
      t,
      test: T.testAt(rec, t),
      violations: run.violations,
      runFrames: run.count,
      cut: { frame: cut.cut, step: res.frames[cut.cut].step, kind: cut.kind },
      reproduced: cut.reproduced,
      sameBuf: cut.sameBuf,
      detail: fail.detail,
    };
    entries.push(
      Object.assign({}, info, {
        cassette: T.segmentCassette(rec.cassette, res.frames, cut.cut, run.first, {
          source: `${base}.json`,
          frame: run.first,
          violations: run.violations,
          reproduced: cut.reproduced,
          recordedAs: (rec.meta && rec.meta.redacted && rec.meta.redacted.ids) ? 'account' : 'guest',
        }),
      })
    );
  }
  return {
    entries,
    summary: {
      frames: res.frames.length,
      checked: res.checked,
      uncheckedBeforeFirstClear: res.firstCheckable < 0 ? res.frames.length : res.firstCheckable,
      failingFrames: res.failing.length,
      runs: runs.length,
      omittedRuns: Math.max(0, runs.length - max),
    },
  };
}

module.exports = { TRIAGE_PREFS, bootTriagePage, feedFrame, bufSnapshot, triageRecording, chooseCut, triageToPending };
