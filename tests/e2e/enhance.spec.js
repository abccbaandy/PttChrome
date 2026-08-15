const { test, expect } = require('./helpers/fixtures');
const {
  readScreen,
  sendKey,
  typeLine,
  attachConsole,
  dismissDeveloperModeAlert,
  applyPrefs,
  resetSession,
  gotoBoard,
  waitEasyReadingComplete,
} = require('./helpers/ptt');

// Enhanced Add-on：樓層編號 + 黑名單。連真 PTT，需好讀模式。
// 對應 src/js/comment_parse.js / Screen.js / term_view.js(appendRows)。
// 共用登入 session（helpers/fixtures.js）；自動登入 test 例外（本質測登入流程，獨立 page）。

const KEY = 'pttchrome.pref.v1';

test.describe.serial('enhanced add-on（共用 session）', () => {
  test('樓層編號：好讀模式推文出現遞增序號', async ({ shared }) => {
    const { page, logs } = shared;
    logs.length = 0;
    try {
      await resetSession(page);
      // mergeSameAuthorComments:false —— 本測鎖「逐列樓號連增」舊行為；
      // 合併（預設開）的行為守護在 offline comment_merge spec。
      await applyPrefs(page, {
        enableEasyReading: true,
        showFloorNumbers: true,
        mergeSameAuthorComments: false,
      });

      await gotoBoard(page, 'C_Chat');

      // 開最新一篇，等好讀自動翻頁把整篇累積完（到底才取樣，見 waitEasyReadingComplete；
      // 舊版靠固定 4 次 Space + 固定 timeout，長文會停在推文區之前）
      await sendKey(page, 'End');
      await page.waitForTimeout(800);
      await sendKey(page, 'Enter');
      const acc = await waitEasyReadingComplete(page);
      console.log('ACCUMULATE:', JSON.stringify(acc));

      const floors = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#mainContainer [data-floor]'))
          .map((el) => parseInt(el.textContent, 10))
          .filter((n) => !Number.isNaN(n))
      );
      console.log('FLOOR BADGES:', JSON.stringify(floors.slice(0, 20)), 'total', floors.length);

      expect(floors.length).toBeGreaterThan(0);
      // 遞增且從 1 開始
      expect(floors[0]).toBe(1);
      for (let i = 1; i < floors.length; i++) {
        expect(floors[i]).toBe(floors[i - 1] + 1);
      }

      // 每個樓層徽章都必須落在「真推文列」上：該列文字結尾有 MM/DD HH:MM 時間戳。
      // 守護偵測太鬆的回歸：內文推文格式文字 / ※編輯 / 空白列皆無時間戳，不該拿到徽章。
      const badgeRows = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#mainContainer [data-floor]')).map((el) => {
          const row = el.closest('[data-type="bbsline"]') || el.closest('[type="bbsrow"]');
          return row ? row.textContent : '';
        })
      );
      console.log('BADGE ROW SAMPLE:', JSON.stringify(badgeRows.slice(0, 5)));
      badgeRows.forEach((t) => expect(t).toMatch(/\d{1,2}\/\d{2}\s+\d{2}:\d{2}/));
    } catch (err) {
      console.log('\n=== console ===\n' + logs.slice(-30).join('\n'));
      await page.screenshot({ path: 'tests/e2e/__screenshots__/enhance-floor-error.png', fullPage: true });
      throw err;
    }
  });

  // 黑名單核心：好讀模式下被封鎖推文者的推文整列移除（不留空行）。
  // 在同一篇文章上驗證：讀取 → 封鎖某推文者 → 離開再進入重新累積 → 該人推文消失且總列數下降。
  test('黑名單：好讀模式移除推文且不留空行', async ({ shared }) => {
    test.setTimeout(180000); // 找有推文的文章 + 兩階段累積，需較長時間
    const { page, logs } = shared;
    logs.length = 0;
    // 注意：樓層徽章會插在 marker 與 userid 之間（"推9 userid"），故 \d* 略過徽章數字。
    const pushers = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('#mainContainer [data-type="bbsline"]'))
          .map((el) => {
            const m = el.textContent.match(/^(推|噓|→)\d*\s+([0-9A-Za-z]+)\s*:/);
            return m ? m[2] : null;
          })
          .filter(Boolean)
      );
    // 列數由 waitEasyReadingComplete 在「整篇累積完畢」那一刻回報（見 helper 註解），
    // 不另外抓當下值——隨手抓到的是翻頁途中的快照，跨階段不可比。

    try {
      await resetSession(page);
      // 關合併：本測按逐列 pusher 列數與樓號缺口斷言（合併行為另測）。
      await applyPrefs(page, {
        enableEasyReading: true,
        showFloorNumbers: true,
        mergeSameAuthorComments: false,
      });
      await gotoBoard(page, 'C_Chat');

      // 用與樓層測試相同的成功導航（End→Enter）；若該篇無推文，回列表往上一篇再試。
      //
      // 取樣點＝「整篇累積完畢」(waitEasyReadingComplete)，不是「翻 N 次 Space 之後」。
      // 前後兩階段必須停在同一個可重現的終點，c1/c2 才可比：舊版前 3 次 / 後 5 次
      // Space，長文兩邊停在不同位置 ⇒ c2(412) > c1(288) 必紅（2026-08）。
      await sendKey(page, 'End');
      await page.waitForTimeout(800);
      let before = [];
      let c1 = 0;
      for (let attempt = 0; attempt < 6; attempt++) {
        await sendKey(page, 'Enter');
        const acc = await waitEasyReadingComplete(page);
        console.log('ACCUMULATE BEFORE:', JSON.stringify(acc));
        before = await pushers();
        if (before.length > 0 && acc.reachedEnd) {
          c1 = acc.rows;
          break;
        }
        // 無推文（或沒讀到底）→ 離開回列表、往上一篇（較舊）再試
        await sendKey(page, 'ArrowLeft');
        await page.waitForTimeout(1300);
        await sendKey(page, 'ArrowUp');
        await page.waitForTimeout(500);
        before = [];
      }
      console.log('PUSHERS BEFORE:', before.length, 'childRows', c1);
      test.skip(before.length === 0, '找不到有推文且能讀到底的文章，跳過黑名單驗證');

      // 選出現次數最多的推文者
      const freq = {};
      before.forEach((p) => (freq[p] = (freq[p] || 0) + 1));
      const target = Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0];
      const targetCount = freq[target];
      console.log('BLACKLIST TARGET:', target, 'x', targetCount);

      // 設黑名單到 view（appendRows 讀 this.blacklist）
      await page.evaluate((t) => {
        window.__app.view.blacklist = new Set([t.toLowerCase()]);
      }, target);

      // 離開回列表（游標仍停在本篇）→ 再進入，好讀重新累積套用黑名單。
      // 同樣等到整篇讀完才取樣：與 c1 同基準（同一篇、同樣讀到 100%）。
      await sendKey(page, 'ArrowLeft');
      await page.waitForTimeout(1500);
      await sendKey(page, 'Enter');
      const acc2 = await waitEasyReadingComplete(page);
      console.log('ACCUMULATE AFTER:', JSON.stringify(acc2));
      expect(acc2.reachedEnd).toBe(true);

      const after = await pushers();
      const c2 = acc2.rows;
      console.log('PUSHERS AFTER:', after.length, 'childRows', c2);

      // 被封鎖者的推文完全消失
      expect(after.includes(target)).toBe(false);
      // 列數真的變少（整列移除，非僅隱藏占行），且至少少掉該人的那幾列
      expect(c2).toBeLessThan(c1);
      expect(before.length - after.length).toBeGreaterThanOrEqual(targetCount);

      // 樓層嚴格遞增。設計上黑名單列「仍占樓號」（編號絕對，見 comment_parse.test.js
      // "floors advance for every comment including blacklisted"），故移除處會留缺號，
      // 不可斷言連續；只守護無重複/亂序。
      const floors = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#mainContainer [data-floor]'))
          .map((el) => parseInt(el.textContent, 10))
          .filter((n) => !Number.isNaN(n))
      );
      for (let i = 1; i < floors.length; i++) {
        expect(floors[i]).toBeGreaterThan(floors[i - 1]);
      }
    } catch (err) {
      console.log('\n=== console ===\n' + logs.slice(-30).join('\n'));
      await page.screenshot({ path: 'tests/e2e/__screenshots__/enhance-blacklist-error.png', fullPage: true });
      throw err;
    }
  });

  // 看板列表黑名單（原生列表規則，3409aea 起）：被封鎖作者的列渲染成
  // 「（本文已被黑名單） <作者>」通知列，不再 visibility:hidden——隱藏只發生在
  // 好讀列表視窗（enableEasyReadingList，見 docs/easy-reading-list.md 不變量 10；
  // 通知列/隱藏雙模的離線守護在 enhance.offline.spec.js）。此 live 案鎖真 PTT
  // 畫面下 onPrefChange('blacklist') → redraw 的端到端行為。
  test('看板列表黑名單：原生列表渲染通知列（不隱藏）', async ({ shared }) => {
    test.setTimeout(120000);
    const { page, logs } = shared;
    logs.length = 0;
    try {
      await resetSession(page);
      await applyPrefs(page, { enableEasyReading: true, showFloorNumbers: true });
      await gotoBoard(page, 'C_Chat'); // 停在 C_Chat 列表
      await page.waitForTimeout(1000);

      const r = await page.evaluate(() => {
        const app = window.__app;
        const sel = '#mainContainer > span[type="bbsrow"]';
        // textContent（非 innerText）：visibility:hidden 的列 innerText 會是空字串。
        const authorCol = (el) => el.textContent.substring(17, 29).trim();
        // 行首＝空白／游標標記。游標兩代：新 '>'（半形，pttbbs b9a5029f 起）與
        // 舊 '●'（全形，會吃掉序號最高位 → 只剩 5 位）。
        const isIndexRow = (el) =>
          /^[ >●]?\d{5,6}\s/.test(el.textContent) && /^[0-9A-Za-z]+$/.test(authorCol(el));
        // 選列表中第一個合法作者
        let target = '';
        for (const el of document.querySelectorAll(sel)) {
          if (isIndexRow(el)) { target = authorCol(el); break; }
        }
        // 走真實 pref handler（會 parseBlacklist + redraw）
        app.onPrefChange('blacklist', target);
        const after = Array.from(document.querySelectorAll(sel)).map((el) => ({
          text: el.textContent,
          vis: getComputedStyle(el).visibility,
        }));
        const noticeRows = after.filter(
          (x) => x.text.includes('（本文已被黑名單）') && x.text.includes(target)
        );
        return {
          target,
          pageState: app.buf.pageState,
          hiddenCount: after.filter((x) => x.vis === 'hidden').length,
          noticeCount: noticeRows.length,
          noticeHidden: noticeRows.some((x) => x.vis === 'hidden'),
        };
      });
      console.log('LIST BLACKLIST:', JSON.stringify(r));

      expect(r.target).not.toBe('');
      expect(r.pageState).toBe(2);
      expect(r.noticeCount).toBeGreaterThanOrEqual(1); // 通知列取代原列
      expect(r.noticeHidden).toBe(false); // 原生規則：不隱藏
      expect(r.hiddenCount).toBe(0); // 原生列表無任何列被 hidden
    } catch (err) {
      console.log('\n=== console ===\n' + logs.slice(-30).join('\n'));
      await page.screenshot({ path: 'tests/e2e/__screenshots__/enhance-list-bl-error.png', fullPage: true });
      throw err;
    }
  });

  // 守護 parseListAuthor 的欄位常數（17~28）：看板列表的索引列，作者欄應落在該區間。
  // 若 PTT 改版位移，此測試會先紅，提醒重新校準 src/js/comment_parse.js。
  test('看板列表作者欄位常數仍正確 (cols 17-28)', async ({ shared }) => {
    const { page, logs } = shared;
    logs.length = 0;
    try {
      await resetSession(page); // baseline prefs（無好讀/樓層/黑名單）
      await gotoBoard(page, 'C_Chat');
      await page.waitForTimeout(1000);

      const rows = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#mainContainer > span[type="bbsrow"]')).map(
          (el) => el.innerText
        )
      );
      expect(rows.length).toBeGreaterThan(0);

      // 一般索引列：開頭為（空白/游標標記 >／●）+ 5~6 位編號。對這些列取 cols 17~28
      // 應為合法帳號。新游標 '>' 是半形、不位移欄位；舊 '●' 是全形，會左移一格。
      const indexRows = rows.filter((r) => /^[ >●]?\d{5,6}\s/.test(r));
      const valid = indexRows.filter((r) => /^[0-9A-Za-z]+$/.test(r.substring(17, 29).trim()));
      console.log(`INDEX ROWS: ${indexRows.length}, AUTHOR COL VALID: ${valid.length}`);

      expect(indexRows.length).toBeGreaterThan(0);
      // 容許少數全形字造成位移；多數應命中。
      expect(valid.length).toBeGreaterThanOrEqual(Math.ceil(indexRows.length * 0.7));
    } catch (err) {
      console.log('\n=== console ===\n' + logs.slice(-30).join('\n'));
      throw err;
    }
  });

  // pusher 高亮（點推文者整列高亮）。統一渲染後 togglePusherHighlight 兩模式都走 redraw(true)
  // → computeAnnotations 套 .pusherHighlight（舊好讀走 _applyPusherHighlightDOM，已刪）。
  // 守護：高亮列全屬該推文者、不誤傷他人、forced redraw 不重複 append（列數不變）、再點清除。
  // 直接呼叫 view.togglePusherHighlight（測渲染路徑；mouse_click→closest('[data-pusher]') 接線未改）。
  test('pusher 高亮：點推文者整列高亮、不重複 append、再點清除', async ({ shared }) => {
    test.setTimeout(180000);
    const { page, logs } = shared;
    logs.length = 0;
    // 真推文 id（小寫）。好讀進文章後自動翻頁到底已累積整篇，不按 Space（避免捲到底離開文章）。
    const pushers = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('#mainContainer [data-type="bbsline"]'))
          .map((el) => {
            const m = el.textContent.match(/^(推|噓|→)\d*\s+([0-9A-Za-z]+)\s*:/);
            return m ? m[2].toLowerCase() : null;
          })
          .filter(Boolean)
      );
    const childCount = () =>
      page.evaluate(() => document.querySelectorAll('#mainContainer [data-type="bbsline"]').length);
    const highlighted = () =>
      page.evaluate(() =>
        Array.from(
          document.querySelectorAll('#mainContainer > span[type="bbsrow"].pusherHighlight')
        ).map((el) => el.getAttribute('data-pusher'))
      );

    try {
      await resetSession(page);
      // 關合併：selector 是 #mainContainer 直系子層 bbsrow，合併塊包在 div 內會漏計。
      await applyPrefs(page, {
        enableEasyReading: true,
        showFloorNumbers: true,
        mergeSameAuthorComments: false,
      });
      await gotoBoard(page, 'C_Chat');
      await sendKey(page, 'End');
      await page.waitForTimeout(800);

      let before = [];
      for (let attempt = 0; attempt < 6; attempt++) {
        await sendKey(page, 'Enter');
        await page.waitForTimeout(5000); // 等好讀自動翻頁累積整篇
        before = await pushers();
        if (before.length > 0) break;
        await sendKey(page, 'ArrowLeft');
        await page.waitForTimeout(1300);
        await sendKey(page, 'ArrowUp');
        await page.waitForTimeout(500);
      }
      test.skip(before.length === 0, '找不到有推文的文章，跳過 pusher 高亮驗證');

      const freq = {};
      before.forEach((p) => (freq[p] = (freq[p] || 0) + 1));
      const target = Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0];
      console.log('PUSHER TARGET:', target, 'x', freq[target]);

      const c0 = await childCount();

      // 點選該推文者
      await page.evaluate((t) => window.__app.view.togglePusherHighlight(t), target);
      await page.waitForTimeout(500);
      const hl1 = await highlighted();
      const c1 = await childCount();
      console.log('AFTER HL:', hl1.length, 'rows; childRows', c0, '->', c1);

      // 高亮列至少 1 列、且全屬該推文者（不誤傷他人）
      expect(hl1.length).toBeGreaterThan(0);
      expect(hl1.every((p) => p === target)).toBe(true);
      // forced redraw 不重複 append（findPageOverlap 去重）：列數不變
      expect(c1).toBe(c0);

      // 再點同一人 → 清除，列數仍不變
      await page.evaluate((t) => window.__app.view.togglePusherHighlight(t), target);
      await page.waitForTimeout(500);
      expect((await highlighted()).length).toBe(0);
      expect(await childCount()).toBe(c0);
    } catch (err) {
      console.log('\n=== console ===\n' + logs.slice(-30).join('\n'));
      await page.screenshot({ path: 'tests/e2e/__screenshots__/enhance-pusher-error.png', fullPage: true });
      throw err;
    }
  });

  // 好讀模式按 r 回文：functionMode 應接管，鏡像原生「回應至」選單（舊 bug：選單被好讀
  // footer overlay 蓋住不顯示）。按 q 取消（不真的發文）後應無痕回到好讀長頁。
  // 需真實帳號（guest 多半不能回文）。對應 easy_reading.js functionMode + term_view.redraw。
  test('好讀模式回文選單：functionMode 鏡像原生「回應至」、取消後回長頁', async ({ shared }) => {
    test.skip(!process.env.PTT_USER || !process.env.PTT_PASS, '需 env PTT_USER/PTT_PASS（guest 不能回文）');
    test.setTimeout(180000);
    const { page, logs } = shared;
    logs.length = 0;
    const fnMode = () => page.evaluate(() => window.__app.buf.easyReadingFunctionMode);
    const lastRowDisplay = () =>
      page.evaluate(() => {
        const lr = document.getElementById('easyReadingLastRow');
        return lr ? getComputedStyle(lr).display : 'no-el';
      });
    try {
      await resetSession(page);
      await applyPrefs(page, { enableEasyReading: true });
      await gotoBoard(page, 'C_Chat');

      // 開最新一篇，等好讀自動翻頁累積
      await sendKey(page, 'End');
      await page.waitForTimeout(800);
      await sendKey(page, 'Enter');
      await page.waitForTimeout(5000);
      expect(await page.evaluate(() => window.__app.view.useEasyReadingMode)).toBe(true);
      expect(await fnMode()).toBeFalsy();

      // 按 r → 觸發 PTT 回文選單。functionMode 接管 → #mainContainer 渲染原生 24 列含選單。
      await sendKey(page, 'r');
      // 等「回應至」出現（部分文章不可回覆 → 出現別的提示，此時跳過驗證）
      let replyShown = false;
      for (let i = 0; i < 16; i++) {
        const s = await readScreen(page);
        if (s.includes('回應至') || s.includes('回覆文章')) { replyShown = true; break; }
        if (s.includes('無法回應') || s.includes('未達') || s.includes('不開放')) break;
        await page.waitForTimeout(400);
      }
      console.log('REPLY MENU SHOWN:', replyShown, 'fnMode:', await fnMode());
      test.skip(!replyShown, '此文章不可回覆 / 看板限制，跳過回文選單驗證');

      // 核心斷言：選單真的顯示在當前畫面（舊 bug 是被好讀 footer 蓋住不顯示）+ functionMode 開啟
      expect(await readScreen(page)).toContain('回應至');
      expect(await fnMode()).toBe(true);

      // 取消（不發文）：「回應至…[F]」是 getdata 欄位（需 Enter 送出），typeLine('q') 打 q 再
      // Enter 選「取消」。取消後 PTT 回到文章(pageState 3)→ functionMode 'resume' 回好讀長頁；於
      // 文末取消常被帶回看板列表(pageState 2)→ 'leave'。兩者都是內容判定的合法乾淨退出，核心
      // 保證：functionMode 必須退出、不卡死（舊 bug 的反面：選單不顯示/被 footer 蓋住）。
      await typeLine(page, 'q');
      let exited = false;
      for (let i = 0; i < 16; i++) {
        await page.waitForTimeout(500);
        if (!(await fnMode())) { exited = true; break; }
      }
      const ps = await page.evaluate(() => window.__app.buf.pageState);
      console.log('EXITED:', exited, 'pageState:', ps, 'lastRowDisplay:', await lastRowDisplay());
      expect(exited).toBe(true);            // functionMode 乾淨退出（舊 bug 的反面：選單不顯示/卡死）
      expect(await fnMode()).toBeFalsy();
      if (ps === 3) {
        // 'resume'：回好讀長頁——footer overlay 復現、mainContainer 累積 >24 列。
        expect(await lastRowDisplay()).toBe('block');
        expect(
          await page.evaluate(() => document.getElementById('mainContainer').childNodes.length)
        ).toBeGreaterThan(24);
      } else {
        // 'leave'：退回原生看板列表（footer 隱藏），由既有 settle 機制重新啟動好讀。
        expect(await lastRowDisplay()).toBe('none');
      }
    } catch (err) {
      console.log('\n=== console ===\n' + logs.slice(-30).join('\n'));
      await page.screenshot({ path: 'tests/e2e/__screenshots__/enhance-reply-error.png', fullPage: true });
      throw err;
    }
  });
});

