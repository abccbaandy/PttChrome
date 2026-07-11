// 好读模式翻页回归 —— 离线版（不连真实 PTT，重放 byte cassette）。
// 永久化 tests/e2e/easy-reading.spec.js:17「好读模式第一则推文不消失」的守门：
// 该 bug 是跨页累积/去重(comment_parse.findPageOverlap) 把第一则(常为箭头)推文吃掉、
// 后续楼号错位。素材含黃仁勳那篇(#1g8znzQ3，golden 首推 bluebird5566)——与原 bug 同源。
// 断言用「从 cassette 自身导出的 golden」+ 结构不变式 → 文章永不过期、录哪篇都能守门。
//
// cassette 由 `yarn record:cassette` 录一次产出 tests/e2e/cassettes/<name>.json。
// 没录过 → skip（非失败）。这里遍历所有 article cassette，逐卷守门。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { findCassettes, bootOffline, replayCassette } = require('../helpers/replay');

// 推文列（textContent，可能含好读 floor badge：marker 后紧跟楼号数字）。
const COMMENT_RE = /^(推|噓|→)\d*\s+[0-9A-Za-z]+\s*:/;

async function readBbsLines(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#mainContainer [data-type="bbsline"]')).map(
      (el) => el.textContent
    )
  );
}

const articles = findCassettes('article');

test.describe('好读模式翻页（离线重放）', () => {
  if (!articles.length) {
    test.skip('尚无 article cassette；先 yarn record:cassette（guest 或帐密）', () => {});
  }

  for (const cassette of articles) {
    test(`第一则推文不被吃 + 楼号从 1 + 跨页不重复列 [${cassette.__file}]`, async ({ page }) => {
      test.setTimeout(90000);
      await bootOffline(page, ptt);
      await ptt.applyPrefs(page, { enableEasyReading: true, showFloorNumbers: true });
      await replayCassette(page, cassette, { easyReading: true });

      const rows = await readBbsLines(page);
      const comments = rows.filter((t) => COMMENT_RE.test(t));
      console.log(
        `[offline] ${cassette.__file}: rows=${rows.length} comments=${comments.length} golden=${cassette.meta.commentCount} first=${cassette.meta.firstCommentAuthor}`
      );

      expect(comments.length).toBeGreaterThan(0);

      // 第一则推文必须重现（regression：曾整列消失，黃仁勳那篇即 bluebird5566）。
      if (cassette.meta.firstCommentAuthor) {
        const present = rows.some((t) => t.toLowerCase().includes(cassette.meta.firstCommentAuthor));
        expect(present).toBe(true);
      }

      // 第一则推文应为第 1 楼（楼号不再因吃列而错位）。
      expect(comments[0]).toMatch(/^(推|噓|→)1\s/);

      // 去重正确：累积推文数应等于录制时的 golden（吃列→变少 / 重复→变多）。
      expect(comments.length).toBe(cassette.meta.commentCount);

      // 跨页去重不可造成「整列重复」：相邻非空白列不应完全相同。
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1].replace(/\s+$/, '');
        const b = rows[i].replace(/\s+$/, '');
        if (a.trim() !== '') expect(b).not.toBe(a);
      }
    });

    // 自动行内开图：好读文章走 inlinePreview=true → 有可预览连结的列旁应出现预览节点。
    // 该卷没有可预览连结（内容相依、已冻结）才 skip。
    test(`好读自动行内开图 [${cassette.__file}]`, async ({ page }) => {
      test.setTimeout(90000);
      const PREVIEW_SEL =
        '#mainContainer img.hyperLinkPreview, #mainContainer video.easyReadingVideo, #mainContainer iframe';
      const re =
        /(\.(?:jpe?g|png|gif|webp|bmp|apng|avif|mp4|webm|ogg)(?:$|[?#]))|imgur\.com|pbs\.twimg\.com|youtu\.?be|youtube\.com|meee\.com\.tw|clips\.twitch\.tv|flic\.kr|flickr\.com/i;

      await bootOffline(page, ptt);
      await ptt.applyPrefs(page, { enableEasyReading: true });
      await replayCassette(page, cassette, { easyReading: true });

      const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#mainContainer a[href]')).map((a) => a.getAttribute('href'))
      );
      test.skip(!links.some((h) => re.test(h)), '此 cassette 文章无可预览连结（内容相依）');

      await page.waitForSelector(PREVIEW_SEL, { timeout: 10000 });
      const previews = await page.evaluate((sel) => document.querySelectorAll(sel).length, PREVIEW_SEL);
      expect(previews).toBeGreaterThan(0);
    });

    // REGRESSION: 单页文章（只走 accumulatePageLines 首页分支）在好读模式下，文章「最后一行」
    // 被底部状态列 overlay(#easyReadingLastRow, margin-top:-1em 固定盖在 .main 视窗最底列)遮住。
    // 成因：首页分支漏设 #mainContainer paddingBottom（旧 code 设 ''=0px），而翻页分支有设 1em；
    // 当内容因行内媒体（如 youtu.be → iframe）变高可卷，卷到底时末行贴底被 overlay 盖住——末行
    // 其实在 pageLines 里（非掉列），纯属渲染遮挡。修法：两分支统一 paddingBottom='1em'。
    // 守门：(a) 进好读文章后 mainContainer 必有非零 bottom padding（旧 code 单页文=0px → 红）；
    //       (b) 若该卷有行内媒体（内容够高可卷）卷到底后，末行 rect 不被 overlay rect 盖住。
    // 素材 test-xmen 即单页(第 1/1 页 100%)+youtu.be 行内媒体+1 推文，正中此 case。
    test(`末行不被底部状态列 overlay 遮住（单页 paddingBottom）[${cassette.__file}]`, async ({ page }) => {
      test.setTimeout(90000);
      const MEDIA_SEL = '#mainContainer img.hyperLinkPreview, #mainContainer video.easyReadingVideo, #mainContainer iframe';
      await bootOffline(page, ptt);
      await ptt.applyPrefs(page, { enableEasyReading: true });
      await replayCassette(page, cassette, { easyReading: true });

      // (a) padding 不变式：好读文章页 mainContainer 必有非零 bottom padding（给底部 overlay 让位）。
      const pad = await page.evaluate(() => {
        const mc = document.querySelector('#mainContainer');
        return mc ? getComputedStyle(mc).paddingBottom : null;
      });
      console.log(`[occlude] ${cassette.__file}: paddingBottom=${pad}`);
      expect(pad).toBeTruthy();
      expect(pad).not.toBe('0px');

      // (b) 行内媒体让内容变高 → 卷到底断言末行未被 overlay 遮住。等媒体异步渲染。
      await page.waitForTimeout(1500);
      const m = await page.evaluate(async (sel) => {
        const scroller = document.querySelector('.main');
        const overlay = document.querySelector('#easyReadingLastRow');
        // 外部行内图片异步载入会持续撑高内容：单次卷到底＋固定 sleep 会在图片载完前
        // 量测（race，stock-end.json 图多曾稳定红——量测后又长高 165px，末行被推回
        // overlay 下方）。改为每轮重新卷到底、直到 scrollHeight 连续两轮不变（上限 10s）。
        let prevH = -1, stable = 0;
        for (let i = 0; i < 20 && stable < 2; i++) {
          if (scroller) scroller.scrollTop = scroller.scrollHeight;
          await new Promise((r) => setTimeout(r, 500));
          const h = scroller ? scroller.scrollHeight : 0;
          if (h === prevH) stable++;
          else { stable = 0; prevH = h; }
        }
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
        await new Promise((r) => setTimeout(r, 300));
        const lines = Array.from(document.querySelectorAll('#mainContainer [data-type="bbsline"]'));
        const nonBlank = lines.filter((el) => el.textContent.replace(/\s+$/, '') !== '');
        const last = nonBlank[nonBlank.length - 1];
        const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; };
        const ov = overlay ? getComputedStyle(overlay) : null;
        return {
          media: document.querySelectorAll(sel).length,
          scrollable: scroller ? scroller.scrollHeight > scroller.clientHeight + 2 : false,
          lastText: last ? last.textContent.replace(/\s+$/, '') : null,
          lastRect: rect(last), overlayRect: rect(overlay), overlayDisplay: ov ? ov.display : null,
        };
      }, MEDIA_SEL);
      console.log(`[occlude] ${cassette.__file}: media=${m.media} scrollable=${m.scrollable} last=|${m.lastText}|`);
      // 仅在「内容可卷且 overlay 显示」时检查遮挡：非可卷的纯文单页不卷，末行本就在 overlay 上方。
      if (m.scrollable && m.overlayDisplay !== 'none' && m.lastRect && m.overlayRect) {
        expect(m.lastRect.bottom).toBeLessThanOrEqual(m.overlayRect.top + 2);
      }
    });
  }
});

