// 真輸入管線（2026-10）。
//
// **由瀏覽器／OS 決定形狀或順序的輸入**（右鍵、滾輪、鍵盤、剪貼簿、IME、拖放、焦點）
// 在 e2e 裡一律從這裡送：Playwright `page.mouse`／`page.keyboard`，或 CDP `Input.*`。
// 手捏 `new XxxEvent(...)`＋`dispatchEvent` 等於把「我們以為瀏覽器會送什麼」寫進測試，
// 是用假設驗證假設（issue #22、選取模式的 pointerType 都是這樣漏掉的）。
// 規範與對照表見 tests/e2e/README.md「真輸入」；靜態守護 tests/unit/e2e_real_input.test.js。
//
// 量座標一律經 helpers/layout（先等版面停，點下去前再確認底下是誰），理由同
// tests/unit/e2e_layout_settle.test.js。
const { expect } = require('@playwright/test');
const {
  scrollIntoViewStable,
  plainLeftEdge,
  assertPlainTextUnder,
} = require('./layout');

// CDP session 每頁一個（Chromium only；offline-firefox 只跑 selection.offline，不會走到）。
const cdpSessions = new WeakMap();
async function cdp(page) {
  let s = cdpSessions.get(page);
  if (!s) {
    s = await page.context().newCDPSession(page);
    cdpSessions.set(page, s);
  }
  return s;
}

// ---------------------------------------------------------------------------
// 右鍵
// ---------------------------------------------------------------------------

// 畫面上那串字的可視矩形（含 .main 的 transform 縮放）。
async function textRect(page, needle) {
  const rect = await page.evaluate((text) => {
    const walker = document.createTreeWalker(
      document.getElementById('mainContainer'),
      NodeFilter.SHOW_TEXT
    );
    for (let node; (node = walker.nextNode()); ) {
      const idx = node.textContent.indexOf(text);
      if (idx < 0) continue;
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + text.length);
      const r = range.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    return null;
  }, needle);
  if (!rect || rect.width < 4) {
    throw new Error(`${needle} 未渲染到畫面（或量不到寬度），測試前提失效`);
  }
  return rect;
}

// 真滑鼠從字串左緣拖到右緣，並確認選到的就是它（不是「非空就算過」）。
async function dragSelectText(page, needle) {
  const rect = await textRect(page, needle);
  const y = rect.y + rect.height / 2;
  await page.mouse.move(rect.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width - 1, y, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => window.getSelection().toString()))
    .toContain(needle);
  return rect;
}

// 選字後在選取範圍內按右鍵（落在範圍外，瀏覽器的 mousedown 會先收合選取 ——
// 那是真實行為，不是要繞過的東西）。
async function rightClickSelectedText(page, needle) {
  const rect = await dragSelectText(page, needle);
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2, {
    button: 'right',
  });
  return rect;
}

// 對某個元素按真右鍵：捲進視窗、等版面停、確認指標底下真的是它，才按。
// inline 元素（跨行連結）取第一個 client rect 的中心，避免落到兩行之間的空隙。
async function rightClickElement(page, selector) {
  await scrollIntoViewStable(page, selector);
  const pt = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getClientRects()[0] || el.getBoundingClientRect();
    const x = r.left + Math.min(r.width / 2, Math.max(2, r.width - 2));
    const y = r.top + r.height / 2;
    const at = document.elementFromPoint(x, y);
    return { x, y, hit: !!at && (at === el || el.contains(at)) };
  }, selector);
  if (!pt) throw new Error('未渲染到畫面，測試前提失效: ' + selector);
  if (!pt.hit) {
    throw new Error(
      `版面位移：(${Math.round(pt.x)}, ${Math.round(pt.y)}) 底下不是 ${selector}`
    );
  }
  await page.mouse.click(pt.x, pt.y, { button: 'right' });
  return pt;
}

// 在終端機的純文字處按真右鍵（不壓在連結／預覽上 ⇒ 開的是 normalEnabled 那組）。
async function rightClickPlainText(page) {
  const pt = await plainLeftEdge(page);
  await assertPlainTextUnder(page, pt.x, pt.y);
  await page.mouse.click(pt.x, pt.y, { button: 'right' });
  return pt;
}

