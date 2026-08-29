// offline e2e 的「版面穩定契約」（2026-08-27）。
//
// 背景：好讀是累積長頁，頁上每個連結都掛一個行內預覽佔位盒（src/render/inline_preview_slot.js）。
// 它是**延遲載入**的：捲到附近才 mount → <img> onLoad → ResizeObserver 撐高。也就是說
// `scrollIntoView` 本身就會觸發載入，而載入會在**捲完之後**才改變版面。於是
//
//     el.scrollIntoView(); const r = el.getBoundingClientRect();   // ← 這行是壞的
//
// 量到的 rect 之後還會位移，用舊座標點下去就落在別的元素上。症狀不是「點錯了」而是
// 「什麼都沒發生」——斷言退化成看不出原因的 0（實例：mouse.offline 的「點推文內容＝
// 同作者高亮」在 CI 拿到 0 個高亮列，見 50fa35c）。
//
// 這個模組把「等版面停」變成可重用、可被靜態掃描守護的契約
// （tests/unit/e2e_layout_settle.test.js）。三個層次，由粗到細：
//   waitPreviewsSettled   整頁終局：沒有在途圖片請求、沒有 .previewLoading、版面指紋不再變
//   waitRectStable        單一元素的 rect 連續 N 次不變
//   scrollIntoViewStable  捲到中央 → 等停 → 確認它**仍在視窗內**（不然重來）
//   assertElementUnder    點擊前再確認指標底下真的還是預期的東西（失配時大聲說出位移）
//
// 為什麼本機測不出這類 bug：預設 profile 是 'cache'（fixture PNG 秒回），版面在量測前
// 就穩了。要逼出來必須跑 `yarn test:e2e:offline:adverse`（offline-slow project）。
const { imageInflight } = require('./offline_images');

// 版面指紋：只要行內預覽還在長，這串就會變。
// 刻意含 .previewError 計數——404 情境下錯誤提示出現也是一次版面改變。
const FINGERPRINT_FN = () => {
  const main = document.getElementById('mainContainer');
  const slots = document.querySelectorAll('.inlinePreviewSlot');
  const heights = [];
  for (let i = 0; i < slots.length; ++i) heights.push(Math.round(slots[i].offsetHeight));
  return [
    main ? Math.round(main.scrollHeight) : -1,
    document.querySelectorAll('.previewLoading').length,
    document.querySelectorAll('.previewError').length,
    heights.join(','),
  ].join('|');
};

const fingerprint = (page) => page.evaluate(FINGERPRINT_FN);

const loadingCount = (page) =>
  page.evaluate(() => document.querySelectorAll('.previewLoading').length);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 整頁終局。三個條件同時成立才算穩：
//   (a) Node 端沒有圖片請求還壓在 route handler（slow 情境下這是唯一能看到「還在等」的
//       訊號，因為此時瀏覽器連 onLoad 都還沒發生）
//   (b) 頁面沒有 .previewLoading（含 FallbackImage 的 backoff 重試期間——它刻意維持讀取動畫）
//   (c) 版面指紋連續 `samples` 次相同
// 逾時**丟錯**而不是靜默放行：靜默放行等於把 flaky 藏回去。
async function waitPreviewsSettled(
  page,
  { timeout = 60000, samples = 3, interval = 150 } = {}
) {
  const deadline = Date.now() + timeout;
  let last = null;
  let stable = 0;
  let seen = [];
  while (Date.now() < deadline) {
    const inflight = imageInflight(page);
    const cur = await fingerprint(page);
    const loading = Number(cur.split('|')[1]);
    if (inflight === 0 && loading === 0 && cur === last) {
      if (++stable >= samples - 1) return cur;
    } else {
      stable = 0;
    }
    last = cur;
    seen.push(inflight + '@' + cur.slice(0, 120));
    if (seen.length > 4) seen = seen.slice(-4);
    await sleep(interval);
  }
  throw new Error(
    'waitPreviewsSettled 逾時：版面一直在動或還有圖片在途。最後幾次取樣（inflight@指紋）：\n' +
      seen.join('\n')
  );
}

