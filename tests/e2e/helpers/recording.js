// 用產品自己的 DebugRecorder（src/js/debug_recorder.js）錄 live 連線。兩個消費端：
//
//   1. live e2e 每輪自動錄一份（helpers/fixtures.js）→ tests/e2e/__recordings__/（gitignored）。
//      live 有登入預算、不能反覆跑；這份錄製檔讓失敗現場與「新版面／新協定」可以搬到
//      offline 反覆修：`yarn debug:screens <檔> [ms]` 看畫面，或依 docs/offline-replay-testing.md
//      「使用者 Debug 錄製檔 → cassette」裁成素材；`yarn triage:recordings`
//      （helpers/recording_triage.js）逐幀驗並自動切出紅幀素材。
//   2. scenario 錄製器（tools/record-scenarios.spec.js）→ tests/e2e/cassettes/scn-*.json。
//
// 格式與使用者在「設定 → 關於」錄的 ptt-debug-*.json 完全相同（同一個 serializeRecording），
// 不另立一種 schema。
//
// 隱私：stop 時以 env 帳密（PTT_USER／PTT_PASS／PTT_OTP_SECRET）走產品的 redact（帳號等長
// 遮蔽、IPv4、密碼與 2FA 密鑰），再以 assertNoLeak 解碼全部 bytes 把關 —— 命中即丟錯不寫。
const fs = require('fs');
const path = require('path');

const RECORDINGS_DIR = path.join(__dirname, '..', '__recordings__');
const KEEP_LIVE_RECORDINGS = 10;

async function startRecorder(page) {
  await page.evaluate(async () => {
    const DebugRecorder = await window.__loadDebugRecorder();
    if (window.__e2eRec && window.__e2eRec.isRecording) window.__e2eRec.stop();
    window.__e2eRec = new DebugRecorder(window.__app);
    window.__e2eRec.start();
  });
}

// 在錄製檔裡插一個 log 事件（例：每條 test 的開始／結束），讀錄製檔時才分得出段落。
async function markRecorder(page, tag, info) {
  await page
    .evaluate(
      ({ tag, info }) => window.__e2eRec && window.__e2eRec.log(tag, info),
      { tag, info: info || null }
    )
    .catch(() => {});
}

function redactPrefs() {
  return {
    autoLoginUser: process.env.PTT_USER || '',
    autoLoginPassword: process.env.PTT_PASS || '',
    autoLoginOtpSecret: process.env.PTT_OTP_SECRET || '',
  };
}

// 停止並回傳已 redact 的 JSON 物件（沒在錄回 null）。
async function stopRecorder(page) {
  const json = await page.evaluate(
    (prefs) => (window.__e2eRec ? window.__e2eRec.stop({ prefs }) : null),
    redactPrefs()
  );
  if (!json) return null;
  const rec = JSON.parse(json);
  assertNoLeak(rec);
  return rec;
}

