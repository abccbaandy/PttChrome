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
const { findCassettes, bootOffline, replayCassette, feedRaw } = require('../helpers/replay');

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
      // mergeSameAuthorComments:false —— 本测按逐列推文数比对 golden commentCount；
      // 合并（预设开）的行为守护在 comment_merge.offline.spec.js。
      await ptt.applyPrefs(page, {
        enableEasyReading: true,
        showFloorNumbers: true,
        mergeSameAuthorComments: false,
      });
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

    // REGRESSION: 好读点图切换「整页放大/缩小」后，捲动位置整个跑掉——放大态卷到
    // 文章中段再点某张图缩小，内容总高骤减但 .main 的 scrollTop 不变 → 视窗落到文章
    // 更后面，刚刚在看的那张图跑出视野。修法：点击当下以「被点的图」为锚点记下它相对
    // 视窗的位置（offsetTop/offsetHeight，layout 座标；.main 与 img 各有 transform
    // scale，rect 与 scrollTop 不同尺规不可混用），在 useLayoutEffect 里换算回新的
    // scrollTop（见 src/js/scroll_anchor.js、Screen.jsx handleImageClick）。
    // 守门：缩小后该图必须仍与 .main 视窗相交（旧 code 会整个卷过头 → 交集 <= 0）。
    // 纯算式部分在 tests/unit/scroll_anchor.test.js；这里守真浏览器的真 layout。
    test(`点图缩小后被点的图仍在视野内（捲动锚定）[${cassette.__file}]`, async ({ page }) => {
      test.setTimeout(120000);
      await bootOffline(page, ptt);
      await ptt.applyPrefs(page, { enableEasyReading: true });
      await replayCassette(page, cassette, { easyReading: true });

      const r = await page.evaluate(async () => {
        const SEL = '#mainContainer img.hyperLinkPreview';
        const scroller = document.querySelector('.main');
        const mc = document.getElementById('mainContainer');
        if (!scroller || !mc) return { skip: 'no scroller/container' };
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        // 外部行内图片异步载入会持续撑高内容 → 量测前先等 scrollHeight 连续两轮不变
        //（同本档「末行遮挡」测的作法；stock-end 图多，race 会假红）。
        const settle = async () => {
          let prev = -1, stable = 0;
          for (let i = 0; i < 24 && stable < 2; i++) {
            await sleep(400);
            const h = scroller.scrollHeight;
            if (h === prev) stable++;
            else { stable = 0; prev = h; }
          }
        };
        const loadedImgs = () =>
          Array.from(document.querySelectorAll(SEL)).filter(
            (im) => im.offsetWidth > 0 && im.offsetHeight > 0
          );

        // 先卷到底逼所有行内图开始载入，等稳定后回顶。
        scroller.scrollTop = scroller.scrollHeight;
        await settle();
        scroller.scrollTop = 0;
        await sleep(300);

        let imgs = loadedImgs();
        if (imgs.length < 2) return { skip: `loaded imgs = ${imgs.length}` };

        // 点第一张 → 整页放大（内容变很长，正是位移最明显的场景）。
        imgs[0].click();
        await sleep(400);
        await settle();
        if (!mc.classList.contains('imagesEnlarged')) return { skip: 'enlarge did not apply' };
        imgs = loadedImgs();
        if (imgs.length < 2) return { skip: 'imgs vanished after enlarge' };

        // 取中间那张当锚点（上方有大量被放大的内容 → 缩小时位移最大）。
        const img = imgs[Math.floor(imgs.length / 2)];
        const rel = () => img.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        const viewH = scroller.getBoundingClientRect().height;
        const target = viewH * 0.3; // 卷到图顶位于视窗上方 30% 处（图顶在视窗内）
        for (let i = 0; i < 30; i++) {
          const d = rel() - target;
          if (Math.abs(d) < 3) break;
          scroller.scrollTop += d; // .main 有 scale 时收敛较慢但单调
          await sleep(30);
        }
        const before = { rel: rel(), scrollTop: scroller.scrollTop, viewH };

        // 点同一张图 → 缩小。React 19：click 的 setState 在事件 task 之后才 commit。
        img.click();
        await sleep(500);

        const mr = scroller.getBoundingClientRect();
        const ir = img.getBoundingClientRect();
        return {
          before,
          after: { rel: ir.top - mr.top, scrollTop: scroller.scrollTop },
          visible: Math.min(ir.bottom, mr.bottom) - Math.max(ir.top, mr.top),
          enlarged: mc.classList.contains('imagesEnlarged'),
        };
      });

      console.log(`[anchor] ${cassette.__file}: ${JSON.stringify(r)}`);
      test.skip(!!r.skip, `此 cassette 无足够已载入的行内图（${r.skip}）`);
      expect(r.enlarged).toBe(false);
      // 核心症状：缩小后该图仍须与视窗相交（旧 code 会卷过头 → 交集 <= 0）。
      expect(r.visible).toBeGreaterThan(0);
      // 图顶原本在视窗内 → 应维持固定间距（容忍 layout 取整 / scale 误差）。
      expect(Math.abs(r.after.rel - r.before.rel)).toBeLessThan(r.before.viewH * 0.15);
    });
  }
});