// 自動登入：開頁後完全不按任何鍵，應自動送帳密、跳過提示，進到主選單。
// 本質測登入流程 → 不共用 session，獨立 page + addInitScript（autoLogin 只在 connect 時啟動）。
// 刻意「不」先關掉共用 session：帳號掛著另一條連線時 PTT 會多出「重複登入」提示頁，
// 正好回歸 auto_login 的 one-shot guard（_answeredDup/_answeredErr）——guard 失效時
// 重送的雜鍵會把畫面帶離主選單（實測停在看板列表）。
test('自動登入：開頁自動到主選單（不需按鍵）', async ({ shared, page }) => {
  const user = process.env.PTT_USER;
  const pass = process.env.PTT_PASS;
  // 帳號有開兩階段驗證時一併注入密鑰，否則 auto_login 會（刻意地）停在驗證碼畫面
  // 把鍵盤交還給使用者 —— 那條降級路徑守在 tests/unit/auto_login_2fa.test.js。
  const otpSecret = process.env.PTT_OTP_SECRET || '';
  test.skip(!user || !pass, '需 env PTT_USER/PTT_PASS 才能測自動登入');
  test.setTimeout(120000);
  const logs = attachConsole(page);
  void shared; // 引用 fixture 讓共用連線保持存活（製造重複登入情境）
  try {
    await page.addInitScript((args) => {
      try {
        const cur = JSON.parse(window.localStorage.getItem(args.KEY) || '{}');
        const values = Object.assign({}, cur.values, args.extra);
        window.localStorage.setItem(args.KEY, JSON.stringify({ values }));
      } catch (e) {}
    }, {
      KEY,
      extra: {
        autoLogin: true,
        autoLoginUser: user,
        autoLoginPassword: pass,
        autoLoginOtpSecret: otpSecret,
        autoLoginDupConn: 'N',
        autoLoginSkipWelcome: true
      }
    });
    await page.goto('/');
    // dev build 仍需關掉 Developer Mode modal，app 才會 connect（autoLogin 在 connect 後啟動）。
    await dismissDeveloperModeAlert(page);

    // 關鍵：完全不呼叫 typeLine/sendKey，純等自動登入。
    const deadline = Date.now() + 90000;
    let screen = '';
    while (Date.now() < deadline) {
      screen = await readScreen(page);
      if (screen.includes('主功能表')) break;
      await page.waitForTimeout(1000);
    }
    console.log('AUTO LOGIN SCREEN HEAD:', screen.split('\n')[0]);
    expect(screen).toContain('主功能表');
  } catch (err) {
    console.log('\n=== console ===\n' + logs.slice(-30).join('\n'));
    await page.screenshot({ path: 'tests/e2e/__screenshots__/enhance-autologin-error.png', fullPage: true });
    throw err;
  }
});
