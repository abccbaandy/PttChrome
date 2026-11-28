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

test("fileheader_t 推文數欄位新舊 header 都編得過：driver.c 只經 FH_RATING 寫，generate.sh 依 header 選 upvote／score／rating／recommend", () => {
  const dir = path.join(__dirname, "../../tools/ptt-src-screens");
  const c = fs.readFileSync(path.join(dir, "driver.c"), "utf8");
  expect(c).not.toMatch(/\.(recommend|rating|score|upvote|downvote)\b/);
  expect(c).toContain("fh.FH_RATING =");
  const gen = fs.readFileSync(path.join(dir, "generate.sh"), "utf8");
  expect(gen).toContain('-DFH_RATING="$FH_RATING"');
  const reOf = (name) => {
    const m = gen.match(new RegExp(`^${name}='([^']*)'$`, "m"));
    expect(m, `generate.sh 缺 ${name}`).not.toBeNull();
    return new RegExp(m[1].replaceAll("[[:space:]]", "\\s"), "m");
  };
  const upvote = reOf("UPVOTE_RE");
  const score = reOf("SCORE_RE");
  const rating = reOf("RATING_RE");
  // upstream 5c1cd6bb 後（score 改名 upvote、另加 downvote；淨推數＝FHDR_SCORE＝upvote - downvote）、
  // 8d5a7928 後、b500faf 後、b500faf 前的 fileheader_t
  const upH =
    "    char    reserved[LEGACY_FNSIZE - FNSIZE - 2]; /* 0; was the end of filename */\n    int16_t downvote;                /* was the end of filename */\n    time4_t modified;\n    int16_t upvote;                  /* was pad + recommend; old records: the net score */\n";
  const nowH = "    time4_t modified;\n    int16_t score;                   /* net votes (upvotes - downvotes); was pad + recommend */\n";
  const midH = "    time4_t modified;\n    int16_t rating;                  /* was pad + recommend */\n";
  const oldH = "    char    pad;\t\t     /* padding */\n    char    recommend;               /* important level */\n";
  expect([upvote.test(upH), score.test(upH), rating.test(upH)]).toEqual([true, false, false]);
  expect([upvote.test(nowH), score.test(nowH), rating.test(nowH)]).toEqual([false, true, false]);
  expect([upvote.test(midH), score.test(midH), rating.test(midH)]).toEqual([false, false, true]);
  expect([upvote.test(oldH), score.test(oldH), rating.test(oldH)]).toEqual([false, false, false]);
  // 先認 upvote、再 score、再 rating，都沒有才是 recommend
  expect(gen.indexOf('"$UPVOTE_RE"')).toBeGreaterThan(-1);
  expect(gen.indexOf('"$UPVOTE_RE"')).toBeLessThan(gen.indexOf('"$SCORE_RE"'));
  expect(gen.indexOf('"$SCORE_RE"')).toBeLessThan(gen.indexOf('"$RATING_RE"'));
  expect(gen).toMatch(/"\$UPVOTE_RE"[^\n]*then FH_RATING=upvote\b/);
});

test("留言主題持久化（upstream 01dc2b11）：pwcuSetCommentTheme 經 --wrap 只寫 cuser，不走 PWCU（driver 沒 usernum／.PASSWDS，assert SIGABRT）", () => {
  const dir = path.join(__dirname, "../../tools/ptt-src-screens");
  const c = fs.readFileSync(path.join(dir, "driver.c"), "utf8");
  const gen = fs.readFileSync(path.join(dir, "generate.sh"), "utf8");
  // 舊 upstream 沒有這個函式（主題存在 pmore 的 static）⇒ 看 proto.h 決定，wrap 只在有的時候接
  expect(gen).toMatch(/grep -q 'pwcuSetCommentTheme' \.\.\/include\/proto\.h; then HAS_COMMENT_THEME=1/);
  expect(gen).toContain('-DHAS_COMMENT_THEME="$HAS_COMMENT_THEME"');
  expect(gen).toMatch(/--wrap=pwcuSetCommentTheme/);
  const block = c.match(/#if HAS_COMMENT_THEME\n([\s\S]*?)#endif/);
  expect(block).not.toBeNull();
  expect(block[1]).toMatch(/int __wrap_pwcuSetCommentTheme\(uint8_t theme\)/);
  // CONFIG_CONST_CUSER 下 cuser 是 const 巨集 ⇒ 寫可寫本體 pwcuser
  expect(block[1]).toContain("pwcuser.comment_theme = theme;");
  expect(block[1]).not.toMatch(/__real_pwcuSetCommentTheme/);
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

// nightly 拿新產的 fixture 跟 repo 的逐位元組比（git diff）：repo 裡的格式跟 capture.mjs 的輸出不同，
// 就天天報「upstream 改了畫面」。lint-staged 對 *.json 跑 prettier（2 格縮排）⇒ 兩個目錄要在 .prettierignore。
test("fixture 維持 capture.mjs 的原始格式（JSON 縮排 1），且不被 pre-commit 的 prettier 改寫", () => {
  const root = path.join(__dirname, "../..");
  const ignore = fs.readFileSync(path.join(root, ".prettierignore"), "utf8").split("\n");
  const cap = fs.readFileSync(path.join(root, "tools/ptt-src-screens/capture.mjs"), "utf8");
  expect(cap).toContain("JSON.stringify(out, null, 1) + '\\n'");
  for (const dir of ["ptt_src_screens", "ptt_src_screens_legacy"]) {
    expect(ignore).toContain(`tests/unit/fixtures/${dir}/`);
    const abs = path.join(__dirname, "fixtures", dir);
    for (const f of fs.readdirSync(abs).filter((n) => n.endsWith(".json"))) {
      const raw = fs.readFileSync(path.join(abs, f), "utf8");
      expect(raw, `${dir}/${f}`).toBe(JSON.stringify(JSON.parse(raw), null, 1) + "\n");
    }
  }
});