// 好读 End→原生跳到底：需带 'end' step 的 article cassette（录制时 RECORD_END=1）。
const endCassette = findCassettes('article').find((c) => c.steps.some((s) => s.on === 'end'));

// REGRESSION: 好读自动开影片时，直式影片（如 480×854）在旧的固定 width:640px 下
// 高度会撑到 1138px 远超视窗——图片超高还能上下卷着看，影片则连播放控制列都被推出
// 画面，没法操作。修法：.easyReadingVideo 比照 .easyReadingImg 给 max-height/max-width
// （src/css/main.css）。这里守真浏览器的真 layout：注入一个「刻意超高」的 video 替身
// （不需真影片档，CSS 的 max-height 会压过 inline 的 height），量它的实际视觉高度。
// 注意影片没有 img.hyperLinkPreview 那种反向 scale，视觉高度含 .main 的 transform，
// 故用 getBoundingClientRect（视觉座标）与 window.innerHeight 比，而非 layout 座标。
test.describe('好读内嵌影片尺寸（离线重放）', () => {
  if (!articles.length) {
    test.skip('尚无 article cassette；先 yarn record:cassette（guest 或帐密）', () => {});
  }

  test('影片不得超出可视范围（max-height 不可移除）', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await replayCassette(page, articles[0], { easyReading: true });

    const r = await page.evaluate(() => {
      const mc = document.getElementById('mainContainer');
      if (!mc) return { skip: 'no #mainContainer' };
      const v = document.createElement('video');
      v.className = 'easyReadingVideo';
      // 超高/超宽替身：若 CSS 的 max-* 不见了，rect 就会是这个夸张的值。
      v.style.height = '5000px';
      v.style.width = '5000px';
      mc.appendChild(v);
      const rect = v.getBoundingClientRect();
      const out = {
        h: rect.height,
        w: rect.width,
        winH: window.innerHeight,
        winW: window.innerWidth,
      };
      v.remove();
      return out;
    });
    test.skip(!!r.skip, r.skip || '');
    console.log(`[video-size] rect=${Math.round(r.w)}x${Math.round(r.h)} win=${r.winW}x${r.winH}`);
    expect(r.h).toBeGreaterThan(0);
    expect(r.h).toBeLessThanOrEqual(r.winH);
    expect(r.w).toBeLessThanOrEqual(r.winW);
  });
});

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

// 关好读的「单一出口」守门：任何手动关好读的路径都必须走 easyReading.exitEasyReading()，
// 且退出后画面要回原生 24 列并**仍随后续资料重绘**。LiveHelper（Live 文小帮手）启用是其中
// 一条只由 UI 驱动、程式无其他入口的路径（src/components/ContextMenu/index.jsx
// onLiveHelperChange），过去只有 comment 说明没有测试；漏呼叫或改用不完整的退出配方时
// 症状是好读长页留在画面上／退出后不再更新。故从真实右键选单驱动整链。
const liveHelperCassette = findCassettes('article')[0];

