// scenario 錄製器（連真 PTT，**整輪一次登入**）：把「一段操作」錄成 offline 可重放的素材
// tests/e2e/cassettes/scn-<name>.json。
//
// 為什麼要有這支（2026-10）：live e2e 縮成核心煙霧測試後，被刪掉的 live 測項改由 offline
// 守護；但那些行為需要真的 PTT 往返（按 h 的 pmore 說明、r 的回應至、:N 跳行、列表 `]`、
// AID 跳文／返回、deep link 落地、看板列表捲動、搜尋看板 prompt…），既有 cassette 沒有。
//
// 機制：產品自己的 DebugRecorder（helpers/recording.js）錄雙向 bytes → 從錄製器送出的第一個
// Ctrl-L 起切成 cassette（首幀＝整頁重畫）→ 每個 send 一個 step。classifySend 認得的鍵
// 是具名 step（pagedown/jump/open…），其餘是 `on:'raw'`＋原始 bytes；重放端
// `helpers/replay.js#replayListCassette` 依送出的 bytes 逐步門控。
//
// 錄製紀律（重放能不能對上全看這三條）：
//   1. 每個動作前後都 waitWireQuiet（往返靜止＋背景佇列 idle）：重放時回應是「瞬間」到，
//      錄製時若讓使用者鍵和背景補頁交錯，送出順序就對不上。offline spec 照同樣的節拍操作。
//   2. 準備動作（找文章、撈 AID、進板）**不錄**：錄製器在準備完才開，首幀用 Ctrl-L 重畫。
//   3. prefs 在開錄前套好，寫進 meta.prefs；offline spec 照抄。
//
// 用法：`yarn record:scenarios`（全部）或 `RECORD_SCENARIOS_ONLY=er-help,list-bracket yarn record:scenarios`。
// 帳密：env PTT_USER/PTT_PASS（走產品自動登入）；沒有就 guest（需要帳號的 scenario 自動略過）。
// 隱私：stop 時 redact（帳號等長遮蔽／IPv4／密碼／2FA 密鑰）＋ assertNoLeak，見 helpers/recording.js。
// commit 前仍要 git diff 複查。
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const {
  login,
  autoLoginBoot,
  gotoBoard,
  sendKey,
  typeLine,
  applyPrefs,
  readScreen,
  waitForScreen,
  resetSession,
  readListCandidates,
  waitEasyReadingComplete,
  attachConsole,
} = require('../helpers/ptt');
const {
  installRecvCounter,
  startRecorder,
  stopRecorder,
  toScenarioCassette,
  waitWireQuiet,
} = require('../helpers/recording');

