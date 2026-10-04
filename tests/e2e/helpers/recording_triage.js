// live 錄製檔 → 待轉素材（純邏輯，無瀏覽器；unit 守護 tests/unit/recording_triage.test.js）。
//
// 流程（瀏覽器那半在 helpers/triage_runner.js，入口 tools/triage-recordings.spec.js）：
//   1. planFrames：錄製檔內建的 cassette（rec.cassette，產品 eventsToCassetteSteps 導出、
//      已 redact）每個 step 的 recv 依 pfterm 的 sync frame 結尾 `ESC[?2026l` 切成幀。
//      pfterm 每次 doupdate 都包一對 BSU/ESU（docs/pttbbs-screen-protocol.md §1.1 Synchronized Output），
//      所以「一幀」＝ server 一次 refresh 的完整輸出；沒有 ESU 的尾巴自成一幀。
//   2. 逐幀餵進真瀏覽器、settle 後跑 screenSanity。**第一個整頁重繪之前的幀不檢查**：
//      錄製是中途開始的，那時 buf 裡沒被寫到的格子不是真畫面（例：新寫的 Big5 lead
//      配上舊的空白 ⇒ 假 decodeFail）。
//   3. 紅的幀 ⇒ segmentCassette 從切點幀切到該幀（含）成 cassette，redactCassette＋
//      assertNoLeak＋assertNoLocalInfo 把關後寫到 PENDING_DIR。全綠不寫任何檔。
//
// 切點：
//   - clear：幀內含 `ESC[H ESC[2J`（pfterm.c#fterm_rawclear；redrawwin／Ctrl-L／initscr
//     都走它）＝ server 端真的清屏重畫，從這裡餵一張空白終端機就得到同一個畫面。CONFIRMED。
//   - home：幀以 `ESC[H` 起頭（可能前置 BSU）。pfterm 的 dirty-only 更新也常從 home 開始
//     （翻頁的 diff 幀），**不保證**是整屏 ⇒ 只是「較短切段」的候選，必須由 runner 在新
//     頁面重放、buf 逐格相同且違規重現才採用；全部不成立就退回最近的 clear。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scrub } = require('../../../src/js/redact');
const { assertNoLeak } = require('./recording');

const BSU = '\x1b[?2026h';
const ESU = '\x1b[?2026l';
const FULL_CLEAR = '\x1b[H\x1b[2J';
const PENDING_DIR = path.join(__dirname, '..', 'cassettes', 'pending');
// 同一卷最多切幾段：一個 bug 常讓後面幾百幀一起紅，連續同種違規已併成一段（groupFailures），
// 這是不同種類交錯時的上限，多的只列在清單裡。
const MAX_PENDING_PER_RECORDING = 5;
// 每段最多試幾個 home 候選（每試一個＝開一頁重放一次）。
const MAX_HOME_CANDIDATES = 4;

const b64d = (s) => Buffer.from(s || '', 'base64').toString('latin1');
const b64e = (s) => Buffer.from(s, 'latin1').toString('base64');

function startsWithHome(bytes) {
  const s = bytes.startsWith(BSU) ? bytes.slice(BSU.length) : bytes;
  return s.startsWith('\x1b[H') || s.startsWith('\x1b[1;1H');
}

// cassette → 幀表。每幀：{ idx, step, start, end（該 step recv 內的 offset）,
// globalStart, globalEnd（全部 recv 串接後的 offset）, bytes, clear, home }。
function planFrames(cassette) {
  const frames = [];
  let g = 0;
  ((cassette && cassette.steps) || []).forEach((s, step) => {
    const recv = b64d(s.recv);
    let start = 0;
    while (start < recv.length) {
      const k = recv.indexOf(ESU, start);
      const end = k < 0 ? recv.length : k + ESU.length;
      const bytes = recv.slice(start, end);
      frames.push({
        idx: frames.length,
        step,
        start,
        end,
        globalStart: g + start,
        globalEnd: g + end,
        bytes,
        clear: bytes.includes(FULL_CLEAR),
        home: startsWithHome(bytes),
      });
      start = end;
    }
    g += recv.length;
  });
  return frames;
}

