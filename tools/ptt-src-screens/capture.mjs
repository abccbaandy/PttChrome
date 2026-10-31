// 跑 scenes.mjs 的每個場景：spawn driver、每送一個鍵就收到 driver 下一次等鍵為止、逐幀切出位元組，
// 寫成 tests/unit/fixtures/ptt_src_screens/<file>.json。
// 用法：node tools/ptt-src-screens/capture.mjs <driver> <seed.big5> <輸出目錄>
// exit 2 ＝ driver 跑不起來／某一步沒有輸出就結束（環境或場景問題，不是解析器壞）。
//
// 幀尾怎麼認：pfterm 只在阻塞讀鍵前 flush，鍵送早了會被 typeahead 吃掉中間幀。以前用「多久沒有
// 新位元組」猜幀尾，機器忙時 driver 被排程延後就切早（半幀）、或在 driver 還沒死透前就當成功。
// 現在由 driver 自己說：它要阻塞等 stdin 時在 stdout 寫 WAIT_MARK（driver.c 以 --wrap 接住
// upstream 的 read／select／poll），同一條 stdout 保證排在這一幀所有位元組之後。
// 所以一幀＝送鍵之後到 WAIT_MARK 之前的位元組；沒等到 WAIT_MARK driver 就結束＝失敗。不靠任何計時。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLS, SCENES } from './scenes.mjs';

// APC 字串：pfterm 不會吐 APC，不會跟畫面位元組撞。driver.c 的 WAIT_MARK 必須同一串。
export const WAIT_MARK = '\x1b_ptt-src-screens:wait\x1b\\';
// 單幀上限：只是 driver 卡死時的保險（例：動畫一直畫、鍵被吃掉沒反應），正常幀不會碰到。
const FRAME_MAX_MS = 30000;

export class CaptureError extends Error {}

// cmd：driver 指令（陣列；測試用假 driver 時是 [node, 腳本]），後面接 <home> <seed> <入口> <列數>。
// timing：測試用，覆寫 FRAME_MAX_MS。
export function runScene(cmd, seed, scene, timing = {}) {
  const frameMaxMs = timing.frameMaxMs ?? FRAME_MAX_MS;
  const mark = Buffer.from(WAIT_MARK, 'latin1');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ptt-src-screens-'));
  const child = spawn(cmd[0], [...cmd.slice(1), home, seed, scene.entry, String(scene.rows)], {
    // fd 3：實況推文（driver.c 的 HAS_LIVE）。一直開著、只有 live 步驟才寫 ⇒ 平常永遠不可讀。
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  let pending = Buffer.alloc(0);
  // 'close' 在 stdout／stderr 都讀完之後才觸發（'exit' 可能比最後一批位元組早到）。
  let closed = null;
  let stderr = '';
  let waiter = null;
  const settle = () => {
    if (!waiter) return;
    const at = pending.indexOf(mark);
    if (at >= 0) {
      const bytes = pending.subarray(0, at);
      pending = pending.subarray(at + mark.length);
      return waiter.done(null, bytes);
    }
    if (closed) {
      const why =
        closed.code !== 0 ? `driver 異常結束（${JSON.stringify(closed)}）` : `driver 沒等鍵就結束（${JSON.stringify(closed)}）`;
      return waiter.done(new CaptureError(`${scene.file}: 第 ${waiter.step} 步：${why}\n${stderr}`));
    }
  };
  child.stdout.on('data', (d) => {
    pending = Buffer.concat([pending, d]);
    settle();
  });
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  child.on('close', (code, signal) => {
    closed = { code, signal };
    settle();
  });
  child.on('error', (e) => {
    closed = { code: null, signal: null, error: e.message };
    settle();
  });
  child.stdin.on('error', () => {});
  child.stdio[3].on('error', () => {});

  // live：一則別人剛推的推文內容（ASCII），driver 排成推文列、當成 IPC 送來的實況推文。
  const frame = (step, keys, live) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => waiter.done(new CaptureError(`${scene.file}: 第 ${step} 步 ${frameMaxMs}ms 沒等到 driver 回到等鍵`)),
        frameMaxMs,
      );
      waiter = {
        step,
        done: (err, bytes) => {
          clearTimeout(timer);
          waiter = null;
          if (err) reject(err);
          else resolve(bytes);
        },
      };
      if (keys) child.stdin.write(Buffer.from(keys, 'latin1'));
      if (live) child.stdio[3].write(Buffer.from(live + '\n', 'latin1'));
      settle();
    });

  return (async () => {
    const frames = [];
    try {
      for (let i = 0; i < scene.steps.length; ++i) {
        const step = scene.steps[i];
        const bytes = await frame(i, step.keys || '', step.live || '');
        if (!bytes.length)
          throw new CaptureError(`${scene.file}: 第 ${i} 步（keys=${JSON.stringify(step.keys || '')}）沒有任何輸出\n${stderr}`);
        const f = { name: step.name || null, keys: step.keys || '' };
        if (step.live) f.live = step.live;
        frames.push({ ...f, bytes: bytes.toString('latin1') });
      }
    } finally {
      if (!closed) child.kill('SIGKILL');
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