const CASSETTE_DIR = path.join(__dirname, '..', 'cassettes');
const HAS_ACCOUNT = !!(process.env.PTT_USER && process.env.PTT_PASS);
const AID_RE = /文章代碼\(AID\):\s*#([0-9A-Za-z_-]{8})/;
const ONLY = (process.env.RECORD_SCENARIOS_ONLY || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ---- 準備動作（不錄） ----

async function jumpTo(page, num) {
  await page.evaluate((n) => window.__app.conn.send(String(n) + '\r'), num);
  await page.waitForFunction(
    (n) => {
      const buf = window.__app.buf;
      const m = /^[>\s]*(\d+)\s/.exec(buf.getRowText(buf.cur_y, 0, buf.cols) || '');
      return !!m && parseInt(m[1], 10) === n;
    },
    num,
    { timeout: 10000 }
  );
  await waitWireQuiet(page);
}

// 列表上挑一篇推文數落在 [min,max] 的一般文章（不是置底、不是爆文）。
async function pickArticle(page, { min, max }) {
  for (let p = 0; p < 4; p++) {
    const cands = await readListCandidates(page, { min, max });
    if (cands.length) return cands[cands.length - 1].num;
    await sendKey(page, 'PageUp');
    await waitWireQuiet(page);
  }
  throw new Error(`列表上找不到推文數 ${min}~${max} 的文章`);
}

// 游標文章的 AID（大寫 Q 資訊框）。
async function cursorAid(page) {
  await sendKey(page, 'Q');
  await waitForScreen(page, ['文章代碼'], { timeout: 10000 });
  const m = (await readScreen(page)).match(AID_RE);
  if (!m) throw new Error('Q 資訊框沒有 AID');
  await sendKey(page, 'Space');
  await waitWireQuiet(page);
  return m[1];
}

// 文章好讀開得起來、而且累積得完的那一篇（候選由新到舊試）。
async function openArticleForEasyReading(page, { min, max, minPages }) {
  for (let p = 0; p < 4; p++) {
    const cands = (await readListCandidates(page, { min, max })).reverse();
    for (const c of cands) {
      await jumpTo(page, c.num);
      await sendKey(page, 'Enter');
      const acc = await waitEasyReadingComplete(page, { timeout: 40000 });
      const pages = await page.evaluate(() => {
        const m = /第\s*(\d+)\s*\/\s*(\d+)\s*頁/.exec(
          window.__app.buf.getRowText(window.__app.buf.rows - 1, 0, window.__app.buf.cols)
        );
        return m ? parseInt(m[2], 10) : 0;
      });
      await sendKey(page, 'ArrowLeft');
      await page.waitForFunction(() => window.__app.buf.pageState === 2, null, { timeout: 15000 });
      await waitWireQuiet(page);
      if (acc.reachedEnd && (!minPages || pages >= minPages)) return c.num;
    }
    await sendKey(page, 'PageUp');
    await waitWireQuiet(page);
  }
  throw new Error('找不到適合的文章');
}

// 進到一份「看板列表平滑捲動會接管、而且超過兩個視口」的分類子清單（guest 也有，
// 不含個人最愛）。離開時**停在清單裡、pref 關著**（原生畫面）：scenario 開錄後才把
// pref 打開，engage 與補頁的往返才會在素材裡。
// 判準全部問產品（buf.listRenderOwner）或與自己比對（起點畫面的 row 0），不認畫面文字。
async function pickClassSublist(page) {
  const facts = () =>
    page.evaluate(() => {
      const app = window.__app;
      const b = app.buf;
      const engaged = b.listRenderOwner === 'board-list';
      return {
        // 平滑捲動接管時 ↓ 是本地選取（server 游標不動）⇒ 看選取序號；原生時看游標列。
        cursorY: engaged ? app.boardListSession._selectedNum : b.cur_y,
        pause: b.pageState !== 3 && b.isPassScreenNow(), // 排除文章，見 helpers/ptt.js#resetSession
        // 「這是哪一份清單」：server 畫面上各列的板名（不含人氣這類會變的欄位）。
        names: (() => {
          const out = [];
          for (let r = 3; r < b.rows - 1; r++) {
            const m = /^[>\s]*\d+[^A-Za-z0-9_]*([A-Za-z0-9_-]+)/.exec(b.getRowText(r, 0, b.cols));
            if (m) out.push(m[1]);
          }
          return out.join(',');
        })(),
        engaged,
        buffered: (b.brdListLineNums || []).length,
        body: b.rows - 4,
        pageState: b.pageState,
      };
    });
  // 超過一頁 ⇒ 捲得動、End 要跨頁去抓。（2026-10 實測：分類看板第一層的子清單都 ≤20，
  // 要往下第二層才有長清單。）
  const longEnough = (f) => f.engaged && f.buffered > f.body;
  // 「回到第 depth 層了嗎」只問產品狀態，不比畫面文字：看板列表每列都有即時人氣數，
  // 同一份清單兩次讀到的文字不會一樣（2026-10 第三輪錄製實錄）。
  //   第 1 層＝分類看板根（不接管，pageState 與起點相同）；更深＝被接管的子清單。
  let root = null;
  const atLevel = (depth, f) =>
    depth === 1 ? !f.engaged && !f.pause && f.pageState === root.pageState : f.engaged;
  const backToLevel = async (depth) => {
    for (let k = 0; k < 8; k++) {
      const f = await facts();
      if (atLevel(depth, f)) return;
      await sendKey(page, f.pause ? 'Space' : 'ArrowLeft');
      await waitWireQuiet(page);
    }
    throw new Error(`退不回第 ${depth} 層清單`);
  };
  // 深度優先：在目前這份清單裡逐項 Enter；接管但不夠長就再往下一層。找到時停在裡面。
  const search = async (depth, path) => {
    for (let i = 0; i < 20; i++) {
      const namesBefore = (await facts()).names;
      await sendKey(page, 'Enter');
      await waitWireQuiet(page);
      const f = await facts();
      // 分隔線／無權限板：PTT 對 Enter **零回應**（board.c#board_cmd_select 直接 return），
      // 畫面還是這一層 —— 不能當成「進了子分類」再按 ←，那會退過頭。平滑捲動接管時開板
      // 交易會先送跳號（有回應），所以不能看 recv，看「板名清單換了沒」。
      const moved = f.pause || f.names !== namesBefore;
      console.log(
        `[record] class ${path}${i}: moved=${moved} engaged=${f.engaged} buffered=${f.buffered} pageState=${f.pageState}`
      );
      if (moved && longEnough(f)) return true;
      if (moved && f.engaged) {
        // 子分類：還能往下就往下；沒找到時 search 停在子分類裡 ⇒ ← 一次回到這一層。
        if (depth < 2 && (await search(depth + 1, `${path}${i}/`))) return true;
        await sendKey(page, 'ArrowLeft');
        await waitWireQuiet(page);
      }
      // 看板（文章列表／進板畫面）或上面那一下 ←：退到這一層為止。
      await backToLevel(depth);
      const y = (await facts()).cursorY;
      await sendKey(page, 'ArrowDown');
      await waitWireQuiet(page);
      if ((await facts()).cursorY === y) break; // 到清單尾了（游標沒動）
    }
    return false;
  };
  await applyPrefs(page, { enableBoardListSmoothScroll: true });
  await sendKey(page, 'C');
  await waitWireQuiet(page);
  await sendKey(page, 'Enter');
  await waitWireQuiet(page);
  root = await facts();
  console.log('[record] class 起點:', JSON.stringify(root));
  if (!(await search(1, ''))) throw new Error('分類看板裡找不到會 engage 且超過一頁的子清單');
  // 回到原生畫面（交易收攤），等開錄後再打開。
  await applyPrefs(page, { enableBoardListSmoothScroll: false });
  await waitWireQuiet(page);
}

// ---- 錄製骨架 ----

async function record(page, name, meta, act) {
  await startRecorder(page);
  await page.evaluate(() => window.__app.conn.send('\x0c'));
  await waitWireQuiet(page);
  const out = {};
  await act(out);
  await waitWireQuiet(page);
  const rec = await stopRecorder(page);
  const cassette = toScenarioCassette(rec, Object.assign({ scenario: name }, meta, out));
  const file = path.join(CASSETTE_DIR, `scn-${name}.json`);
  fs.writeFileSync(file, JSON.stringify(cassette) + '\n', 'utf8');
  console.log(`[record] scn-${name}: ${cassette.steps.length} steps → ${path.relative(process.cwd(), file)}`);
}

async function inArticleEasyReading(page) {
  await sendKey(page, 'Enter');
  const acc = await waitEasyReadingComplete(page, { timeout: 60000 });
  expect(acc.reachedEnd).toBe(true);
  await waitWireQuiet(page);
}

const fnMode = (page) => page.evaluate(() => !!window.__app.easyReading._functionMode);

// ---- scenarios ----
// 每個 scenario：prep（不錄）→ record(act)。prefs 一律寫進 meta，offline 照抄。

const ER_PREFS = { enableEasyReading: true, mergeSameAuthorComments: false };

const SCENARIOS = {
  // 好讀按 h → pmore 說明（functionMode 鏡像原生）→ 空白鍵離開回長頁。
  'er-help': async (page) => {
    await resetSession(page);
    await applyPrefs(page, ER_PREFS);
    await gotoBoard(page, 'C_Chat');
    const num = await openArticleForEasyReading(page, { min: 1, max: 20 });
    await jumpTo(page, num);
    await record(page, 'er-help', { board: 'C_Chat', prefs: ER_PREFS }, async () => {
      await inArticleEasyReading(page);
      await sendKey(page, 'h');
      await page.waitForFunction(() => window.__app.easyReading._functionMode === true, null, {
        timeout: 15000,
      });
      await waitWireQuiet(page);
      await sendKey(page, 'Space');
      await page.waitForFunction(() => window.__app.easyReading._functionMode === false, null, {
        timeout: 15000,
      });
    });
  },

  // 好讀按 r → 「回應至」（functionMode）→ q＋Enter 取消（不發文）。guest 不能回文。
  'er-reply': async (page) => {
    if (!HAS_ACCOUNT) return console.log('[record] er-reply 需要帳號，略過');
    await resetSession(page);
    await applyPrefs(page, ER_PREFS);
    await gotoBoard(page, 'C_Chat');
    const num = await openArticleForEasyReading(page, { min: 1, max: 20 });
    await jumpTo(page, num);
    await record(page, 'er-reply', { board: 'C_Chat', prefs: ER_PREFS }, async () => {
      await inArticleEasyReading(page);
      await sendKey(page, 'r');
      await waitForScreen(page, ['回應至'], { timeout: 15000 });
      expect(await fnMode(page)).toBe(true);
      await waitWireQuiet(page);
      await typeLine(page, 'q');
      await page.waitForFunction(() => window.__app.easyReading._functionMode === false, null, {
        timeout: 15000,
      });
    });
  },

  // 好讀 :5 往回跳（seekBack）。文章要三頁以上，跳轉落點才整頁都在已累積範圍內。
  'er-seekback': async (page) => {
    await resetSession(page);
    await applyPrefs(page, ER_PREFS);
    await gotoBoard(page, 'C_Chat');
    const num = await openArticleForEasyReading(page, { min: 10, max: 60, minPages: 3 });
    await jumpTo(page, num);
    await record(page, 'er-seekback', { board: 'C_Chat', prefs: ER_PREFS }, async () => {
      await inArticleEasyReading(page);
      await sendKey(page, ':');
      await waitWireQuiet(page);
      await typeLine(page, '5');
      await page.waitForFunction(() => window.__app.easyReading._functionMode === false, null, {
        timeout: 15000,
      });
    });
  },

  // 列表好讀 `]`（A 類鍵：凍結交易）。開錄後才開 pref ⇒ engage 的預讀也在素材裡。
  'list-bracket': async (page) => {
    await resetSession(page);
    await gotoBoard(page, 'C_Chat');
    const num = await pickArticle(page, { min: 0, max: 99 });
    await jumpTo(page, num);
    await record(page, 'list-bracket', { board: 'C_Chat', prefs: { enableEasyReadingList: true } }, async () => {
      await applyPrefs(page, { enableEasyReadingList: true });
      await page.waitForFunction(() => window.__app.listSession.state === 'active', null, {
        timeout: 20000,
      });
      await waitWireQuiet(page);
      await sendKey(page, ']');
      await waitWireQuiet(page);
    });
  },

  // AID 跳文 → 返回（序號錨點＋捲動位置）。開著列表好讀（返回錨點走 listSession）。
  // 列表好讀的 pref 一定要**開錄之後**才開：engage 的預讀 jump 是重放端也會送的 bytes，
  // 在準備階段先開掉的話，素材裡就沒有那幾步，重放第一個 jump 就對不上。
  'aid-back': async (page) => {
    const prefs = { enableEasyReading: true, enableEasyReadingList: true, mergeSameAuthorComments: false };
    await resetSession(page);
    await gotoBoard(page, 'movie');
    // 兩篇一般文章（不碰置底：PTT 的 Home 在這裡不會把游標帶走，2026-10 錄到的是置底文）：
    // 跳文目標＝這一頁較舊的那篇，原文＝較新的那篇。
    const cands = await readListCandidates(page, { min: 0, max: 99 });
    if (cands.length < 2) throw new Error('列表上不到兩篇一般文章');
    await jumpTo(page, cands[0].num);
    const aid = await cursorAid(page);
    await jumpTo(page, cands[cands.length - 1].num);
    await applyPrefs(page, { enableEasyReading: true, mergeSameAuthorComments: false });
    await record(page, 'aid-back', { board: 'movie', aid, prefs }, async () => {
      await applyPrefs(page, { enableEasyReadingList: true });
      await page.waitForFunction(() => window.__app.listSession.state === 'active', null, {
        timeout: 20000,
      });
      await waitWireQuiet(page);
      await inArticleEasyReading(page);
      await page.evaluate(([a, b]) => window.__app.aidNavigation.start(a, b), [aid, 'movie']);
      await page.waitForFunction(() => window.__app.aidNavigation.active === false, null, {
        timeout: 30000,
      });
      await waitWireQuiet(page);
      await page.evaluate(() => window.__app.aidNavigation.back());
      await page.waitForFunction(() => window.__app.aidNavigation.active === false, null, {
        timeout: 30000,
      });
    });
  },

  // `/` 標題搜尋的清單裡開文 → AID 跳文 → 返回（aid 錨點，免疫序號位移）。
  'aid-back-search': async (page) => {
    // searchKeyOpensModal：錄的是原生 `/` prompt 逐字打（搜尋彈窗另由 offline spec 守）。
    const prefs = { enableEasyReading: true, mergeSameAuthorComments: false, searchKeyOpensModal: false };
    await resetSession(page);
    await gotoBoard(page, 'movie');
    // 關鍵字：最新一頁第一篇一般文章標題的前三個字（分類 [xx] 之後）——搜尋結果至少有它。
    const keyword = await page.evaluate(() => {
      const buf = window.__app.buf;
      for (let r = 3; r < buf.rows - 1; r++) {
        const row = buf.getRowText(r, 0, buf.cols);
        if (!/^[>\s]*\d+\s/.test(row)) continue;
        const t = row
          .slice(30)
          .replace(/^[^\p{Script=Han}A-Za-z0-9[]+/u, '')
          .replace(/^\[[^\]]*\]\s*/, '')
          .trim();
        if (t.length >= 3) return t.slice(0, 3);
      }
      return null;
    });
    if (!keyword) throw new Error('列表上找不到可當關鍵字的標題');
    await sendKey(page, 'Home');
    await waitWireQuiet(page);
    const aid = await cursorAid(page);
    await sendKey(page, 'End');
    await waitWireQuiet(page);
    await applyPrefs(page, prefs);
    await record(page, 'aid-back-search', { board: 'movie', aid, keyword, prefs }, async () => {
      await sendKey(page, 'Slash');
      await waitWireQuiet(page);
      await typeLine(page, keyword);
      await waitWireQuiet(page);
      await inArticleEasyReading(page);
      await page.evaluate(([a, b]) => window.__app.aidNavigation.start(a, b), [aid, 'movie']);
      await page.waitForFunction(() => window.__app.aidNavigation.active === false, null, {
        timeout: 30000,
      });
      await waitWireQuiet(page);
      await page.evaluate(() => window.__app.aidNavigation.back());
      await page.waitForFunction(() => window.__app.aidNavigation.active === false, null, {
        timeout: 30000,
      });
    });
  },

  // deep link（hashchange）：主功能表 → s<board> → 進板畫面 → #AID → 落地好讀；再 F2 複製連結。
  'deep-link': async (page) => {
    if (!HAS_ACCOUNT) return console.log('[record] deep-link 需要帳號（等登入完成才跳），略過');
    await resetSession(page);
    await gotoBoard(page, 'Steam');
    const aid = await cursorAid(page);
    await resetSession(page);
    await applyPrefs(page, { enableEasyReading: true });
    await record(page, 'deep-link', { board: 'Steam', aid, prefs: { enableEasyReading: true } }, async () => {
      await page.evaluate((h) => (window.location.hash = h), '#Steam/' + aid);
      await page.waitForFunction(
        () => window.__app.buf.pageState === 3 && window.__app.aidNavigation.active === false,
        null,
        { timeout: 120000 }
      );
      await waitWireQuiet(page);
      await page.evaluate(() => {
        navigator.clipboard.writeText = () => Promise.resolve();
      });
      await sendKey(page, 'F2');
      await waitWireQuiet(page);
    });
    await page.evaluate(() => (window.location.hash = ''));
  },

  // 看板列表平滑捲動（分類看板子分類＝guest 也錄得到，不含個人最愛）：
  // 進板列表 engage → 補頁 → End → Home → `/`（B 類鍵：原生鏡像）取消 → ← 離開。
  // pref 在開錄之後才打開（evaluateNow 把當下畫面當成剛 settle）⇒ engage＋補頁在素材裡；
  // offline 照同樣順序：首幀 → applyPrefs → 等 engage。
  'boardlist-class': async (page) => {
    const prefs = { enableBoardListSmoothScroll: true };
    await resetSession(page);
    await pickClassSublist(page);
    await record(page, 'boardlist-class', { prefs }, async () => {
      await applyPrefs(page, prefs);
      await page.waitForFunction(() => window.__app.buf.listRenderOwner === 'board-list', null, {
        timeout: 15000,
      });
      await waitWireQuiet(page);
      await sendKey(page, 'End');
      await waitWireQuiet(page);
      await sendKey(page, 'Home');
      await waitWireQuiet(page);
      await sendKey(page, 'Slash');
      await waitWireQuiet(page);
      await sendKey(page, 'Enter');
      await waitWireQuiet(page);
      await sendKey(page, 'ArrowLeft');
    });
  },

  // 看板列表按 s：搜尋看板 prompt（游標格 fg=0/bg=7、整頁不上底色、殘留列表不可點）。
  'board-search-prompt': async (page) => {
    const prefs = {
      // 錄的是原生 s prompt（搜尋彈窗另由 offline spec 守）。
      searchKeyOpensModal: false,
      enableBoardListSmoothScroll: false,
      useMouseBrowsing: true,
      highlightCursor: true,
      keyboardCursorHighlight: true,
      mouseMisclickGuard: true,
      mouseLeftClick: true,
      mouseBrowsingHighlightColor: 1,
      enableEasyReading: false,
    };
    await resetSession(page);
    await pickClassSublist(page); // 停在分類子清單（show_brdlist，原生畫面）
    await applyPrefs(page, prefs);
    await waitWireQuiet(page);
    expect(await page.evaluate(() => window.__app.buf.pageState)).toBe(2);
    await record(page, 'board-search-prompt', { prefs }, async () => {
      await sendKey(page, 's');
      await waitForScreen(page, ['自動搜尋'], { timeout: 10000 });
      await waitWireQuiet(page);
      await sendKey(page, 'Enter');
    });
  },
};

test.describe('scenario 錄製器', () => {
  test.skip(!process.env.RECORD_SCENARIOS, '只在 yarn record:scenarios（RECORD_SCENARIOS=1）時執行');

  test('record scenarios', async ({ page }) => {
    test.setTimeout(30 * 60 * 1000);
    const logs = attachConsole(page);
    if (HAS_ACCOUNT) await autoLoginBoot(page);
    else {
      await page.goto('/');
      console.log(await login(page));
    }
    await installRecvCounter(page);
    const names = ONLY.length ? ONLY : Object.keys(SCENARIOS);
    const failed = [];
    for (const name of names) {
      if (!SCENARIOS[name]) throw new Error(`未知 scenario: ${name}（可用: ${Object.keys(SCENARIOS).join(', ')}）`);
      try {
        await SCENARIOS[name](page);
      } catch (e) {
        // 一段失敗不重登：記下來繼續錄下一段（重登＝多一次登入）。
        failed.push(name);
        console.log(`[record] ${name} 失敗：${e.message}\n${(await readScreen(page)).slice(0, 2000)}`);
        console.log(logs.slice(-20).join('\n'));
        await page.evaluate(() => window.__e2eRec && window.__e2eRec.isRecording && window.__e2eRec.stop());
      }
    }
    expect(failed).toEqual([]);
  });
});