// 第一個可檢查的幀（＝第一個 clear 幀）；整卷沒有整頁重繪回 -1（整卷不檢查）。
function firstCheckableFrame(frames) {
  const f = frames.find((x) => x.clear);
  return f ? f.idx : -1;
}

// 紅幀 failIdx 的切點候選，依序嘗試：failIdx 往回、最近 clear 之後的 home 幀（最多 max 個，
// 越近越短），最後一個一定是最近的 clear（保底）。沒有 clear ⇒ []（切不出來）。
function cutCandidates(frames, failIdx, max = MAX_HOME_CANDIDATES) {
  let clearIdx = -1;
  for (let i = failIdx; i >= 0; i--)
    if (frames[i].clear) {
      clearIdx = i;
      break;
    }
  if (clearIdx < 0) return [];
  const homes = [];
  for (let i = failIdx; i > clearIdx && homes.length < max; i--) if (frames[i].home) homes.push(i);
  return homes.concat(clearIdx);
}

// 紅幀清單 [{idx, violations}]（idx 遞增）→ 連續且違規種類相同的併成一段，只切第一幀
// （最短、且就是 bug 第一次出現的那一刻）。
function groupFailures(failing) {
  const runs = [];
  for (const f of failing) {
    const key = f.violations.join(',');
    const last = runs[runs.length - 1];
    if (last && last.key === key && last.last === f.idx - 1) {
      last.last = f.idx;
      last.count++;
    } else runs.push({ key, first: f.idx, last: f.idx, count: 1, violations: f.violations.slice() });
  }
  return runs.map(({ key, ...r }) => r); // eslint-disable-line no-unused-vars
}

// 從 cutIdx 幀的開頭切到 failIdx 幀的結尾。首段成為 on:'start'；中間 step 原樣保留
// on/num/send/query（bootScenario／replayListCassette 照樣能門控）；末段 recv 截到紅幀為止。
function segmentCassette(cassette, frames, cutIdx, failIdx, meta = {}) {
  const cut = frames[cutIdx];
  const fail = frames[failIdx];
  if (!cut || !fail || cutIdx > failIdx) throw new Error(`切段範圍不合法：${cutIdx}..${failIdx}`);
  const steps = [];
  for (let s = cut.step; s <= fail.step; s++) {
    const src = cassette.steps[s];
    const recv = b64d(src.recv);
    const from = s === cut.step ? cut.start : 0;
    const to = s === fail.step ? fail.end : recv.length;
    // eslint-disable-next-line no-unused-vars
    const { recv: _r, ...rest } = src;
    const step = s === cut.step ? { on: 'start' } : Object.assign({}, rest);
    step.recv = b64e(recv.slice(from, to));
    steps.push(step);
  }
  return {
    meta: Object.assign({ mode: 'pending' }, meta),
    cols: cassette.cols || 80,
    rows: cassette.rows || 24,
    steps,
  };
}

// recv 串流 offset → 錄製事件時間（ms，給 `yarn debug:screens <檔> <ms>`）。
// rec.cassette 的 recv 串接 ≡ 全部 recv 事件串接（eventsToCassetteSteps 不丟 recv）。
function eventTimeAt(rec, offset) {
  let acc = 0;
  for (const ev of rec.events || []) {
    if (ev.dir !== 'recv') continue;
    acc += b64d(ev.data).length;
    if (acc >= offset) return ev.t;
  }
  return null;
}

// 該時間點落在哪條 live test 裡（fixtures.js 的 test.begin／test.end 標記）；不在任何 test 內回 null。
function testAt(rec, t) {
  let cur = null;
  for (const ev of rec.events || []) {
    if (ev.dir !== 'log' || ev.t > t) continue;
    if (ev.tag === 'test.begin') cur = (ev.info && ev.info.title) || null;
    else if (ev.tag === 'test.end') cur = null;
  }
  return cur;
}

function envRedact(env = process.env) {
  return {
    ids: [env.PTT_USER].filter((x) => x && x.toLowerCase() !== 'guest'),
    secrets: [env.PTT_PASS, env.PTT_OTP_SECRET].filter(Boolean),
  };
}