// 單一元素的 rect 穩定。預設連續 3 次、間隔 100ms —— 比 50fa35c 的「2 次 × 50ms」嚴：
// 那個門檻在 observer 鏈還沒 fire 時（t=0 與 t=50ms 都還是初始值）會提前放行。
// 回傳穩定後的 rect；撐不穩就丟錯（附最後幾次的 top，好判斷是誰在推它）。
async function waitRectStable(
  page,
  selector,
  { samples = 3, interval = 100, timeout = 20000, tolerance = 0.5 } = {}
) {
  const deadline = Date.now() + timeout;
  let last = null;
  let stable = 0;
  const tops = [];
  while (Date.now() < deadline) {
    const r = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: b.top, left: b.left, width: b.width, height: b.height };
    }, selector);
    if (!r) throw new Error('waitRectStable：找不到元素 ' + selector);
    tops.push(Math.round(r.top * 10) / 10);
    if (last !== null && Math.abs(r.top - last.top) < tolerance) {
      if (++stable >= samples - 1) return r;
    } else {
      stable = 0;
    }
    last = r;
    await sleep(interval);
  }
  throw new Error(
    'waitRectStable 逾時：' +
      selector +
      ' 的 top 一直在動（最後取樣 ' +
      tops.slice(-6).join(' → ') +
      '）'
  );
}

// 捲到視野中央 → 等版面停 → 確認它**真的還在視窗內**且不再動。回傳穩定後的 rect。
//
// 為什麼要迴圈：`scrollIntoView` 只是把當下的版面捲到位，捲動本身又會把新的佔位盒帶進
// 「接近視野」而觸發載入；等它們載完，目標早就被上方長高的內容推走了。一次
// 「捲 → 等 → 量」會量到一個**穩定但已經捲出視窗**的 rect —— 之後 elementFromPoint 回
// null，斷言退化成「底下什麼都沒有」（實測：blacklist_quick_add 在 offline-mixed 下
// 量到 y=1090，視窗只有 720 高）。所以要捲到「等完之後它仍在視窗內」為止。
async function scrollIntoViewStable(page, selector, { attempts = 8, settleTimeout = 60000 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; ++i) {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView({ block: 'center' });
    }, selector);
    await waitPreviewsSettled(page, { timeout: settleTimeout });
    const r = await waitRectStable(page, selector);
    const inView = await page.evaluate(
      ({ top, bottom }) => top >= 0 && bottom <= window.innerHeight,
      { top: r.top, bottom: r.top + r.height }
    );
    if (inView) return r;
    last = r;
  }
  throw new Error(
    'scrollIntoViewStable：' +
      selector +
      ' 捲不進視窗內（最後一次 top=' +
      Math.round(last ? last.top : NaN) +
      '）—— 版面在每次 settle 之後又被推走'
  );
}

// 點擊前的最後一道：指標底下真的還是預期的東西嗎？
// 版面若在量測之後又位移，這裡會直接說出來，而不是讓斷言退化成沉默的 0。
// opts.closest：往上找的選擇器（如 '[data-pusher]'）；attribute：要比對的屬性。
async function elementUnder(page, x, y, { closest = null, attribute = null } = {}) {
  return page.evaluate(
    ({ x, y, closest, attribute }) => {
      const at = document.elementFromPoint(x, y);
      if (!at) return null;
      const el = closest ? at.closest(closest) : at;
      if (!el) return null;
      if (attribute) return el.getAttribute(attribute);
      return el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : '');
    },
    { x, y, closest, attribute }
  );
}

async function assertElementUnder(page, x, y, expected, opts = {}) {
  const actual = await elementUnder(page, x, y, opts);
  if (actual !== expected) {
    throw new Error(
      '版面位移：(' +
        Math.round(x) +
        ', ' +
        Math.round(y) +
        ') 底下預期是 ' +
        JSON.stringify(expected) +
        '，實際是 ' +
        JSON.stringify(actual) +
        '。（量座標與點擊之間版面又動了 —— 先 waitPreviewsSettled 再量）'
    );
  }
  return actual;
}

