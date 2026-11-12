// 文章導覽軸（src/js/article_nav.js）的量測 helper，桌機／手機 spec 共用。
const { PNG } = require('pngjs');

const MAIN = '#BBSWindow > .main';

// 「推」那一格的中心 vs 第一則推文在軸上該在的位置（同一把尺：該列在 .main 內容裡的
// 像素位置 / scrollHeight，與滑塊的 scrollTop / scrollHeight 一致）。回傳兩者與差距（px）。
// 量列的位置走 offsetTop（不含 .main 的 transform），換算到軸上才用 rect。
async function commentMarkDrift(page) {
  return page.evaluate((sel) => {
    const main = document.querySelector(sel);
    const nav = document.getElementById('articleNav');
    const chip = nav && nav.querySelector('[data-nav-kind="comments"]');
    if (!main || !chip) return null;
    const row = chip.getAttribute('data-nav-row');
    const el = document.querySelector(`#mainContainer [type="bbsrow"][srow="${row}"]`);
    if (!el) return null;
    let top = 0;
    for (let e = el; e && e !== main; e = e.offsetParent) top += e.offsetTop;
    const r = nav.getBoundingClientRect();
    const c = chip.getBoundingClientRect();
    const expected = r.top + (top / main.scrollHeight) * r.height;
    const actual = c.top + c.height / 2;
    return { expected, actual, drift: Math.abs(actual - expected) };
  }, MAIN);
}

// 終端機右緣原生捲軸那一條（導覽軸有的話暫時藏起來才看得到）最亮的像素（0～255）。
// 導覽軸就是捲軸 ⇒ 原生的那條要隱形（黑底），否則右緣同時有兩條捲軸。
// 捲軸不佔寬（overlay）⇒ null：那一條底下是內文，量不了。
async function nativeScrollbarPeak(page) {
  const box = await page.evaluate((sel) => {
    const main = document.querySelector(sel);
    const r = main.getBoundingClientRect();
    // 原生捲軸佔的寬（offsetWidth − clientWidth，換算 transform 的縮放比例）。
    const scale = main.offsetWidth ? r.width / main.offsetWidth : 1;
    const gutter = (main.offsetWidth - main.clientWidth) * scale;
    if (gutter < 4) return null;
    const nav = document.getElementById('articleNav');
    if (nav) nav.style.visibility = 'hidden';
    return { x: r.right - gutter + 1, y: r.top + 4, width: gutter - 2, height: Math.min(r.height, window.innerHeight - r.top) - 8 };
  }, MAIN);
  if (!box) return null;
  try {
    const png = PNG.sync.read(await page.screenshot({ clip: box }));
    let peak = 0;
    for (let i = 0; i < png.data.length; i += 4)
      peak = Math.max(peak, png.data[i], png.data[i + 1], png.data[i + 2]);
    return peak;
  } finally {
    await page.evaluate(() => {
      const nav = document.getElementById('articleNav');
      if (nav) nav.style.visibility = '';
    });
  }
}

// .main 的外框寬、捲軸佔的寬、內容（#mainContainer）寬、給直系子層的寬（扣掉捲軸與
// padding：子層不只列，文末的下一篇卡片 width 是 .main 的百分比）與列的折行（scrollHeight）。
// 導覽軸一出現一消失這幾個都不能變（原生捲軸不畫之後空出的寬度要補回來）。
async function mainLayout(page) {
  return page.evaluate((sel) => {
    const main = document.querySelector(sel);
    const mc = document.getElementById('mainContainer');
    const cs = getComputedStyle(main);
    return {
      outer: main.offsetWidth,
      gutter: main.offsetWidth - main.clientWidth,
      content: mc.getBoundingClientRect().width,
      inner: main.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
      scrollHeight: main.scrollHeight,
    };
  }, MAIN);
}

// 導覽軸開著量一次 → pref 關、重新判斷 → 再量一次。
async function layoutWithAndWithoutNav(page, ptt) {
  const on = await mainLayout(page);
  await ptt.applyPrefs(page, { enableArticleNav: false });
  await page.evaluate(() => window.__app.articleNav.refresh());
  await page.locator('#articleNav').waitFor({ state: 'detached' });
  const off = await mainLayout(page);
  return { on, off };
}

module.exports = { commentMarkDrift, nativeScrollbarPeak, mainLayout, layoutWithAndWithoutNav };