// 好读 End→原生跳到底：需带 'end' step 的 article cassette（录制时 RECORD_END=1）。
const endCassette = findCassettes('article').find((c) => c.steps.some((s) => s.on === 'end'));

test.describe('好读 End 切回原生（离线重放）', () => {
  test.skip(!endCassette, '尚无带 end step 的 cassette；录制时设 RECORD_END=1');

  test('End 切回原生、跳到文章最底、好读自订列隐藏', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await replayCassette(page, endCassette, { easyReading: true });

    // 重放完自动翻页部分后应在好读模式。
    expect(await page.evaluate(() => window.__app.view.useEasyReadingMode)).toBe(true);

    // 触发 End：switchToNativeAtBottom 送 \x1b[4~ → player 喂 'end' step（原生底部画面）。
    await page.evaluate(() => window.__app.easyReading.switchToNativeAtBottom());
    await page.waitForTimeout(1500);

    const after = await page.evaluate(() => {
      const a = window.__app;
      const lr = document.getElementById('easyReadingLastRow');
      const mc = document.getElementById('mainContainer');
      return {
        useEasyReadingMode: a.view.useEasyReadingMode,
        mcChildren: mc ? mc.childNodes.length : -1,
        lastRowDisplay: lr ? getComputedStyle(lr).display : 'no-el',
        screen: mc ? mc.innerText : '',
      };
    });

    expect(after.useEasyReadingMode).toBe(false); // 切回原生
    expect(after.mcChildren).toBeLessThanOrEqual(24); // 单页原生 DOM，非好读累积
    expect(after.screen).toContain('說明'); // 原生状态列
    expect(after.screen).toContain('100%'); // 在最底
  });
});
