// 跑 scenes.mjs 的每個場景：spawn driver、等 stdout 靜止才送下一個鍵、逐幀切出位元組，
// 寫成 tests/unit/fixtures/ptt_src_screens/<file>.json。
// 用法：node tools/ptt-src-screens/capture.mjs <driver> <seed.big5> <輸出目錄>
// exit 2 ＝ driver 跑不起來／某一步沒有輸出就結束（環境或場景問題，不是解析器壞）。
//
// 為什麼要等靜止：pfterm 只在阻塞讀鍵前 flush，鍵送早了會被 typeahead 吃掉中間幀；固定睡
// 又在機器忙時切錯幀。所以「送鍵 → 等第一個位元組 → 再等 QUIET_MS 沒有新位元組」才算一幀。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLS, SCENES } from './scenes.mjs';

const QUIET_MS = 250;
// 送鍵後多久沒有任何輸出就放棄這一步（每一步都該畫出東西，空幀＝場景或 upstream 鍵表變了）。
const FIRST_BYTE_MS = 3000;
// 單幀上限：持續有輸出（例：動畫）超過這麼久＝場景寫錯。
const FRAME_MAX_MS = 10000;

export class CaptureError extends Error {}

// cmd：driver 指令（陣列；測試用假 driver 時是 [node, 腳本]），後面接 <home> <seed> <入口> <列數>。
// timing：測試用，覆寫 QUIET_MS／FIRST_BYTE_MS／FRAME_MAX_MS。
export function runScene(cmd, seed, scene, timing = {}) {
  const quietMs = timing.quietMs ?? QUIET_MS;
  const firstByteMs = timing.firstByteMs ?? FIRST_BYTE_MS;
  const frameMaxMs = timing.frameMaxMs ?? FRAME_MAX_MS;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ptt-src-screens-'));
  const child = spawn(cmd[0], [...cmd.slice(1), home, seed, scene.entry, String(scene.rows)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let pending = [];
  let lastData = 0;
  let exited = null;
  let stderr = '';
  child.stdout.on('data', (d) => {
    pending.push(d);
    lastData = Date.now();
  });
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });
  child.stdin.on('error', () => {});

  const frame = (keys) =>
    new Promise((resolve, reject) => {
      const start = Date.now();
      if (keys) child.stdin.write(Buffer.from(keys, 'latin1'));
      const tick = () => {
        const t = Date.now();
        const got = pending.length > 0;
        if (got && t - lastData >= quietMs) return resolve(take());
        if (!got && t - start >= firstByteMs) return resolve(Buffer.alloc(0));
        if (exited && !got) return resolve(Buffer.alloc(0));
        if (t - start >= frameMaxMs)
          return reject(new CaptureError(`${scene.file}: 輸出 ${frameMaxMs}ms 沒有靜止`));
        setTimeout(tick, 20);
      };
      setTimeout(tick, 20);
    });
  const take = () => {
    const b = Buffer.concat(pending);
    pending = [];
    return b;
  };

  return (async () => {
    const frames = [];
    try {
      for (let i = 0; i < scene.steps.length; ++i) {
        const step = scene.steps[i];
        if (exited)
          throw new CaptureError(
            `${scene.file}: driver 在第 ${i} 步前就結束（${JSON.stringify(exited)}）\n${stderr}`,
          );
        const bytes = await frame(step.keys || '');
        if (!bytes.length)
          throw new CaptureError(`${scene.file}: 第 ${i} 步（keys=${JSON.stringify(step.keys || '')}）沒有任何輸出\n${stderr}`);
        frames.push({ name: step.name || null, keys: step.keys || '', bytes: bytes.toString('latin1') });
      }
      // die() 也會先吐出 initscr 的位元組：driver 自己報錯結束的場景不能當成功。
      if (exited && exited.code !== 0)
        throw new CaptureError(`${scene.file}: driver 異常結束（${JSON.stringify(exited)}）\n${stderr}`);
    } finally {
      if (!exited) child.kill('SIGKILL');
      fs.rmSync(home, { recursive: true, force: true });
    }
    return { cols: COLS, rows: scene.rows, entry: scene.entry, frames };
  })();
}

async function main([driver, seed, outDir]) {
  if (!driver || !seed || !outDir) throw new CaptureError('usage: capture.mjs <driver> <seed> <outdir>');
  fs.mkdirSync(outDir, { recursive: true });
  for (const scene of SCENES) {
    const out = await runScene([path.resolve(driver)], path.resolve(seed), scene);
    fs.writeFileSync(path.join(outDir, `${scene.file}.json`), JSON.stringify(out, null, 1) + '\n');
    console.log(`${scene.file}: ${out.frames.length} 幀`);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    () => {
      process.exitCode = 0;
    },
    (e) => {
      console.error(e instanceof CaptureError ? e.message : e);
      process.exitCode = 2;
    },
  );
}