// 再 redact 一次（錄製檔 stop 時已 redact 過；這裡防「錄的時候沒帶 env、或使用者自己的
// ptt-debug 檔」）。**對串流做、不逐 step 做**：帳號可以被切在兩個 step 之間，理由同
// src/js/debug_recorder_logic.js#scrubByStream。scrub 全是等長替換 ⇒ 切點不變。
function redactCassette(c, { ids = [], secrets = [] } = {}) {
  const clean = (s) => scrub(s, ids.filter(Boolean), secrets.filter(Boolean));
  const out = JSON.parse(JSON.stringify(c));
  for (const key of ['recv', 'send']) {
    const owners = out.steps.filter((s) => s[key] != null);
    const parts = owners.map((s) => b64d(s[key]));
    const cleaned = clean(parts.join(''));
    let off = 0;
    owners.forEach((s, i) => {
      s[key] = b64e(cleaned.slice(off, off + parts[i].length));
      off += parts[i].length;
    });
  }
  return out;
}

// 純文字（清單、meta）的帳密把關：借 assertNoLeak 的同一套判準，不另寫第二份。
function assertTextNoLeak(text) {
  assertNoLeak({ cassette: { steps: [{ on: 'text', recv: Buffer.from(text, 'utf8').toString('base64') }] } });
}

// 本機資訊把關（CLAUDE.md 隱私節）：家目錄（兩種斜線）、OS 使用者名稱都不准出現在要寫出的
// JSON 文字裡。bytes 是 base64，命中的只可能是 meta／清單的明文欄位（例：誤把錄製檔絕對路徑
// 當 source 寫進去）。
function assertNoLocalInfo(text, info = { home: os.homedir(), user: os.userInfo().username }) {
  const low = text.toLowerCase();
  const needles = [info.home, info.home && info.home.replace(/\\/g, '/'), info.home && info.home.replace(/\\/g, '\\\\'), info.user]
    .filter((s) => s && s.length >= 3)
    .map((s) => s.toLowerCase());
  const hit = needles.find((n) => low.includes(n));
  if (hit) throw new Error('待轉素材隱私把關失敗：含本機路徑／使用者名稱，不寫檔。');
}

function pendingBase(source) {
  return path.basename(source).replace(/\.json$/i, '');
}

function clearPending(dir, base) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir))
    if (f === `${base}.list.json` || (f.startsWith(`${base}--`) && f.endsWith('.json'))) {
      fs.unlinkSync(path.join(dir, f));
      n++;
    }
  return n;
}

// 寫出一卷錄製檔的待轉素材。entries＝[{ frame, cassette, ...清單欄位 }]。
// 先清掉這一卷上一輪的產物（修好之後重跑＝舊的紅幀不該還掛在待辦裡）；entries 空＝只清不寫，
// **連目錄都不建**。所有內容先在記憶體過完把關才落地，任何一段失敗整卷都不寫。
function writePending(dir, base, entries, summary = {}, opts = {}) {
  const redact = opts.redact || envRedact();
  const local = opts.localInfo;
  clearPending(dir, base);
  if (!entries.length) return [];
  const files = [];
  const items = [];
  for (const e of entries) {
    const { cassette, ...item } = e;
    const c = redactCassette(cassette, redact);
    assertNoLeak({ cassette: c });
    const json = JSON.stringify(c) + '\n';
    assertNoLocalInfo(json, local);
    const file = `${base}--f${e.frame}.json`;
    files.push({ file, json });
    items.push(Object.assign({ file }, item));
  }
  const list = JSON.stringify({ source: `${base}.json`, summary, items }, null, 2) + '\n';
  const cleanList = scrub(list, redact.ids, redact.secrets);
  assertTextNoLeak(cleanList);
  assertNoLocalInfo(cleanList, local);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f.file), f.json, 'utf8');
  fs.writeFileSync(path.join(dir, `${base}.list.json`), cleanList, 'utf8');
  return files.map((f) => path.join(dir, f.file));
}

module.exports = {
  BSU,
  ESU,
  FULL_CLEAR,
  PENDING_DIR,
  MAX_PENDING_PER_RECORDING,
  MAX_HOME_CANDIDATES,
  planFrames,
  firstCheckableFrame,
  cutCandidates,
  groupFailures,
  segmentCassette,
  eventTimeAt,
  testAt,
  envRedact,
  redactCassette,
  assertNoLocalInfo,
  pendingBase,
  clearPending,
  writePending,
};
