// Deterministic proof of the mechanism behind
//   Browser.removeBrowserContext: can't access property "_maybeDontRestoreTabs",
//   this[#windows][aWindow.__SSi] is undefined
//
// Hypothesis: Juggler and BrowserGlue both observe "final-ui-startup". Juggler's
// observer (registered later ⇒ notified first) opens the remote-debugging pipe;
// BrowserGlue._beforeUIStartup then runs and only at its END calls
// SessionStore.init() (category "browser-before-ui-startup"), which is what
// registers SessionStore's "browser-window-before-show" observer. If anything in
// between runs a nested event loop, Playwright's Browser.newPage is served and
// the first browser window finishes onLoad before SessionStore listens ⇒ that
// window never gets __SSi ⇒ the last-tab close path
// (closeWindow → SessionStore.maybeDontRestoreTabs) throws.
//
// This script copies the Playwright-bundled Firefox, injects into
// BrowserGlue._beforeUIStartup (right before the "browser-before-ui-startup"
// category call) either
//   REPRO_DELAY_SESSIONSTORE_INIT=ms  → Services.tm.spinEventLoopUntil for ms (nested event loop)
//   REPRO_BLOCK_SESSIONSTORE_INIT=ms  → busy-wait for ms (control: slow, but no event loop)
// and runs launch → newContext → newPage → setContent → context.close.
//
// Usage: node prove-mechanism.mjs [--n=5] [--ms=3000]
// Needs fflate (a transitive dependency of this repo; elsewhere: npm i fflate playwright).
// Linux/Windows layout only (macOS keeps omni.ja inside Firefox.app/Contents/Resources).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { firefox } = require('playwright');
const { unzipSync, zipSync } = require('fflate');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? '1'];
  }),
);
const N = Number(args.n ?? 5);
const MS = String(args.ms ?? 3000);

const srcDir = path.dirname(firefox.executablePath());
const dstDir = path.join(os.tmpdir(), 'pw-firefox-ssi-patched');
const exe = path.join(dstDir, path.basename(firefox.executablePath()));

if (!fs.existsSync(path.join(dstDir, '.patched'))) {
  fs.rmSync(dstDir, { recursive: true, force: true });
  fs.cpSync(srcDir, dstDir, { recursive: true });
  const omniPath = path.join(dstDir, 'browser', 'omni.ja');
  const files = unzipSync(new Uint8Array(fs.readFileSync(omniPath)));
  const name = 'modules/BrowserGlue.sys.mjs';
  let src = Buffer.from(files[name]).toString('utf8');
  const anchor = `    lazy.BrowserUtils.callModulesFromCategory({
      categoryName: "browser-before-ui-startup",`;
  if (!src.includes(anchor)) throw new Error('anchor not found in ' + name);
  const inject = `    {
      const spin = Number(Services.env.get("REPRO_DELAY_SESSIONSTORE_INIT") || 0);
      if (spin > 0) {
        const until = Date.now() + spin;
        Services.tm.spinEventLoopUntil("repro", () => Date.now() > until);
      }
      const block = Number(Services.env.get("REPRO_BLOCK_SESSIONSTORE_INIT") || 0);
      if (block > 0) {
        const until = Date.now() + block;
        while (Date.now() < until) {}
      }
    }
`;
  src = src.replace(anchor, () => inject + anchor);
  files[name] = new Uint8Array(Buffer.from(src, 'utf8'));
  fs.writeFileSync(omniPath, zipSync(files, { level: 0 }));
  fs.writeFileSync(path.join(dstDir, '.patched'), '');
  console.log('patched copy at', dstDir);
}

async function once(env) {
  const browser = await firefox.launch({ executablePath: exe, env: { ...process.env, ...env } });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent('<p>hello</p>');
    try {
      await context.close();
      return 'ok';
    } catch (e) {
      return String(e.message).split('\n')[0];
    }
  } finally {
    await browser.close();
  }
}

const modes = [
  ['none', {}],
  [`block ${MS}ms (no event loop)`, { REPRO_BLOCK_SESSIONSTORE_INIT: MS }],
  [`spin ${MS}ms (nested event loop)`, { REPRO_DELAY_SESSIONSTORE_INIT: MS }],
];
for (const [label, env] of modes) {
  let hit = 0;
  for (let i = 0; i < N; i++) {
    const r = await once(env);
    if (r.includes('_maybeDontRestoreTabs')) hit++;
    console.log(`[${label}] #${i}: ${r}`);
  }
  console.log(`== ${label}: ${hit}/${N} hit\n`);
}