// 指標底下**不得**是連結／內嵌預覽。App.mouse_click 的優先權階梯裡它們贏過退出帶與
// pusher 高亮（見 docs/mouse.md），落在那上面的座標不是那幾條測試的現場。
const OVERRIDING_SEL =
  'a, img, video, iframe, .inlinePreviewSlot, .previewLoading, .previewError';

async function assertPlainTextUnder(page, x, y) {
  const hit = await page.evaluate(
    ({ x, y, sel }) => {
      const at = document.elementFromPoint(x, y);
      if (!at) return 'none';
      const over = at.closest(sel);
      return over ? over.tagName + '.' + String(over.className || '').split(' ')[0] : null;
    },
    { x, y, sel: OVERRIDING_SEL }
  );
  if (hit !== null) {
    throw new Error(
      '版面位移：(' +
        Math.round(x) +
        ', ' +
        Math.round(y) +
        ') 底下應是純文字，實際被 ' +
        hit +
        ' 蓋住'
    );
  }
}

// 找一列「可以被真的點到」的推文列。mouse.offline 與 pusher_highlight.offline 原本各有
// 一份拷貝（後者始終沒補上 settle，是 50fa35c 那個 bug 的活體），合併到這裡。
//
// 排除：黑名單列（visibility:hidden ⇒ 不是 hit-test 目標）、內容欄不在退出帶右邊的列、
// 左緣或內容被連結／預覽蓋住的列。
//
// opts.capHalfRow=true ⇒ y 取 `top + min(height/2, chh/2)`（pusher_highlight 的取法：
// 合併塊是多行 div，取整塊中點會落到第二行）。預設取整列中點（mouse.offline 的取法）。
async function stableCommentRow(page, { capHalfRow = false, settleTimeout = 60000 } = {}) {
  await waitPreviewsSettled(page, { timeout: settleTimeout });

  const candidates = await page.evaluate(() => {
    const out = [];
    const rows = document.querySelectorAll(
      '#mainContainer span[type="bbsrow"][data-pusher]'
    );
    let i = 0;
    for (const el of rows) {
      const key = 'e2e-row-' + i++;
      if (el.style.visibility === 'hidden') continue;
      const col = Number(el.getAttribute('data-pusher-col'));
      if (!(col > 7)) continue; // 內容區要真的在退出帶右邊才有得比
      el.setAttribute('data-e2e-row-key', key);
      out.push({ key: key, col: col, pusher: el.getAttribute('data-pusher') });
    }
    return out;
  });

  for (const c of candidates) {
    const sel = '[data-e2e-row-key="' + c.key + '"]';
    // 好讀是累積長頁，推文在文章尾端 ⇒ 預設一定捲在視窗外，elementFromPoint 用的是
    // **視窗座標**，不先捲進來一律落空。捲動又會觸發新的延遲載入 ⇒ 要捲到「等完之後
    // 它仍在視窗內」為止（見 scrollIntoViewStable）。撐不住的列就換下一列。
    let rect;
    try {
      rect = await scrollIntoViewStable(page, sel, { settleTimeout });
    } catch (e) {
      continue;
    }
    if (rect.height <= 0) continue;

    const pos = await page.evaluate(
      ({ s, col, capHalfRow, over }) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const v = window.__app.view;
        const left = parseFloat(v.firstGridOffset.left);
        const xOf = (c) => left + v.chw * (c + 0.5);
        const r = el.getBoundingClientRect();
        const y = capHalfRow
          ? r.top + Math.min(r.height / 2, v.chh / 2)
          : r.top + r.height / 2;
        const hit = (x) => {
          const at = document.elementFromPoint(x, y);
          if (!at || at.closest('[data-pusher]') !== el) return false;
          return !at.closest(over);
        };
        const leftX = xOf(1);
        const contentX = xOf(col + 1);
        if (!hit(leftX) || !hit(contentX)) return null;
        return { y: y, leftX: leftX, contentX: contentX, text: el.textContent };
      },
      { s: sel, col: c.col, capHalfRow: capHalfRow, over: OVERRIDING_SEL }
    );
    if (!pos) continue;
    return Object.assign({ col: c.col, pusher: c.pusher, selector: sel }, pos);
  }
  throw new Error(
    '找不到可點的推文列（版面已 settle，所以這是素材或渲染問題，不是時序）'
  );
}