test.describe('LiveHelper 启用 → 关好读单一出口（离线重放）', () => {
  test.skip(!liveHelperCassette, '尚无 article cassette；先 yarn record:cassette');

  test('右键开 Live 文小帮手并启用 → 退出好读、回原生且画面仍能重绘', async ({ page }) => {
    test.setTimeout(90000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, { enableEasyReading: true });
    await replayCassette(page, liveHelperCassette, { easyReading: true });

    expect(await page.evaluate(() => window.__app.view.useEasyReadingMode)).toBe(true);

    // 右键选单 →「Live 文小帮手 ...」→ modal 的「启用」钮（locale 无关：走 window.__i18n）。
    await page.locator('#BBSWindow').click({ button: 'right', position: { x: 40, y: 20 } });
    const menu = page.locator('.DropdownMenu').first();
    await expect(menu).toBeVisible();
    const liveLabel = await page.evaluate(() => window.__i18n('cmenu_showLiveArticleHelper'));
    await menu.getByText(liveLabel, { exact: true }).click();
    const modal = page.locator('.LiveHelperModal');
    await expect(modal).toBeVisible();
    const enableLabel = await page.evaluate(() => window.__i18n('liveHelperEnable'));
    await modal.getByRole('button', { name: enableLabel }).click();

    // 好读必须已关闭、累积长页已清（完整退出配方，非只翻旗标）。
    await expect
      .poll(() => page.evaluate(() => window.__app.view.useEasyReadingMode))
      .toBe(false);
    expect(await page.evaluate(() => window.__app.buf.pageLines.length)).toBe(0);

    // 画面仍活：喂一帧原生画面应立即反映，且 DOM 收回单页 24 列（长页不残留）。
    await feedRaw(page, '\x1b[2J\x1b[H  LIVE HELPER REDRAW PROBE  ');
    await expect(page.locator('#mainContainer')).toContainText('LIVE HELPER REDRAW PROBE');
    const mcChildren = await page.evaluate(
      () => document.getElementById('mainContainer').childNodes.length
    );
    expect(mcChildren).toBeLessThanOrEqual(24);
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 掉页（typeahead 跳绘）回归 —— 使用者回报的「※ 发信站/※ 文章网址 那段消失」。
// pmore 不变量见 docs/pttbbs-screen-protocol.md §13。
//
// 成因链：
//   P4  pfterm.c#refresh 在 client 还有按键在途时直接 return **不画**。所以同时有
//       两个 PageDown 在途时，中间那页的画面永远不会送出来 —— 不是显示错，是那页
//       的字从来没到过 client。
//   旧 code 会送出重复的 PageDown：快路径 _onViewUpdated 记下页面签章却从不检查它
//       （只有 settle 路径有去重），任何在同一页再出现一次的完整帧（functionMode
//       resume 的强制 notify、水球重绘…）就再送一次。
//   P1  掉页后新页的起始行号会**跳过**上一页的结束行号（S' > E+1）。这在单次
//       PageDown 下不可能发生（PageDown == mf_forward(dispedlines-1) ⇒ S' == E），
//       所以它是可判定的证据。旧 resolvePageOverlap 把负重叠夹成 0 → 照常 append
//       → 破洞无声无息。
//
// 本测直接把 P4 的结果喂进来（dropSteps：那一页的画面整个不送，下一次 PageDown 收到
// 的是再下一页），断言新 code 能**发现**并自癒（送 Home → mf_goTop 从头重读）。
// 旧 code 在这里必红：被吞那页的行永久消失。
//
// stock-end 的形状刚好就是回报的症状：第 3 页（第 44~66 行）页尾正是
//   ※ 发信站: …            ← 第 65 行，只出现在第 3 页
//   ※ 文章网址: …          ← 第 66 行，同时是第 4 页的第一行（重叠列）
// 所以吞掉第 3 页 → 「发信站」不见、「文章网址」还在。
test.describe('掉页（typeahead 跳绘）侦测与自癒（离线重放）', () => {
  const paged = articles.filter((c) => (c.steps || []).some((s) => s.on === 'pagedown'));
  if (!paged.length) {
    test.skip('尚无多页 article cassette；先 yarn record:cassette', () => {});
  }

  for (const cassette of paged) {
    // 吞掉「中间」那个 pagedown step（第一个 pagedown 之后的那个），确保被吞的页
    // 既不是首页也不是末页 —— 它的内容只能靠自癒救回来。
    const pdIdx = cassette.steps
      .map((s, i) => (s.on === 'pagedown' ? i : -1))
      .filter((i) => i >= 0);
    const drop = pdIdx[Math.min(1, pdIdx.length - 1)];

    test(`吞掉一页 → 侦测到并自癒，内容完整 [${cassette.__file}]`, async ({ page }) => {
      test.setTimeout(90000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await bootOffline(page, ptt);
      await ptt.applyPrefs(page, {
        enableEasyReading: true,
        showFloorNumbers: false,
        mergeSameAuthorComments: false,
      });
      await replayCassette(page, cassette, {
        easyReading: true,
        dropSteps: [drop],
        answerHome: true,
      });

      const state = await page.evaluate(() => window.__replay);
      console.log(
        `[offline/drop] ${cassette.__file}: drop=${drop} dropped=${state.dropped} home=${state.home} fed=${state.fed}/${state.total}`
      );
      expect(state.dropped).toBeGreaterThan(0); // 真的吞了一页，否则本测没意义

      // 侦测到掉页 → 送 Home 从头重读（EasyReading._healFromTop）。
      expect(state.home).toBeGreaterThan(0);

      const rows = await readBbsLines(page);
      const joined = rows.join('\n');

      // 被吞那页的内容必须回来。「※ 发信站:」只出现在被吞的页里（「※ 文章网址:」
      // 是跨页重叠列，下一页还有 —— 正是回报中「只有发信站那段不见」的原因）。
      expect(joined).toContain('※ 發信站:');
      expect(joined).toContain('※ 文章網址:');

      // 自癒不得把内容重复贴一遍。
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1].replace(/\s+$/, '');
        const b = rows[i].replace(/\s+$/, '');
        if (a.trim() !== '') expect(b).not.toBe(a);
      }
      expect(errors).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// 半画帧（P6）：PTT 一次回应常被拆成多个 WS message（OBUFSIZE 3072 会中途 flush），
// 而 client 的 notify 有 30ms debounce ⇒ 一次翻页会跨好几个 redraw frame。中间那些
// 帧里内容列已是新页，但**底部状态列还是上一页的旧值**（pfterm per-cell dirty 更新，
// 状态列补丁与游标 park 永远排在内容之后），游标也还没 park 到 (rows-1, cols-1)。
// 拿这种帧去累积会把旧行号写进 _accEndRow（基准漂移）。新 code 用「游标已 park」
// 当完整回应的闸，半画帧只重画不累积。
test.describe('半画帧不污染累积（离线重放）', () => {
  const paged = articles.filter((c) => (c.steps || []).some((s) => s.on === 'pagedown'));
  if (!paged.length) {
    test.skip('尚无多页 article cassette；先 yarn record:cassette', () => {});
  }

  for (const cassette of paged) {
    for (const frac of [0.4, 0.75]) {
      test(`切在 ${frac} 拆帧重放：内容完整、无重复、每页只送一次 PageDown [${cassette.__file}]`, async ({
        page,
      }) => {
        test.setTimeout(90000);
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await bootOffline(page, ptt);
        await ptt.applyPrefs(page, {
          enableEasyReading: true,
          showFloorNumbers: false,
          mergeSameAuthorComments: false,
        });
        await replayCassette(page, cassette, { easyReading: true, splitFrames: frac });

        const state = await page.evaluate(() => window.__replay);
        expect(state.split).toBeGreaterThan(0);

        const rows = await readBbsLines(page);
        const joined = rows.join('\n');
        expect(joined).toContain('※ 發信站:');
        expect(joined).toContain('※ 文章網址:');
        for (let i = 1; i < rows.length; i++) {
          const a = rows[i - 1].replace(/\s+$/, '');
          const b = rows[i].replace(/\s+$/, '');
          if (a.trim() !== '') expect(b).not.toBe(a);
        }

        // 每个**收到过回应**的页只送一次 PageDown（最后一个签章是 cassette 已喂完、
        // 等不到回应的那页，允许一次 bounded settle 补送）。
        const pageDowns = state.sends.filter((s) => s.data.indexOf('\x1b[6~') >= 0);
        const perPage = new Map();
        const order = [];
        for (const s of pageDowns) {
          if (!perPage.has(s.sig)) order.push(s.sig);
          perPage.set(s.sig, (perPage.get(s.sig) || 0) + 1);
        }
        console.log(
          `[offline/split] ${cassette.__file} @${frac}: ` +
            order.map((k) => `${k}:${perPage.get(k)}`).join(' ')
        );
        for (const sig of order.slice(0, -1)) {
          expect({ sig, count: perPage.get(sig) }).toEqual({ sig, count: 1 });
        }
        expect(errors).toEqual([]);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 跨文章：上一篇的翻页交易状态不得跟到下一篇（回归守门 —— 使用者回报「进文章卡在
// 第一页、PgDn 没反应，换一篇还是卡」）。
//
// 真实链路里，好读一旦开着就**不会**再走 enterEasyReading()（nextEasyReadingState
// 要求 !enabled），而 ← 离开文章走的是 stopEasyReading()、不经 leaveCurrentPost()
// —— 所以「进一篇 → ← 回列表 → 再进一篇」这条最常见的路径以前没有任何重置点，
// _inFlightSig / _pageDownRetries 会一路继承下去。而**每篇文章第一页的签章都是
// 「1~22」**（sig 不跨文章唯一），于是下一篇的第一页被当成「上一篇那个还没回应的
// 请求」：快路径永远 wait、settle 路径用完重试上限后永远 giveup ⇒ 一个 PageDown
// 都送不出去 = 卡在第一页。
//
// 复现完全走使用者动作（不碰任何内部栏位）：只喂文章第一页、**不回应**它送出的
// PageDown（＝真实里被 pttbbs typeahead 吞掉 / 使用者抢先 ← 离开），然后回列表、
// 再开一篇。做两轮就把重试上限用完 —— 旧 code 第三篇一个键都不送。
test.describe('跨文章自动翻页（离线重放）', () => {
  const withStart = articles.filter((c) => (c.steps || []).some((s) => s.on === 'start'));
  const listCassette = findCassettes('list').find((c) =>
    (c.steps || []).some((s) => s.on === 'start')
  );
  if (!withStart.length || !listCassette) {
    test.skip('尚无 article + list cassette；先 yarn record:cassette', () => {});
  }

  if (withStart.length && listCassette) {
    const cassette = withStart[0];
    const artStart = cassette.steps.find((s) => s.on === 'start');
    const listStart = listCassette.steps.find((s) => s.on === 'start');

    test(`翻页请求没被回应 → ← 回列表 → 下一篇仍会自动翻页 [${cassette.__file}]`, async ({
      page,
    }) => {
      test.setTimeout(90000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await bootOffline(page, ptt);
      await ptt.applyPrefs(page, { enableEasyReading: true });

      // 只放第一页：好读会自动送 PageDown，而这一卷没有下一页可喂 —— 这个请求
      // 永远收不到回应，交易就停在 in-flight（真实里 = 掉键 / 使用者抢先离开）。
      await replayCassette(page, { steps: [artStart] }, { easyReading: true });

      // 从这里开始只数 WS 送出层的 bytes（自动翻页键都会经过它）。
      const collect = async () => {
        await page.evaluate(() => {
          window.__crossSent = [];
          window.__stubWSSent = (s) => window.__crossSent.push(s);
        });
      };
      const pagedDownCount = async () =>
        (await page.evaluate(() => window.__crossSent)).filter(
          (s) => s.indexOf('[6~') >= 0
        ).length;

      // ← 回列表 → 再开一篇。重复两轮：旧 code 第一轮还剩一次 settle 补送，
      // 第二轮补送额度用完 ⇒ giveup ⇒ 零送键。
      const openNextArticle = async () => {
        await feedRaw(page, await page.evaluate((b64) => atob(b64), listStart.recv));
        await page.waitForTimeout(300); // > SETTLE_MS：settle 到列表(2)
        await collect();
        await feedRaw(page, await page.evaluate((b64) => atob(b64), artStart.recv));
        await page.waitForTimeout(600); // 等快路径 + settle 补送
        return pagedDownCount();
      };

      expect(await openNextArticle()).toBeGreaterThan(0); // 第二篇
      expect(await openNextArticle()).toBeGreaterThan(0); // 第三篇 ← 旧 code 在这里挂
      expect(errors).toEqual([]);
    });
  }
});
