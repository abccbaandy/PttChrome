const { test, expect } = require('./helpers/fixtures');
const {
  readScreen,
  sendKey,
  typeLine,
  applyPrefs,
  resetSession,
  gotoBoard,
} = require('./helpers/ptt');

// 共用登入 session（helpers/fixtures.js 的 shared fixture）：整包只登入一次。
// serial：共用 page 有順序相依，每個 case 開頭 resetSession 自我復位。
test.describe.serial('好讀模式', () => {
  // REGRESSION: 好讀模式「第一則推文消失」。跨頁去重改成純內容比對(comment_parse.findPageOverlap)後,
  // 第一則(常為箭頭)推文不再被當重疊跳掉。樣本 Stock #1g8znzQ3:第一則 → BlueBird5566 曾整列消失、
  // 後續樓號少 1。文章會過期 → 找不到就 skip(非失敗)。修法前此測試會因 BlueBird5566 缺席而紅。
  test('好讀模式第一則推文不消失 (Stock #1g8znzQ3)', async ({ shared }) => {
    test.setTimeout(150000);
    const { page, logs } = shared;
    logs.length = 0;
    try {
      await resetSession(page);
      await applyPrefs(page, { enableEasyReading: true, showFloorNumbers: true });

      await gotoBoard(page, 'Stock');

      // '/' 標題搜尋 → 跳到該篇。找不到(已過期)就 skip。
      await sendKey(page, 'Slash');
      await page.waitForTimeout(800);
      await typeLine(page, '黃仁勳喊話增產成功');
      await page.waitForTimeout(1500);
      const listScreen = await readScreen(page);
      test.skip(!listScreen.includes('黃仁勳喊話增產成功'), '樣本文章已過期，跳過');

      // 開啟並等好讀累積整篇(多翻幾頁)
      await sendKey(page, 'Enter');
      await page.waitForTimeout(4000);
      for (let i = 0; i < 8; i++) {
        await sendKey(page, 'Space');
        await page.waitForTimeout(1000);
      }

      const rows = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#mainContainer [data-type="bbsline"]')).map(
          (el) => el.textContent
        )
      );
      const comments = rows.filter((t) => /^(推|噓|→)\d*\s+[0-9A-Za-z]+\s*:/.test(t));
      console.log('TOTAL ROWS', rows.length, 'COMMENTS', comments.length);
      console.log('FIRST COMMENTS:', JSON.stringify(comments.slice(0, 4)));

      // 核心斷言:被吃掉的第一則推文必須重現。
      const hasBlueBird = rows.some((t) => t.includes('BlueBird5566'));
      expect(hasBlueBird).toBe(true);

      // 第一則推文應為第 1 樓(樓號不再因吃列而錯位)。
      expect(comments[0]).toMatch(/^(推|噓|→)1\s/);

      // 跨頁去重不可造成「整列重複」:相鄰非空白列不應完全相同。
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1].replace(/\s+$/, '');
        const b = rows[i].replace(/\s+$/, '');
        if (a.trim() !== '') expect(b).not.toBe(a);
      }
    } catch (err) {
      console.log('\n=== console ===\n' + logs.slice(-30).join('\n'));
      await page.screenshot({ path: 'tests/e2e/__screenshots__/er-missing-comment-error.png', fullPage: true });
      throw err;
    }
  });

  // 驗證好讀模式按 End：暫時切回原生、跳到文章最底、不卡住，且原生搜尋可用；
  // 按左鍵離開後，進下一篇自動恢復好讀模式。
  // 對應 src/js/easy_reading.js 的 switchToNativeAtBottom。
  test('好讀模式 End 切回原生跳到底', async ({ shared }) => {
    const { page, logs } = shared;
    logs.length = 0;
    const dumpLogs = (tag) => {
      console.log(`\n===== console (${tag}) =====\n${logs.slice(-40).join('\n')}\n====================\n`);
    };

    // app 內部狀態（main.js 在 DEVELOPER_MODE 下 window.__app = app）
    const appState = () => page.evaluate(() => {
      const a = window.__app;
      const lr = document.getElementById('easyReadingLastRow');
      const mc = document.getElementById('mainContainer');
      return {
        useEasyReadingMode: a.view.useEasyReadingMode,
        pageState: a.buf.pageState,
        lastRowDisplay: lr ? getComputedStyle(lr).display : 'no-el',
        mcChildren: mc ? mc.childNodes.length : -1,
      };
    });
    const waitPageState = async (want, ms = 12000) => {
      const dl = Date.now() + ms;
      while (Date.now() < dl) {
        if ((await page.evaluate(() => window.__app.buf.pageState)) === want) return true;
        await page.waitForTimeout(300);
      }
      return false;
    };

    try {
      await resetSession(page);
      await applyPrefs(page, { enableEasyReading: true });

      await gotoBoard(page, 'C_Chat');

      // 到最新一篇並開啟，等好讀模式自動翻頁
      await sendKey(page, 'End');
      await page.waitForTimeout(1000);
      await sendKey(page, 'Enter');
      await page.waitForTimeout(4000);

      const before = await appState();
      console.log('STATE BEFORE END:', JSON.stringify(before));
      expect(before.useEasyReadingMode).toBe(true); // 確認好讀模式真的啟動

      // 關鍵動作：按 End
      logs.length = 0;
      await sendKey(page, 'End');
      await page.waitForTimeout(3000);
      await page.screenshot({ path: 'tests/e2e/__screenshots__/er-after-end.png', fullPage: true });

      const after = await appState();
      const afterScreen = await readScreen(page);
      console.log('STATE AFTER END:', JSON.stringify(after));
      dumpLogs('after End');

      // 切回原生：單頁原生 DOM（非好讀累積），好讀自訂列隱藏，畫面在文章最底
      expect(after.useEasyReadingMode).toBe(false);
      expect(after.mcChildren).toBeLessThanOrEqual(24);
      expect(after.lastRowDisplay).toBe('none');
      expect(afterScreen).toContain('說明'); // 原生狀態列
      expect(afterScreen).toContain('100%'); // 在最底

      // 原生搜尋可用：'/' 跳出搜尋提示（好讀模式會攔截 '/'）
      await sendKey(page, 'Slash');
      await page.waitForTimeout(1200);
      const searchScreen = await readScreen(page);
      console.log('SEARCH SCREEN:', searchScreen.split('\n')[0]);
      expect(searchScreen).toMatch(/搜尋|搜索|請輸入|關鍵/);
      await typeLine(page, ''); // 空 Enter 取消搜尋（避免用 Escape，pmore 會當逃逸序列）
      await page.waitForTimeout(1000);

      // 左鍵離開文章 → 回看板列表
      await sendKey(page, 'ArrowLeft');
      expect(await waitPageState(2)).toBe(true);

      // 進下一篇 → 好讀模式自動恢復
      await sendKey(page, 'Enter');
      await waitPageState(3);
      await page.waitForTimeout(2500);
      const reentry = await appState();
      console.log('STATE RE-ENTRY:', JSON.stringify(reentry));
      expect(reentry.useEasyReadingMode).toBe(true);
    } catch (err) {
      dumpLogs('error');
      await page.screenshot({ path: 'tests/e2e/__screenshots__/er-error.png', fullPage: true });
      throw err;
    }
  });

  // 自動行內開圖（inline image preview）。好讀文章走 <Screen enableLinkInlinePreview=true>
  // → Row → LinkSegmentBuilder 在每個連結旁掛 <ImagePreviewer Inline>。統一渲染時曾把
  // 此旗標寫死 false → 圖片全不顯示（regression）。守護：找到「可預覽連結」的文章後，
  // 行內預覽節點必須出現；找不到可預覽連結（內容相依）才 skip。
  test('好讀模式自動行內開圖', async ({ shared }) => {
    test.setTimeout(180000);
    const { page, logs } = shared;
    logs.length = 0;
    // 行內預覽渲染出的媒體節點（見 ImagePreviewer.Inline）：圖片 / 影片 / iframe。
    const PREVIEW_SEL =
      '#mainContainer img.hyperLinkPreview, #mainContainer video.easyReadingVideo, #mainContainer iframe';
    // 會被 ImagePreviewer 解析成非錯誤描述子的連結（imgur/twitter/youtube/直連圖影）。
    const previewableLinks = () =>
      page.evaluate(() => {
        const re = /(\.(?:jpe?g|png|gif|webp|bmp|apng|avif|mp4|webm|ogg)(?:$|[?#]))|imgur\.com|pbs\.twimg\.com|youtu\.?be|youtube\.com|meee\.com\.tw|clips\.twitch\.tv|flic\.kr|flickr\.com/i;
        return Array.from(document.querySelectorAll('#mainContainer a[href]'))
          .map((a) => a.getAttribute('href'))
          .filter((h) => re.test(h));
      });

    try {
      await resetSession(page);
      await applyPrefs(page, { enableEasyReading: true });
      await gotoBoard(page, 'C_Chat');
      await sendKey(page, 'End');
      await page.waitForTimeout(800);

      let found = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        await sendKey(page, 'Enter');
        await page.waitForTimeout(4500); // 好讀自動翻頁累積整篇 + 連結解析
        const inER = await page.evaluate(
          () => window.__app.view.useEasyReadingMode && window.__app.buf.pageState === 3
        );
        if (inER) {
          const links = await previewableLinks();
          console.log(`attempt ${attempt}: previewable links = ${links.length}`, JSON.stringify(links.slice(0, 3)));
          if (links.length > 0) {
            // 有可預覽連結 → 行內預覽節點必須出現（壞掉就會 timeout → 測試紅）。
            await page.waitForSelector(PREVIEW_SEL, { timeout: 10000 });
            const previews = await page.evaluate((sel) => document.querySelectorAll(sel).length, PREVIEW_SEL);
            console.log('PREVIEW NODES:', previews);
            expect(previews).toBeGreaterThan(0);
            found = true;
            break;
          }
        }
        // 本篇無可預覽連結 → 回列表往上一篇（較舊）再試
        await sendKey(page, 'ArrowLeft');
        await page.waitForTimeout(1300);
        await sendKey(page, 'ArrowUp');
        await page.waitForTimeout(500);
      }
      test.skip(!found, '連續多篇都沒有可預覽的圖片連結，跳過（內容相依）');
      expect(found).toBe(true);
    } catch (err) {
      console.log('\n=== console ===\n' + logs.slice(-30).join('\n'));
      await page.screenshot({ path: 'tests/e2e/__screenshots__/er-image-preview-error.png', fullPage: true });
      throw err;
    }
  });
});