// 找一列「左緣是純文字」的位置。好讀長頁裡有些列的左緣落在內嵌預覽插槽上（整寬區塊、
// 起點就在第 0 欄），那裡本來就該由預覽優先接手，不是退出手勢的現場。
// y 取自格子數學（firstGridOffset + chh），所以探測點本身不會飄；但**底下的內容會飄**
// ⇒ 一樣要先 settle，並在點擊前用 assertPlainTextUnder 再確認一次。
async function plainLeftEdge(page, { settleTimeout = 60000 } = {}) {
  await waitPreviewsSettled(page, { timeout: settleTimeout });
  const pos = await page.evaluate((over) => {
    const v = window.__app.view;
    const x = parseFloat(v.firstGridOffset.left) + v.chw * 1.5;
    const top = parseFloat(v.firstGridOffset.top);
    for (let row = 0; row < window.__app.buf.rows; ++row) {
      const y = top + v.chh * (row + 0.5);
      const el = document.elementFromPoint(x, y);
      if (!el) continue;
      if (el.closest(over)) continue;
      return { x: x, y: y, row: row };
    }
    return null;
  }, OVERRIDING_SEL);
  if (!pos) throw new Error('找不到左緣是純文字的列');
  return pos;
}

// ---------------------------------------------------------------------------
// 行內預覽的「掛出來了沒」——**live 也能用**的 seek（2026-08-29）。
//
// 為什麼不能沿用 offline 的 seekInlineMedia（helpers/replay.js）：它每一格都
// waitPreviewsSettled，而 settle 要求 `.previewLoading` 歸零。真 PTT ＋ 真圖床下
// imgur 的連線會 stall（docs/imgur-latency-research.md），產品端又**沒有**圖片載入
// timeout ⇒ 讀取指示器可以永遠留著 ⇒ settle 必逾時，只是把假紅換一種樣子。
//
// 為什麼不能沿用 live spec 原本那份手寫迴圈（就是這次要修掉的東西）：
//   * 直接寫 `scroller.scrollTop = y` 會和 easy_reading 自己的捲動控制打架（累積期間
//     它會把位置拉走）⇒ 佔位盒從沒真的進過視野；
//   * 每格固定 sleep(250) 就往下走，而 mount 鏈是 IntersectionObserver →
//     renderInto（React root）→ requestPreview 的 promise → commit，250ms 只夠快的
//     情況。掃過去的那一格接著被 far observer 卸掉 ⇒ 掃完整篇 found=0（現場記錄見
//     2026-08-29 的 handoff：7 個可預覽連結、0 個預覽節點）。
//
// 改成：鎖定「含目標連結那一列」的佔位盒 → scrollIntoView → 停在那裡等**內容條件**。
// 判定分兩級，因為它們的相依對象不同：
//   mounted  ＝ slot 裡出現任何預覽產物（含讀取中指示器）。這只證明延遲載入鏈通了，
//              **與圖床可不可達無關** ⇒ 可以當必驗斷言。
//   media    ＝ 真的出現 <img class=hyperLinkPreview>/<video>/<iframe>（loadedImage
//              再加上 offsetWidth>0）。解析／下載成功才有 ⇒ 依賴外網，呼叫端只能拿它
//              當「機會性」斷言。
// 一律**不丟錯**：要斷言還是 skip 由呼叫端決定（同 waitEasyReadingComplete 的約定）。
const MOUNTED_SEL =
  'img.hyperLinkPreview, video, iframe, .previewLoading, .previewError';
const MEDIA_SEL = 'img.hyperLinkPreview, video, iframe';