// 錄製檔的最後防線：解碼所有 bytes，帳號（不分大小寫）／密碼／2FA 密鑰一個都不准出現。
function assertNoLeak(rec) {
  const user = (process.env.PTT_USER || '').toLowerCase();
  const secrets = [process.env.PTT_PASS, process.env.PTT_OTP_SECRET].filter(Boolean);
  const needles = [];
  if (user && user !== 'guest') needles.push(user);
  const blobs = [];
  for (const ev of rec.events || [])
    if (ev.data) blobs.push({ where: `event#${ev.t}ms ${ev.dir}`, b: Buffer.from(ev.data, 'base64').toString('latin1') });
  ((rec.cassette && rec.cassette.steps) || []).forEach((s, i) => {
    blobs.push({ where: `step#${i} ${s.on} recv`, b: Buffer.from(s.recv || '', 'base64').toString('latin1') });
    if (s.send) blobs.push({ where: `step#${i} send`, b: Buffer.from(s.send, 'base64').toString('latin1') });
  });
  for (const { where, b } of blobs) {
    const low = b.toLowerCase();
    if (secrets.some((s) => b.includes(s)))
      throw new Error(`錄製檔隱私把關失敗（${where}）：含密碼／2FA 密鑰，不寫檔。`);
    const n = needles.find((x) => low.includes(x));
    if (n) {
      // 診斷：印出命中處前後的 bytes（帳號本身換成 <ID>、非 ASCII 轉成 \xNN），
      // 才分得出是 redact 的邊界判準漏了還是真的出現在內容裡。
      const at = low.indexOf(n);
      const ctx = (s) => s.replace(/[^\x20-\x7e]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
      const around = ctx(b.slice(Math.max(0, at - 24), at)) + '<ID>' + ctx(b.slice(at + n.length, at + n.length + 24));
      throw new Error(`錄製檔隱私把關失敗（${where}）：redact 後仍含帳號，不寫檔。前後文：${around}`);
    }
  }
}

// live 每輪一份，只留最近 KEEP_LIVE_RECORDINGS 份。回傳寫入的路徑。
function saveLiveRecording(rec) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(RECORDINGS_DIR, `live-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
  const old = fs
    .readdirSync(RECORDINGS_DIR)
    .filter((f) => /^live-.*\.json$/.test(f))
    .sort()
    .reverse()
    .slice(KEEP_LIVE_RECORDINGS);
  for (const f of old) fs.unlinkSync(path.join(RECORDINGS_DIR, f));
  return file;
}

// 錄製檔 → scenario cassette：從「第一個 Ctrl-L」那一步起算（錄製器開始後先送 \f
// 要 server 整頁重畫，那一步的 recv 就是重放的首幀），之前的殘餘 recv 丟掉。
// Ctrl-L 經 classifySend 剝掉 \f 後是空字串 ⇒ 落在 on:'raw'。
function toScenarioCassette(rec, meta) {
  const steps = rec.cassette.steps;
  const i = steps.findIndex(
    (s) => s.on === 'raw' && Buffer.from(s.send, 'base64').toString('latin1') === '\x0c'
  );
  if (i < 0) throw new Error('錄製檔裡找不到起始的 Ctrl-L（錄製器沒送首幀重畫？）');
  const out = steps.slice(i).map((s) => Object.assign({}, s));
  out[0] = { on: 'start', recv: out[0].recv };
  return {
    meta: Object.assign(
      {
        mode: 'scenario',
        recordedAs: process.env.PTT_USER ? 'account' : 'guest',
        recordedAt: new Date().toISOString(),
      },
      meta
    ),
    cols: rec.cassette.cols,
    rows: rec.cassette.rows,
    steps: out,
  };
}

// 等連線上的往返靜下來：錄製事件數連續 quiet 次不變、畫面 settle 計時器清空、
// 背景命令佇列（列表好讀／看板列表）idle。錄製與 live 斷言都用它切「一個動作」的邊界。
async function waitWireQuiet(page, opts = {}) {
  const quiet = opts.quiet || 3;
  const interval = opts.interval || 400;
  const deadline = Date.now() + (opts.timeout || 30000);
  let last = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => {
      const app = window.__app;
      const buf = app.buf;
      return {
        // 錄製中看錄製事件數；沒在錄時看 installRecvCounter 的計數（都沒有＝只能看 busy）。
        n:
          window.__e2eRec && window.__e2eRec.isRecording
            ? window.__e2eRec.events.length
            : window.__recvN == null
              ? -1
              : window.__recvN,
        busy:
          !!(buf.timerUpdate || buf._settleTimer) ||
          !!(app.commandQueue && !app.commandQueue.idle),
      };
    });
    if (!st.busy && st.n === last) {
      if (++stable >= quiet) return;
    } else {
      stable = 0;
      last = st.n;
    }
    await page.waitForTimeout(interval); // sleep-ok: 輪詢間隔（判準是事件數連續不變）
  }
  throw new Error('waitWireQuiet 逾時：連線一直有往返或背景佇列不 idle');
}

// 不錄的時候也要看得到「線上還有 recv 在進來」：waitWireQuiet 的事件數判準靠它。
async function installRecvCounter(page) {
  await page.evaluate(() => {
    if (window.__recvN != null) return;
    window.__recvN = 0;
    const app = window.__app;
    const orig = app.onData;
    app.onData = function (d) {
      window.__recvN++;
      return orig.call(app, d);
    };
  });
}

module.exports = {
  RECORDINGS_DIR,
  installRecvCounter,
  startRecorder,
  markRecorder,
  stopRecorder,
  assertNoLeak,
  saveLiveRecording,
  toScenarioCassette,
  waitWireQuiet,
};
