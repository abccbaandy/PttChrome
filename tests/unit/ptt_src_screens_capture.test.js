// tools/ptt-src-screens/capture.mjs：送鍵 → 收到 driver 回到等鍵（WAIT_MARK）為止＝一幀。用假 driver
// （tests/unit/helpers/fake_ptt_driver.mjs）驗切幀與各種失敗都會變成 CaptureError
// （generate.sh 據此 exit 2＝環境／場景問題，不會產出半套 fixture 當成功）。
import path from "node:path";
import fs from "node:fs";
import { CaptureError, runScene, WAIT_MARK } from "../../tools/ptt-src-screens/capture.mjs";
import { SCENES } from "../../tools/ptt-src-screens/scenes.mjs";

const FAKE = [process.execPath, path.join(__dirname, "helpers/fake_ptt_driver.mjs")];
// frameMaxMs 只是卡死保險：除了「卡死」那條，其餘 case 都不會碰到，結果與機器快慢無關。
const TIMING = { frameMaxMs: 3000 };
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

test("同一幀的兩段 flush 隔很久（機器忙）⇒ 仍併成同一幀，不靠「多久沒輸出」猜幀尾", async () => {
  const out = await runScene(FAKE, "seed", scene("slow", [{ name: "start" }]), TIMING);
  expect(out.frames).toEqual([{ name: "start", keys: "", bytes: "HELLO-SCREEN" }]);
});

test("driver 吐完位元組之後很久才報錯結束（機器忙）⇒ 仍是 CaptureError，不當成功", async () => {
  await expect(runScene(FAKE, "seed", scene("die-slow", [{ name: "list" }]), TIMING)).rejects.toThrow(/enter_board/);
});

test("driver 一直沒回到等鍵 ⇒ CaptureError（不把半幀存成 fixture）", async () => {
  await expect(runScene(FAKE, "seed", scene("hang", [{ name: "a" }]), { frameMaxMs: 300 })).rejects.toThrow(/沒等到/);
});

test("driver.c 的 WAIT_MARK 跟 capture.mjs 同一串，且 generate.sh 用 --wrap 接住 read／select／poll", () => {
  const dir = path.join(__dirname, "../../tools/ptt-src-screens");
  const c = fs.readFileSync(path.join(dir, "driver.c"), "utf8");
  const lit = c.match(/#define WAIT_MARK "((?:[^"\\]|\\.)*)"/);
  expect(lit).not.toBeNull();
  const unescaped = lit[1].replace(/\\x([0-9a-fA-F]{2})|\\(.)/g, (_, hex, ch) => (hex ? String.fromCharCode(parseInt(hex, 16)) : ch));
  expect(unescaped).toBe(WAIT_MARK);
  const gen = fs.readFileSync(path.join(dir, "generate.sh"), "utf8");
  expect(gen).toContain("--wrap=read,--wrap=select,--wrap=poll");
});

test("fileheader_t 推文數欄位新舊 header 都編得過：driver.c 只經 FH_RATING 寫，generate.sh 依 header 選 rating／recommend", () => {
  const dir = path.join(__dirname, "../../tools/ptt-src-screens");
  const c = fs.readFileSync(path.join(dir, "driver.c"), "utf8");
  expect(c).not.toMatch(/\.(recommend|rating)\b/);
  expect(c).toContain("fh.FH_RATING =");
  const gen = fs.readFileSync(path.join(dir, "generate.sh"), "utf8");
  expect(gen).toContain('-DFH_RATING="$FH_RATING"');
  const re = new RegExp(gen.match(/^RATING_RE='([^']*)'$/m)[1].replaceAll("[[:space:]]", "\\s"), "m");
  // upstream b500faf 前後的 fileheader_t
  expect(re.test("    time4_t modified;\n    int16_t rating;                  /* was pad + recommend */\n")).toBe(true);
  expect(re.test("    char    pad;\t\t     /* padding */\n    char    recommend;               /* important level */\n")).toBe(false);
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
    expect(s.entry).toMatch(/^(read:[A-Za-z0-9_-]+|fav|menu|menu:newmail|wmsg:(default|ofo))$/);
    expect(s.rows).toBeGreaterThanOrEqual(24);
  }
});