async function seekMountedPreview(
  page,
  { hrefFilter, maxSlots = 6, mountTimeout = 15000, mediaTimeout = 15000 } = {}
) {
  // 目標連結 → 同一列 wrapper 裡的佔位盒。結構出自 render/link_segment.js#build：
  // wrapper div > [ span[data-type=bbsline], div(previews), .fixedUrlLine… ]。
  // 打 data-e2e-slot-key 只是測試自己的標記（同 stableCommentRow 的作法），
  // **不動產品 DOM 契約**。
  const keys = await page.evaluate(
    ({ pattern, cap }) => {
      const re = new RegExp(pattern, 'i');
      const out = [];
      const seen = new Set();
      const anchors = document.querySelectorAll('#mainContainer a[href]');
      for (const a of anchors) {
        if (!re.test(a.getAttribute('href') || '')) continue;
        const line = a.closest('[data-type="bbsline"]');
        const wrap = line ? line.parentElement : null;
        if (!wrap) continue;
        const slot = wrap.querySelector('.inlinePreviewSlot');
        if (!slot || seen.has(slot)) continue;
        seen.add(slot);
        const key = 'e2e-slot-' + out.length;
        slot.setAttribute('data-e2e-slot-key', key);
        out.push({ key: key, href: a.getAttribute('href') });
        if (out.length >= cap) break;
      }
      return out;
    },
    { pattern: hrefFilter.source || String(hrefFilter), cap: maxSlots }
  );

  const result = {
    slots: keys.length,
    tried: [],
    mounted: false,
    mediaFound: false,
    loadedImage: false,
    slotKey: null,
    href: null,
  };
  if (!keys.length) return result;

  const state = (key) =>
    page.evaluate(
      ({ k, mounted, media }) => {
        const slot = document.querySelector('[data-e2e-slot-key="' + k + '"]');
        if (!slot) return { gone: true };
        const medias = slot.querySelectorAll(media);
        let loaded = false;
        for (const m of medias) if (m.offsetWidth > 0) loaded = true;
        return {
          mounted: !!slot.querySelector(mounted),
          media: medias.length > 0,
          loaded: loaded,
          loading: !!slot.querySelector('.previewLoading'),
          error: !!slot.querySelector('.previewError'),
        };
      },
      { k: key, mounted: MOUNTED_SEL, media: MEDIA_SEL }
    );

  for (const k of keys) {
    await page.evaluate((key) => {
      const slot = document.querySelector('[data-e2e-slot-key="' + key + '"]');
      if (slot) slot.scrollIntoView({ block: 'center' });
    }, k.key);

    // 停在原地等 mount（等的是內容條件，不是固定 sleep）。
    const deadline = Date.now() + mountTimeout;
    let st = await state(k.key);
    while (!st.gone && !st.mounted && Date.now() < deadline) {
      await sleep(200);
      st = await state(k.key);
    }
    // mount 之後再給媒體節點一段寬限（解析成功才會有；imgur 要先發 HEAD 探測）。
    const mediaDeadline = Date.now() + mediaTimeout;
    while (!st.gone && st.mounted && !st.media && !st.error && Date.now() < mediaDeadline) {
      await sleep(200);
      st = await state(k.key);
    }
    result.tried.push({ href: k.href, state: st });
    // 各級**只會往上加**：後面試的 slot 比較差時不可以把前面的成績蓋掉。
    // slotKey/href 一律指向目前為止最好的那個（呼叫端的點圖斷言要用它）。
    if (st.mounted) {
      if (!result.mounted) {
        result.mounted = true;
        result.slotKey = k.key;
        result.href = k.href;
      }
      if (st.media && !result.mediaFound) {
        result.mediaFound = true;
        result.slotKey = k.key;
        result.href = k.href;
      }
      if (st.loaded) {
        result.loadedImage = true;
        result.slotKey = k.key;
        result.href = k.href;
        return result; // 最完整的那一種，不必再試別的
      }
    }
  }
  return result;
}

module.exports = {
  OVERRIDING_SEL,
  MEDIA_SEL,
  MOUNTED_SEL,
  seekMountedPreview,
  assertElementUnder,
  assertPlainTextUnder,
  elementUnder,
  fingerprint,
  loadingCount,
  plainLeftEdge,
  scrollIntoViewStable,
  stableCommentRow,
  waitPreviewsSettled,
  waitRectStable,
};
