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

test("fileheader_t 推文數欄位新舊 header 都編得過：driver.c 只經 FH_RATING 寫，generate.sh 依 header 選 score／rating／recommend", () => {
  const dir = path.join(__dirname, "../../tools/ptt-src-screens");
  const c = fs.readFileSync(path.join(dir, "driver.c"), "utf8");
  expect(c).not.toMatch(/\.(recommend|rating|score)\b/);
  expect(c).toContain("fh.FH_RATING =");
  const gen = fs.readFileSync(path.join(dir, "generate.sh"), "utf8");
  expect(gen).toContain('-DFH_RATING="$FH_RATING"');
  const reOf = (name) => new RegExp(gen.match(new RegExp(`^${name}='([^']*)'$`, "m"))[1].replaceAll("[[:space:]]", "\\s"), "m");
  const score = reOf("SCORE_RE");
  const rating = reOf("RATING_RE");
  // upstream 8d5a7928 後、b500faf 後、b500faf 前的 fileheader_t
  const nowH = "    time4_t modified;\n    int16_t score;                   /* net votes (upvotes - downvotes); was pad + recommend */\n";
  const midH = "    time4_t modified;\n    int16_t rating;                  /* was pad + recommend */\n";
  const oldH = "    char    pad;\t\t     /* padding */\n    char    recommend;               /* important level */\n";
  expect([score.test(nowH), rating.test(nowH)]).toEqual([true, false]);
  expect([score.test(midH), rating.test(midH)]).toEqual([false, true]);
  expect([score.test(oldH), rating.test(oldH)]).toEqual([false, false]);
  // 先認 score 再認 rating，都沒有才是 recommend
  expect(gen.indexOf('"$SCORE_RE"')).toBeGreaterThan(-1);
  expect(gen.indexOf('"$SCORE_RE"')).toBeLessThan(gen.indexOf('"$RATING_RE"'));
});

test("upstream 改名的欄位新舊都編得過：呼叫器只經 UT_WMSG 寫（c4a7085f），實況兩個檔都認 live_run（10db344b）", () => {
  const dir = path.join(__dirname, "../../tools/ptt-src-screens");
  const c = fs.readFileSync(path.join(dir, "driver.c"), "utf8");
  // 只准出現在 #ifdef WMSG_ON 的相容區塊裡
  const compat = c.match(/#ifdef WMSG_ON\n([\s\S]*?)#endif/);
  expect(compat).not.toBeNull();
  expect(compat[1]).toMatch(/#define UT_WMSG wmsg[\s\S]*#else[\s\S]*#define UT_WMSG pager/);
  const rest = c.replace(compat[0], "").replace(/\/\/.*$/gm, ""); // 註解不算
  expect(rest).not.toMatch(/->(pager|wmsg)\b|\bPAGER_ON\b|\bWMSG_ON\b|\bUF_(PAGER|WMSG)_OFO\b/);
  expect(rest).toContain("->UT_WMSG = UT_WMSG_ON");
  const gen = fs.readFileSync(path.join(dir, "generate.sh"), "utf8");
  expect(gen).toMatch(/grep -qs '\^live_run\(' more\.c livepost\.c/);
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
