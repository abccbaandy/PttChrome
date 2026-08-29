const { test, expect } = require('./helpers/fixtures');
const {
  readScreen,
  sendKey,
  typeLine,
  applyPrefs,
  resetSession,
  gotoBoard,
  pickListArticleWithComments,
  openArticleByNumber,
  waitEasyReadingComplete,
  comparePusherSequences,
  inspectFloorGaps,
} = require('./helpers/ptt');

// Enhanced Add-on：樓層編號 + 黑名單。連真 PTT，需好讀模式。
// 對應 src/js/comment_parse.js / Screen.js / term_view.js(appendRows)。
// 全部走共用登入 session（helpers/fixtures.js）——**整輪只登入一次**，連「自動登入」
// 那條也是斷言那一次開機的結果，不再自己開站。

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

      // 選文＝**先看列表上的推文數再跳號開文**，不用 End→Enter（2026-08-29 失敗根因）：
      // End 走 read.c 的 last_line，包含置底文 —— 開到的是十幾頁的置底公告，累積跑不完
      // （60s test timeout），而且公告常常零推文，本測的斷言必紅。推文數列表上就看得到
      // （pttbbs bbs.c#readdoent），所以「有推文且不是爆文」開文前就能保證。
      const target = await pickListArticleWithComments(page, { min: 8, max: 99 });
      console.log('TARGET ARTICLE:', JSON.stringify(target));
      test.skip(!target, '列表上找不到推文數 8~99 的文章（板況異常）');
      await openArticleByNumber(page, target.num);

      // 等好讀自動翻頁把整篇累積完（到底才取樣，見 waitEasyReadingComplete；
      // 舊版靠固定 4 次 Space + 固定 timeout，長文會停在推文區之前）
      const acc = await waitEasyReadingComplete(page);
      console.log('ACCUMULATE:', JSON.stringify(acc));
      // 沒讀到底就別再往下斷言：floors 只會是「累積到一半」的片段，紅在後面的
      // 遞增檢查上完全看不出真正的原因。
      expect(acc.reachedEnd).toBe(true);

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
  // 在同一篇文章上驗證：讀取 → 封鎖某推文者 → 離開再進入重新累積 → 該人推文消失、
  // 其他人的推文原封不動、被移除的樓號整個不見（不是留一列空行）。
  //
  // 【禁止跨兩次讀取比列數】C_Chat 這種熱門板的推文會在兩次累積之間一直長，新增的列數
  // 可以蓋過黑名單移除的列數 ⇒ 舊寫法的 `c2 < c1` 與
  // `before.length - after.length >= targetCount` 會偽紅（實例：黑名單確實生效、目標作者
  // 完全消失、pusher 由 32 降到 13，卻量到 c2=412 > c1=289，重跑才綠）。
  // 判定一律走內容比對：推文者序列前綴（comparePusherSequences）＋樓號集合
  // （被封鎖者的樓號必須整個消失，樓號是絕對編號、不會因為新推文而位移）。
  // 兩者都對「第二次多出新推文」免疫。純函式守護：tests/unit/blacklist_pusher_diff.test.js。
  test('黑名單：好讀模式移除推文且不留空行', async ({ shared }) => {
    test.setTimeout(180000); // 找有推文的文章 + 兩階段累積，需較長時間
    const { page, logs } = shared;
    logs.length = 0;
    // 依畫面順序取結構化列陣列。pusher 讀 data-pusher 屬性而非用正則剖 textContent：
    // 樓號徽章數字會混進 textContent（見 offline/comment_merge.offline.spec.js 檔頭），
    // 且 data-pusher 已由 annotateComment 轉小寫，與黑名單 key 同基準。
    const readRows = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('#mainContainer span[type="bbsrow"]')).map((el) => {
          const badge = el.querySelector('[data-floor]');
          return {
            pusher: el.getAttribute('data-pusher'),
            floor: badge ? parseInt(badge.textContent, 10) : null,
            blank: el.textContent.trim() === '',
          };
        })
      );
    const pushersOf = (rows) => rows.map((r) => r.pusher).filter(Boolean);

    try {
      await resetSession(page);
      // 關合併：本測按逐列 pusher 序列與樓號缺口斷言（合併行為另測）。
      await applyPrefs(page, {
        enableEasyReading: true,
        showFloorNumbers: true,
        mergeSameAuthorComments: false,
      });
      await gotoBoard(page, 'C_Chat');

      // 用與樓層測試相同的成功導航（End→Enter）；若該篇無推文，回列表往上一篇再試。
      // 取樣點＝「整篇累積完畢」(waitEasyReadingComplete)，不是「翻 N 次 Space 之後」——
      // 前後兩階段要停在同一個可重現的終點，內容前綴才對得起來。
      await sendKey(page, 'End');
      await page.waitForTimeout(800);
      let beforeRows = [];
      let before = [];
      for (let attempt = 0; attempt < 6; attempt++) {
        await sendKey(page, 'Enter');
        const acc = await waitEasyReadingComplete(page);
        console.log('ACCUMULATE BEFORE:', JSON.stringify(acc));
        beforeRows = await readRows();
        before = pushersOf(beforeRows);
        if (before.length > 0 && acc.reachedEnd) break;
        // 無推文（或沒讀到底）→ 離開回列表、往上一篇（較舊）再試
        await sendKey(page, 'ArrowLeft');
        await page.waitForTimeout(1300);
        await sendKey(page, 'ArrowUp');
        await page.waitForTimeout(500);
        before = [];
      }
      console.log('PUSHERS BEFORE:', before.length);
      test.skip(before.length === 0, '找不到有推文且能讀到底的文章，跳過黑名單驗證');

      // 選出現次數最多的推文者
      const freq = {};
      before.forEach((p) => (freq[p] = (freq[p] || 0) + 1));
      const target = Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0];
      // 該作者推文所在的樓號（絕對編號）：封鎖後這些樓號必須整個從畫面消失。
      const removedFloors = beforeRows
        .filter((r) => r.pusher === target && r.floor != null && !Number.isNaN(r.floor))
        .map((r) => r.floor);
      console.log('BLACKLIST TARGET:', target, 'x', freq[target], 'floors', JSON.stringify(removedFloors));

      // 設黑名單到 view（appendRows 讀 this.blacklist）
      await page.evaluate((t) => {
        window.__app.view.blacklist = new Set([t.toLowerCase()]);
      }, target);

      // 離開回列表（游標仍停在本篇）→ 再進入，好讀重新累積套用黑名單。
      await sendKey(page, 'ArrowLeft');
      await page.waitForTimeout(1500);
      await sendKey(page, 'Enter');
      const acc2 = await waitEasyReadingComplete(page);
      console.log('ACCUMULATE AFTER:', JSON.stringify(acc2));
      expect(acc2.reachedEnd).toBe(true);

      const afterRows = await readRows();
      const after = pushersOf(afterRows);
      console.log('PUSHERS AFTER:', after.length);

      // (1) 內容比對：target 的推文全消失，其他人的推文原封不動、順序不變。
      //     after 尾端多出來的是這段期間的新推文，允許存在（cmp.appended）。
      const cmp = comparePusherSequences(before, after, target);
      console.log(
        'BLACKLIST DIFF:',
        JSON.stringify({
          targetInBefore: cmp.targetInBefore,
          targetInAfter: cmp.targetInAfter,
          expectedPrefix: cmp.expectedPrefix.length,
          appendedDuringTest: cmp.appended.length,
          firstMismatch: cmp.firstMismatch,
        })
      );
      expect(cmp.targetInBefore).toBeGreaterThan(0);
      expect(cmp.targetInAfter).toBe(0);
      expect(cmp.firstMismatch).toBe(null);
      expect(cmp.prefixMatches).toBe(true);

      // (2) 真的被移除（取代舊的 c2 < c1）：被封鎖者原本占的樓號整個不見。
      //     樓號是絕對編號，新推文只會往後拿更大的號碼，不會位移既有樓號。
      const gapInfo = inspectFloorGaps(afterRows);
      const afterFloors = new Set(afterRows.map((r) => r.floor).filter((f) => f != null));
      console.log('FLOOR GAPS:', JSON.stringify(gapInfo.gaps.slice(0, 10)), 'total', gapInfo.gaps.length);
      expect(removedFloors.length).toBeGreaterThan(0);
      expect(removedFloors.filter((f) => afterFloors.has(f))).toEqual([]);

      // (3) 不留空行：移除處只留樓號缺口，缺口區間內不得出現空白列。
      //     樓層徽章仍須嚴格遞增（絕對編號，缺號允許、重複／倒退不允許）。
      expect(gapInfo.blankInGaps).toEqual([]);
      expect(gapInfo.strictlyIncreasing).toBe(true);
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

  // pusher 高亮（點推文者整列高亮）。togglePusherHighlight 兩模式都走
  // componentScreen.setSelectedPusher → renderer 逐列搬 .pusherHighlight class，**不重畫**
  // （2026-08；在那之前是 redraw(true)，症狀見 docs/enhanced-addon.md「點選推文者高亮」踩坑）。
  // 守護：高亮列全屬該推文者、不誤傷他人、列數不變（現在等於「沒有人把 redraw 加回來」）、再點清除。
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
//
// **不自己開站**：整輪 live e2e 只登入一次，而那一次就是共用 session 的開機 ——
// helpers/fixtures.js 用 autoLoginBoot（注入 autoLogin prefs → 開站 → 完全不按鍵
// 等主功能表）建立它，也就是說被測行為早就在 fixture 裡跑過了，這裡斷言它留下的
// 證據即可。自己再開一個 page 只會讓整輪多一次登入，而登入次數正是 PTT DDoS/BOT
// 防護的觸發條件（見 tests/e2e/README.md）。
//
// 換掉的覆蓋度（刻意）：以前靠「共用 session 還掛著時再開一條」製造「重複登入」提示，
// 回歸 auto_login 的 one-shot guard；整輪只剩一條連線後製造不出來，那個 guard 由
// tests/unit/auto_login_2fa.test.js 與 auto_login_logic.test.js 守。
test('自動登入：開頁自動到主選單（不需按鍵）', async ({ shared }) => {
  test.skip(
    !process.env.PTT_USER || !process.env.PTT_PASS,
    '需 env PTT_USER/PTT_PASS 才能測自動登入（無帳密時共用 session 走 guest 手動登入）'
  );
  const { boot } = shared;
  console.log('AUTO LOGIN SCREEN HEAD:', boot.screen.split('\n')[0]);
  console.log('AUTO LOGIN WAITED:', boot.waitedMs, 'ms retries=', boot.retries);
  // auto:false ＝ fixture 退回了 guest 手動登入 ⇒ 這條的前提根本沒成立，要紅。
  expect(boot.auto).toBe(true);
  expect(boot.screen).toContain('主功能表');
});