// 記錄 contextmenu 的**事後**狀態：capture 階段先抓住事件物件，讀值延到派發完
// （defaultPrevented 要等所有 handler 跑完才有意義）。
async function recordContextMenu(page) {
  await page.evaluate(() => {
    window.__cm = [];
    if (window.__cmInstalled) return;
    window.__cmInstalled = true;
    window.addEventListener('contextmenu', (ev) => window.__cm.push(ev), true);
  });
}

async function lastContextMenu(page) {
  await expect.poll(() => page.evaluate(() => window.__cm.length)).toBeGreaterThan(0);
  return page.evaluate(() => {
    const ev = window.__cm[window.__cm.length - 1];
    return {
      isTrusted: ev.isTrusted,
      defaultPrevented: ev.defaultPrevented,
      pointerType: ev.pointerType,
    };
  });
}

// ---------------------------------------------------------------------------
// 滑鼠按鍵／滾輪（CDP）—— page.mouse.wheel 不會帶 buttons（實測：先
// page.mouse.down({ button: 'right' }) 再 wheel，頁面收到的仍是 buttons=0）。
// ---------------------------------------------------------------------------
const BUTTON_BIT = { left: 1, right: 2, middle: 4 };

async function mousePress(page, x, y, button) {
  await (await cdp(page)).send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button,
    buttons: BUTTON_BIT[button],
    clickCount: 1,
  });
}

async function mouseRelease(page, x, y, button) {
  await (await cdp(page)).send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button,
    buttons: 0,
    clickCount: 1,
  });
}

async function mouseWheel(page, x, y, { deltaY, buttons = 0 }) {
  await (await cdp(page)).send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x,
    y,
    deltaX: 0,
    deltaY,
    buttons,
  });
}

// ---------------------------------------------------------------------------
// 剪貼簿／IME／拖放
// ---------------------------------------------------------------------------

// 真貼上：寫進系統剪貼簿 → 在有焦點的 #t 上按 Ctrl/Cmd+V，paste 事件由瀏覽器生。
// 呼叫端要先 context.grantPermissions(['clipboard-read', 'clipboard-write'])。
async function pasteText(page, text) {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.locator('#t').focus();
  await page.keyboard.press('ControlOrMeta+V');
}

// 真 IME 組字：imeSetComposition ⇒ compositionstart／update；insertText ⇒ 確定（compositionend）。
async function imeSetComposition(page, text) {
  await (await cdp(page)).send('Input.imeSetComposition', {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  });
}

async function imeCommit(page, text) {
  await (await cdp(page)).send('Input.insertText', { text });
}

// 真拖放檔案：CDP Input.dispatchDragEvent，DataTransfer（含 File 的 type）由瀏覽器依
// 實體檔案生成。names 是檔名（副檔名決定 MIME）；檔案寫在該 test 的 output 目錄。
// 回傳 { drop, cancel }：dragEnter＋dragOver 已送出（遮罩該亮了），由呼叫端決定何時放開。
async function dragFiles(page, names, { x, y } = {}) {
  const fs = require('fs');
  const { test } = require('@playwright/test');
  const files = names.map((name) => {
    const p = test.info().outputPath('drop-' + name);
    fs.writeFileSync(
      p,
      /\.txt$/.test(name) ? 'hello' : Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    );
    return p;
  });
  const vp = page.viewportSize() || { width: 1280, height: 720 };
  const at = { x: x ?? Math.round(vp.width / 2), y: y ?? Math.round(vp.height / 2) };
  const data = { items: [], files, dragOperationsMask: 1 | 2 | 16 };
  const s = await cdp(page);
  await s.send('Input.dispatchDragEvent', { type: 'dragEnter', ...at, data });
  await s.send('Input.dispatchDragEvent', { type: 'dragOver', ...at, data });
  return {
    drop: () => s.send('Input.dispatchDragEvent', { type: 'drop', ...at, data }),
    cancel: () => s.send('Input.dispatchDragEvent', { type: 'dragCancel', ...at, data }),
  };
}

async function dropFiles(page, names, at) {
  const drag = await dragFiles(page, names, at);
  await drag.drop();
}

module.exports = {
  cdp,
  textRect,
  dragSelectText,
  rightClickSelectedText,
  rightClickElement,
  rightClickPlainText,
  recordContextMenu,
  lastContextMenu,
  mousePress,
  mouseRelease,
  mouseWheel,
  pasteText,
  imeSetComposition,
  imeCommit,
  dragFiles,
  dropFiles,
};
