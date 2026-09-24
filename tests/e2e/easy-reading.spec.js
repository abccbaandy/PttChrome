const { test, expect } = require('./helpers/fixtures');
const {
  readScreen,
  sendKey,
  typeLine,
  applyPrefs,
  resetSession,
  gotoBoard,
  getPref,
  readListCandidates,
  pickListArticleWithComments,
  openArticleByNumber,
  waitEasyReadingComplete,
} = require('./helpers/ptt');
const { seekMountedPreview } = require('./helpers/layout');

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
      // mergeSameAuthorComments:false —— 本測按逐列推文樓號斷言；
      // 合併（預設開）的行為守護在 offline comment_merge spec。
      await applyPrefs(page, {
        enableEasyReading: true,
        showFloorNumbers: true,
        mergeSameAuthorComments: false,
      });

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
  test('好讀模式 切回原生熱鍵跳到底', async ({ shared }) => {
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

      // 關鍵動作：按切回原生熱鍵（值取自 pref easyReadingEndSwitchKey，不 hardcode）
      logs.length = 0;
      const switchKey = await getPref(page, 'easyReadingEndSwitchKey');
      await sendKey(page, switchKey);
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
      // 切回原生後 #mainContainer 是原生 24 列，含原生狀態列「瀏覽 第 N 頁 … 目前顯示:
      // 第 a~b 行」。好讀 footer overlay 雖也鏡像狀態列，但它是 BBSWin 下獨立 div、非
      // #mainContainer，故 readScreen(#mainContainer) 在好讀時不含狀態列、原生時才含。
      expect(afterScreen).toMatch(/瀏覽 第 .+頁/);
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
    test.setTimeout(240000);
    const { page, logs } = shared;
    logs.length = 0;
    // 行內預覽渲染出的媒體節點（見 ImagePreviewer.Inline）：圖片 / 影片 / iframe。
    const PREVIEW_SEL =
      '#mainContainer img.hyperLinkPreview, #mainContainer video.easyReadingVideo, #mainContainer iframe';
    // 會被 ImagePreviewer 解析成非錯誤描述子的連結（imgur/twitter/youtube/直連圖影）。
    const PREVIEWABLE =
      /(\.(?:jpe?g|png|gif|webp|bmp|apng|avif|mp4|webm|ogg)(?:$|[?#]))|imgur\.com|pbs\.twimg\.com|youtu\.?be|youtube\.com|meee\.com\.tw|clips\.twitch\.tv|flic\.kr|flickr\.com/i;
    const previewableLinks = () =>
      page.evaluate((pattern) => {
        const re = new RegExp(pattern, 'i');
        return Array.from(document.querySelectorAll('#mainContainer a[href]'))
          .map((a) => a.getAttribute('href'))
          .filter((h) => re.test(h));
      }, PREVIEWABLE.source);

    try {
      await resetSession(page);
      await applyPrefs(page, { enableEasyReading: true });
      await gotoBoard(page, 'C_Chat');

      // 選文：從列表挑序號候選（由新到舊），跳號開文。
      // **不用 End → Enter**：End ＝ read.c 的 last_line，含置底公告（C_Chat 的置底
      // 是十幾頁），累積跑很久且常常一張圖都沒有。置底文沒有序號 ⇒ 候選天然排除。
      const candidates = (await readListCandidates(page, { min: 0, max: 99 }))
        .slice()
        .reverse()
        .slice(0, 4);
      console.log('CANDIDATES:', JSON.stringify(candidates));
      expect(candidates.length).toBeGreaterThan(0);

      let found = false;
      let lastSeek = null;
      for (const cand of candidates) {
        await openArticleByNumber(page, cand.num);
        // 等的是「整篇累積完」這個唯一可重現的終點，不是固定 waitForTimeout。
        // 以前睡 4.5 秒就開始掃：長文那時還在自動翻頁（easy_reading 同時在控 scrollTop）
        // ⇒ 佔位盒從沒進過視野，掃完整篇 0 個預覽節點（2026-08-29 的間歇性紅）。
        const acc = await waitEasyReadingComplete(page, { timeout: 30000 });
        const inER = await page.evaluate(
          () => window.__app.view.useEasyReadingMode && window.__app.buf.pageState === 3
        );
        console.log(`article ${cand.num}: rows=${acc.rows} end=${acc.reachedEnd} ER=${inER}`);
        if (!inER || !acc.reachedEnd) {
          // 累積不完（超長公告／爆文）⇒ 這篇不合用，換下一篇。不是產品問題，
          // 所以不在這裡斷言 reachedEnd。
          await sendKey(page, 'ArrowLeft');
          await page.waitForTimeout(1200);
          continue;
        }

        const links = await previewableLinks();
        console.log(`article ${cand.num}: previewable links = ${links.length}`, JSON.stringify(links.slice(0, 3)));
        if (links.length === 0) {
          await sendKey(page, 'ArrowLeft');
          await page.waitForTimeout(1200);
          continue;
        }

        // ---- Layer 1（必驗，與外網無關）：有連結就必須有佔位盒 ----
        // enableLinkInlinePreview 為 false 時 render/link_segment.js 連一個
        // .inlinePreviewSlot 都不會建 —— 這正是本測要守的 regression（統一渲染時
        // 把旗標寫死 false ⇒ 圖片全不顯示）最直接、且完全不碰網路的訊號。
        const slots = await page.evaluate(
          () => document.querySelectorAll('#mainContainer .inlinePreviewSlot').length
        );
        console.log('INLINE PREVIEW SLOTS:', slots);
        expect(slots).toBeGreaterThan(0);

        // ---- Layer 2（必驗，與外網無關）：捲到佔位盒 → 延遲載入鏈真的 mount ----
        // mounted ＝ slot 裡出現預覽產物（媒體節點或讀取中指示器），證明
        // IntersectionObserver → ImagePreviewer 這條鏈通了，不需要圖片下載成功。
        const seek = await seekMountedPreview(page, { hrefFilter: PREVIEWABLE });
        lastSeek = seek;
        console.log('SEEK:', JSON.stringify(seek));
        expect(seek.slots).toBeGreaterThan(0);
        expect(seek.mounted).toBe(true);

        // ---- Layer 3（機會性）：媒體節點／真的載到圖 ----
        // 到這裡才會碰到外網。圖床 stall／404 時產品端沒有 timeout（刻意），
        // 所以這一層載不出來不算產品壞掉 —— 記錄後跳過，不讓圖床決定 CI 顏色。
        if (seek.mediaFound) {
          const previews = await page.evaluate((sel) => document.querySelectorAll(sel).length, PREVIEW_SEL);
          console.log('PREVIEW NODES:', previews);
          expect(previews).toBeGreaterThan(0);
        }

        // 點圖放大全部圖片至視窗寬度（再點縮回）。僅在本篇實際有已載入的內嵌圖片
        // 時驗（youtube/影片等 iframe-only 文章無 img，跳過此段，內容相依）。
        if (seek.loadedImage) {
          // React 19：click 觸發的 setState 在事件 task 之後才 commit——
          // 點完同步讀 classList 恆 false（假紅）。等一拍再讀。
          const enlarged = await page.evaluate(async () => {
            const im = Array.from(
              document.querySelectorAll('#mainContainer img.hyperLinkPreview')
            ).find((x) => x.offsetWidth > 0);
            const before = im.getBoundingClientRect().width;
            im.click();
            await new Promise((r) => setTimeout(r, 300));
            const mc = document.getElementById('mainContainer');
            const after = im.getBoundingClientRect().width;
            return {
              cls: mc.classList.contains('imagesEnlarged'),
              before,
              after,
            };
          });
          console.log('ENLARGE:', JSON.stringify(enlarged));
          expect(enlarged.cls).toBe(true);
          expect(enlarged.after).toBeGreaterThanOrEqual(enlarged.before);
          // 再點一次 → 縮回（class 移除）。同上，等 commit 後再讀。
          const collapsed = await page.evaluate(async () => {
            const im = Array.from(
              document.querySelectorAll('#mainContainer img.hyperLinkPreview')
            ).find((x) => x.offsetWidth > 0);
            im.click();
            await new Promise((r) => setTimeout(r, 300));
            return document.getElementById('mainContainer').classList.contains('imagesEnlarged');
          });
          expect(collapsed).toBe(false);
        } else {
          console.log('IMAGE NOT LOADED（圖床端因素，Layer 3 略過）:', JSON.stringify(seek.tried));
        }

        found = true;
        break;
      }
      test.skip(
        !found,
        `候選文章都不合用（沒有可預覽連結或累積不完）${lastSeek ? ' seek=' + JSON.stringify(lastSeek) : ''}`
      );
      expect(found).toBe(true);
    } catch (err) {
      console.log('\n=== console ===\n' + logs.slice(-30).join('\n'));
      await page.screenshot({ path: 'tests/e2e/__screenshots__/er-image-preview-error.png', fullPage: true });
      throw err;
    }
  });

  // REGRESSION: 好讀模式按 h（pmore 說明）無反應。default 分支有 upstream 遺留的吞鍵清單
  // "123456789hops;,./\H#OP:<>" 把 h/說明、o/選項、/搜尋… 全 preventDefault 成 no-op。
  // 移除後這些鍵改走 functionMode（鏡像原生），h 應顯示 pmore 說明畫面。guest 即可。
  test('好讀模式按 h 顯示說明（functionMode 鏡像原生）、空白鍵離開回長頁', async ({ shared }) => {
    test.setTimeout(150000);
    const { page, logs } = shared;
    logs.length = 0;
    const fnMode = () => page.evaluate(() => window.__app.buf.easyReadingFunctionMode);
    try {
      await resetSession(page);
      await applyPrefs(page, { enableEasyReading: true });
      await gotoBoard(page, 'C_Chat');

      // 開最新一篇，等好讀自動翻頁累積
      await sendKey(page, 'End');
      await page.waitForTimeout(800);
      await sendKey(page, 'Enter');
      await page.waitForTimeout(4500);
      expect(await page.evaluate(() => window.__app.view.useEasyReadingMode)).toBe(true);
      expect(await fnMode()).toBeFalsy();

      // 按 h → functionMode 接管，鏡像原生 pmore 說明畫面（舊 bug：被吞掉完全沒反應）
      await sendKey(page, 'h');
      let helpShown = false;
      for (let i = 0; i < 12; i++) {
        const s = await readScreen(page);
        if (/說明|瀏覽程式|空白鍵/.test(s)) { helpShown = true; break; }
        await page.waitForTimeout(400);
      }
      console.log('HELP SHOWN:', helpShown, 'fnMode:', await fnMode());
      // 核心斷言：說明畫面真的顯示 + functionMode 開啟（舊 bug 的反面：h 沒反應）
      expect(helpShown).toBe(true);
      expect(await fnMode()).toBe(true);
      expect(await readScreen(page)).toMatch(/說明|瀏覽程式|空白鍵/);

      // 空白鍵離開說明 → 回乾淨文章頁 → functionMode 'resume' 回好讀長頁
      await sendKey(page, 'Space');
      let exited = false;
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(500);
        if (!(await fnMode())) { exited = true; break; }
      }
      const ps = await page.evaluate(() => window.__app.buf.pageState);
      console.log('EXITED:', exited, 'pageState:', ps);
      expect(exited).toBe(true);
      expect(await fnMode()).toBeFalsy();
      if (ps === 3) {
        // 'resume'：回好讀長頁——footer overlay 復現、mainContainer 累積 >24 列。
        expect(
          await page.evaluate(() => {
            const lr = document.getElementById('easyReadingLastRow');
            return lr ? getComputedStyle(lr).display : 'no-el';
          })
        ).toBe('block');
        expect(await page.evaluate(() => window.__app.view.useEasyReadingMode)).toBe(true);
      }
    } catch (err) {
      console.log('\n=== console ===\n' + logs.slice(-30).join('\n'));
      await page.screenshot({ path: 'tests/e2e/__screenshots__/er-help-error.png', fullPage: true });
      throw err;
    }
  });
  // seekBack（:N 指定行往回跳）＋ pref easyReadingBrowserFind。
  // 往回跳的舊症狀：_accEndRow 倒退 ⇒ 自動翻頁把已累積的內容重複接到長頁尾巴、畫面被捲走。
  // 修後：累積頁一列不變、捲到跳轉目的地、PTT 指標一次 realign 回尾端。
  // 同一篇順便驗 `/` 改成提示（不送 PTT、不進 functionMode）與 Ctrl+F 不送 ^F。
  // 純邏輯守護：tests/unit/easy_reading_seek_back.test.js、easy_reading_browser_find.test.js。
  test('好讀模式 :N 往回跳不重複累積；/ 提示改用瀏覽器搜尋', async ({ shared }) => {
    test.setTimeout(180000);
    const { page, logs } = shared;
    logs.length = 0;
    const rowTexts = () => page.evaluate(() =>
      window.__app.buf.pageLines.map((r) => r.map((c) => c.ch).join('').replace(/\s+$/, ''))
    );
    try {
      await resetSession(page);
      await applyPrefs(page, { enableEasyReading: true, easyReadingBrowserFind: true });
      await gotoBoard(page, 'C_Chat');

      // 需要 `:5` 落地頁（第 5~27 行）整頁都在已累積範圍內 ⇒ 文章至少兩頁多。推文數多
      // 的通常夠長（開文前就能從列表挑，見 pickListArticleWithComments）；不夠長就退回
      // 列表往舊翻一頁再挑。
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; ++attempt) {
        const cand = await pickListArticleWithComments(page, { min: 20, max: 99, pages: 4 });
        if (!cand) break;
        await openArticleByNumber(page, cand.num);
        const acc = await waitEasyReadingComplete(page, { timeout: 40000 });
        const n = await page.evaluate(() => window.__app.buf.pageLines.length);
        console.log(`article ${cand.num} (push ${cand.push}): rows=${acc.rows} end=${acc.reachedEnd} pageLines=${n}`);
        if (acc.reachedEnd && n >= 50) { ok = true; break; }
        await sendKey(page, 'ArrowLeft');
        await page.waitForFunction(() => window.__app.buf.pageState === 2, null, { timeout: 10000 });
        await sendKey(page, 'PageUp');
        await page.waitForTimeout(800);
      }
      test.skip(!ok, '找不到夠長且累積得完的文章');

      const before = await rowTexts();
      const accEnd = await page.evaluate(() => window.__app.view._accEndRow);

      // ---- `/`：提示、不送 PTT、不進 functionMode ----
      const bottomRow = () => page.evaluate(() => {
        const b = window.__app.buf;
        return b.getRowText(b.rows - 1, 0, b.cols);
      });
      await sendKey(page, 'Slash');
      await expect(page.locator('.ListHint')).toContainText(/Ctrl\+F|⌘F/);
      await page.waitForTimeout(1200); // 若 '/' 真的送出，PTT 這段時間內就會畫出搜尋 prompt
      expect(await page.evaluate(() => window.__app.easyReading._functionMode)).toBe(false);
      expect(await bottomRow()).toContain('目前顯示'); // 仍是狀態列，不是「搜尋文字:」

      // ---- Ctrl+F：不送 ^F（pmore 的 ^F 會移頁指標 ⇒ 狀態列行號會變） ----
      const sigBefore = await page.evaluate(() => window.__app.easyReading._currentPageSignature());
      // 不按 Escape 收尋找列：headless 沒有 UI，而好讀下 Escape 會以 ESC 位元組送進 pmore。
      await sendKey(page, 'Control+f');
      await page.waitForTimeout(1500);
      expect(await page.evaluate(() => window.__app.easyReading._currentPageSignature())).toBe(sigBefore);

      // ---- :5 往回跳 ----
      await sendKey(page, ':');
      await page.waitForFunction(() => window.__app.easyReading._functionMode === true, null, { timeout: 5000 });
      await typeLine(page, '5');
      // 等 resume（functionMode 退出）且 realign 回到尾端（_accEndRow 不變、狀態列回到文末）
      await page.waitForFunction(
        (end) => {
          const a = window.__app;
          return a.easyReading._functionMode === false &&
            !a.buf.easyReadingHealInFlight && a.view._accEndRow === end;
        },
        accEnd,
        { timeout: 15000 }
      );
      await page.waitForTimeout(2500); // 給自動翻頁機會犯錯（修前會在這段時間重複 append）

      const after = await rowTexts();
      expect(after.length).toBe(before.length);
      expect(after).toEqual(before);
      expect(await page.evaluate(() => window.__app.view._accEndRow)).toBe(accEnd);
      // 捲到跳轉目的地：視窗頂端附近（前幾列之內）
      const top = await page.evaluate(() => window.__app.view.mainDisplay.scrollTop);
      const chh = await page.evaluate(() => window.__app.view.chh);
      expect(top).toBeLessThan(chh * 12);
    } catch (err) {
      console.log('\n=== console ===\n' + logs.slice(-40).join('\n'));
      await page.screenshot({ path: 'tests/e2e/__screenshots__/er-seekback-error.png', fullPage: true });
      throw err;
    }
  });
});
