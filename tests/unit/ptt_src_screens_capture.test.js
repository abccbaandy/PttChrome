// tools/ptt-src-screens/capture.mjs：送鍵 → 等 stdout 靜止 → 切一幀。用假 driver
// （tests/unit/helpers/fake_ptt_driver.mjs）驗切幀與各種失敗都會變成 CaptureError
// （generate.sh 據此 exit 2＝環境／場景問題，不會產出半套 fixture 當成功）。
import path from "node:path";
import { CaptureError, runScene } from "../../tools/ptt-src-screens/capture.mjs";
import { SCENES } from "../../tools/ptt-src-screens/scenes.mjs";

const FAKE = [process.execPath, path.join(__dirname, "helpers/fake_ptt_driver.mjs")];
const TIMING = { quietMs: 150, firstByteMs: 600, frameMaxMs: 3000 };
const scene = (entry, steps) => ({ file: entry, entry, rows: 24, steps });

test("每一步的輸出（分批 flush 也算）切成一幀，keys／name 照場景", async () => {
  const out = await runScene(FAKE, "seed", scene("echo", [{ name: "start" }, { keys: "q" }, { keys: "\x1b[B", name: "down" }]), TIMING);
  expect(out).toMatchObject({ cols: 80, rows: 24, entry: "echo" });
  expect(out.frames).toEqual([
    { name: "start", keys: "", bytes: "HELLO-SCREEN" },
    { name: null, keys: "q", bytes: "[q]" },
    { name: "down", keys: "\x1b[B", bytes: "[\x1b[B]" },
  ]);
});

test("driver 自己報錯結束 ⇒ CaptureError（即使已經吐了位元組）", async () => {
  await expect(runScene(FAKE, "seed", scene("die", [{ name: "list" }]), TIMING)).rejects.toThrow(CaptureError);
  await expect(runScene(FAKE, "seed", scene("die", [{ name: "list" }]), TIMING)).rejects.toThrow(/enter_board/);
});

test("送鍵之後沒有任何輸出 ⇒ CaptureError（鍵在 upstream 失效，不存空幀）", async () => {
  await expect(runScene(FAKE, "seed", scene("mute", [{ name: "a" }, { keys: "h", name: "b" }]), TIMING)).rejects.toThrow(
    /第 1 步/,
  );
});

test("場景表：第一步不送鍵、幀名在場景內不重複、入口是 driver 認得的", () => {
  const files = new Set();
  for (const s of SCENES) {
    expect(files.has(s.file)).toBe(false);
    files.add(s.file);
    expect(s.steps[0].keys || "").toBe("");
    const names = s.steps.map((st) => st.name).filter(Boolean);
    expect(new Set(names).size).toBe(names.length);
    expect(s.entry).toMatch(/^(read:[A-Za-z0-9_-]+|fav|menu)$/);
    expect(s.rows).toBeGreaterThanOrEqual(24);
  }
});
