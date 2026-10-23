// 「浮層不准蓋住文末」的通用幾何檢查（docs/next-article.md「卡片的位置」的通則版）。
//
// 為什麼要有它：每個功能的 offline spec 預設把別的功能關掉（helpers/replay.js 的
// bootOffline），各自單獨看都對，疊在一起才壞 —— 例：底部推文列（fixed）壓在下一篇
// 卡片上。所以這裡**不列舉浮層**：捲到文末之後，
// 把畫面上所有 position: fixed／sticky 的東西（＋用負 margin 疊上來的好讀 footer）都當成
// 浮層，量它們有沒有蓋到「文末一定要看得到的東西」。以後新加的浮層不用登記就會被檢查。
//
// 文末一定要看得到的東西（目標）：
//   - #mainContainer 最後一列有內容的列（最後一則推文）；
//   - .main 裡 #screenRoot／#cursor 以外、看得到的節點（接在文末的東西，例：#nextArticleCard）。
// 規則：捲到底之後，每個目標都要整個在 .main 的可見範圍裡，而且不跟任何浮層重疊。
//
// 刻意浮在內容上面的東西放 ALLOWED（附理由）；其餘一律算數。

// 刻意浮在內容上、不算違規的浮層。
const ALLOWED = [
  // 換文遮罩：換文途中整個蓋住 .main 就是它的工作（平常 hidden）。
  '#nextArticleVeil',
  // 文章導覽軸：像捲軸一樣貼在終端機最右一欄（14px），軸上只有細線與標記、文字照樣看得到；
  // 手機平常隱藏、捲動中才出現。蓋到的是「最後一列的右端」，不是內容本身。
  '#articleNav',
];

// 捲到文末、等捲動停住，回傳違規清單（空陣列＝通過）。每筆是人看得懂的一句話。
async function bottomOverlayViolations(page) {
  const { waitScrollStable } = require('./layout');
  // 文末可能還在長（卡片的位置、預覽佔位盒）：捲到底 → 等停 → 再捲一次，直到不再變。
  for (let i = 0; i < 5; i++) {
    const moved = await page.evaluate(() => {
      const m = document.querySelector('.main');
      const before = m.scrollTop;
      m.scrollTop = m.scrollHeight;
      return m.scrollTop !== before;
    });
    await waitScrollStable(page, '.main');
    if (!moved && i > 0) break;
  }
  return page.evaluate((allowed) => {
    const main = document.querySelector('.main');
    const mc = document.getElementById('mainContainer');
    const out = [];
    const name = (el) =>
      el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.classList.length ? '.' + [...el.classList].join('.') : '');
    const shown = (el) => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    // 目標
    const targets = [];
    const isBlank = (el) =>
      el.getAttribute('type') === 'bbsrow' && !/\S/.test(el.textContent) && !el.querySelector('img, video, iframe');
    let last = null;
    outer: for (let n = mc.lastElementChild; n; n = n.previousElementSibling) {
      const nodes = n.classList.contains('screenChunk') ? [...n.children] : [n];
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (isBlank(nodes[i]) || !nodes[i].getClientRects().length) continue;
        last = nodes[i];
        break outer;
      }
    }
    if (last)
      targets.push({
        el: last,
        label: '最後一列內容「' + last.textContent.trim().slice(0, 20) + '」',
      });
    for (const c of main.children) {
      if (c.id === 'screenRoot' || c.id === 'cursor' || !shown(c)) continue;
      targets.push({ el: c, label: name(c) });
    }

    // 浮層：所有 fixed／sticky 的最外層（不含 .main 的祖先，例 #BBSWindow），＋好讀 footer。
    const overlays = [];
    for (const el of document.body.querySelectorAll('*')) {
      const pos = getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      if (el.contains(main) || main.contains(el)) continue;
      if (overlays.some((o) => o.contains(el))) continue;
      if (allowed.some((sel) => el.matches(sel))) continue;
      if (!shown(el)) continue;
      overlays.push(el);
    }
    const footer = document.getElementById('easyReadingLastRow');
    if (footer && shown(footer)) overlays.push(footer);

    // 兩個矩形重疊超過 1px（容許次像素的貼邊）⇒ "寬×高px"，否則 null。
    const overlap = (a, b) => {
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      return w > 1 && h > 1 ? Math.round(w) + '×' + Math.round(h) + 'px' : null;
    };
    const view = main.getBoundingClientRect();
    for (const t of targets) {
      const r = t.el.getBoundingClientRect();
      if (r.top < view.top - 0.5 || r.bottom > view.bottom + 0.5)
        out.push(
          t.label +
            ' 捲到底仍不在 .main 可見範圍內（' +
            Math.round(r.top) +
            '~' +
            Math.round(r.bottom) +
            '，可見 ' +
            Math.round(view.top) +
            '~' +
            Math.round(view.bottom) +
            '）'
        );
      for (const o of overlays) {
        for (const b of o.getClientRects()) {
          const hit = overlap(r, b);
          if (hit) {
            out.push(t.label + ' 被 ' + name(o) + ' 蓋住 ' + hit);
            break;
          }
        }
      }
    }
    // 浮層之間也不准互相蓋（例：手機的推文列壓在底部導覽列上，按鈕下緣被切掉）。
    for (let i = 0; i < overlays.length; i++)
      for (let j = i + 1; j < overlays.length; j++) {
        const hit = overlap(overlays[i].getBoundingClientRect(), overlays[j].getBoundingClientRect());
        if (hit) out.push(name(overlays[i]) + ' 與 ' + name(overlays[j]) + ' 互相重疊 ' + hit);
      }
    return out;
  }, ALLOWED);
}

module.exports = { bottomOverlayViolations };
