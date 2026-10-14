// Standalone repro attempt for a Playwright-bundled Firefox teardown error:
//
//   browserContext.close: Protocol error (Browser.removeBrowserContext):
//   can't access property "_maybeDontRestoreTabs", this[#windows][aWindow.__SSi] is undefined
//
// No test runner, no app, no external network: a local http server serves one
// page; each iteration is a fresh browser (launch → newContext → newPage →
// goto → [input] → context.close → browser.close), because the known hits were
// on "the first page window of a freshly launched browser".
//
// Usage:
//   node repro.mjs [--total=3000] [--conc=8] [--variant=full] [--stress=0] [--divs=3000]
//
// Variants:
//   full     goto + dblclick + Control+c, then context.close
//   noinput  goto only, then context.close
//   nowait   newContext/newPage right after launch, goto without waiting for load, close immediately
//   nogoto   newPage then context.close immediately (about:blank only)
//   minimal  newPage (via browser.newPage) then page.context().close()
//
// --stress=N spawns N busy-loop worker threads to widen timing windows.
import { createRequire } from 'node:module';
import http from 'node:http';
import { Worker } from 'node:worker_threads';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { firefox } = require('playwright');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? '1'];
  }),
);
const TOTAL = Number(args.total ?? 3000);
const CONC = Number(args.conc ?? 8);
const VARIANT = args.variant ?? 'full';
const STRESS = Number(args.stress ?? 0);
const DIVS = Number(args.divs ?? 3000);

const html = `<!doctype html><meta charset="utf-8"><title>repro</title>
<style>div{font:14px monospace;white-space:pre}</style>
<body><div id="root"></div><script>
const root = document.getElementById('root');
const ro = new ResizeObserver(() => {});
for (let i = 0; i < ${DIVS}; i++) {
  const d = document.createElement('div');
  d.textContent = 'row ' + i + ' lorem ipsum dolor sit amet';
  root.appendChild(d);
  if (i % 50 === 0) ro.observe(d);
}
</script>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}/`;

const stressWorkers = [];
for (let i = 0; i < STRESS; i++) {
  stressWorkers.push(
    new Worker('for(;;){Math.sqrt(Math.random())}', { eval: true }),
  );
}

const stats = { done: 0, hit: 0, closeOther: 0, otherErr: 0 };
const hits = [];
const others = new Map();
const countOther = (msg) => {
  const key = String(msg).split('\n')[0].slice(0, 200);
  others.set(key, (others.get(key) ?? 0) + 1);
};

async function iteration(n) {
  let browser;
  try {
    browser = await firefox.launch();
    let context, page;
    if (VARIANT === 'minimal') {
      page = await browser.newPage();
      context = page.context();
    } else {
      context = await browser.newContext();
      page = await context.newPage();
    }
    if (VARIANT === 'full' || VARIANT === 'noinput') {
      await page.goto(URL_);
    } else if (VARIANT === 'nowait') {
      page.goto(URL_, { waitUntil: 'commit' }).catch(() => {});
    }
    if (VARIANT === 'full') {
      await page.mouse.dblclick(100, 30);
      await page.keyboard.press('Control+c');
    }
    try {
      await context.close();
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (msg.includes('_maybeDontRestoreTabs')) {
        stats.hit++;
        hits.push({ n, msg });
        console.log(`\n[HIT] iteration ${n}\n${msg}\n`);
      } else {
        stats.closeOther++;
        countOther('context.close: ' + msg);
      }
    }
  } catch (e) {
    stats.otherErr++;
    countOther(String(e?.message ?? e));
  } finally {
    if (browser) await browser.close().catch((e) => countOther('browser.close: ' + e.message));
    stats.done++;
  }
}

const t0 = Date.now();
let next = 0;
const ticker = setInterval(() => {
  const s = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`[${s}s] done=${stats.done}/${TOTAL} hit=${stats.hit} closeOther=${stats.closeOther} otherErr=${stats.otherErr}`);
}, 30000);
await Promise.all(
  Array.from({ length: CONC }, async () => {
    while (next < TOTAL) await iteration(next++);
  }),
);
clearInterval(ticker);
for (const w of stressWorkers) await w.terminate();
server.close();

const summary = {
  os: `${os.platform()} ${os.release()}`,
  cpus: os.cpus().length,
  playwright: require('playwright/package.json').version,
  firefox: firefox.executablePath(),
  variant: VARIANT,
  conc: CONC,
  stress: STRESS,
  divs: DIVS,
  ...stats,
  seconds: Math.round((Date.now() - t0) / 1000),
  others: Object.fromEntries(others),
  hits,
};
console.log('RESULT ' + JSON.stringify(summary, null, 2));
