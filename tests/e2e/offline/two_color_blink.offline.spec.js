// 二色 DBCS 的閃爍 —— 離線守門（真瀏覽器 / 真 CSS / 零網路）。
//
// 為什麼一定要上 e2e：unit（tests/unit/two_color_blink.test.js）只驗得到
// word_segment 有沒有掛上 qq2 這個 class，驗不到「掛了之後使用者到底看不看得到」——
// 最終效果是 computed color，由 .blink--active .qq2 那組 CSS 規則決定（同一個理由
// 讓 blink_cursor.offline.spec.js 存在）。而且這裡要連渲染鏈一起驗：真的餵一個
// 「頭尾兩格屬性不同、其中有一格在閃」的全形字進去，看它有沒有走到 twoColorWord。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { bootOffline, feedRaw } = require('../helpers/replay');

// Big5「中」= 0xA4 0xA4。頭那格帶 blink（SGR 5）＋亮白，尾那格換成黃色且不閃
// ⇒ ColorState.equals 為 false ⇒ ColorSegmentBuilder 走 appendTwoColorWord。
// 屬性橫切一個全形字正是反白帶／背景色切換掃過中文時的真實情形。
const TWO_COLOR_BLINK_CHAR =
  '\x1b[2J\x1b[5;1H\x1b[0;5;37m\xa4\x1b[0;33m\xa4\x1b[24;80H';

// 同一個字但兩格都不閃 —— 對照組，確認 qq2 不是無條件掛上去的。
const TWO_COLOR_PLAIN_CHAR =
  '\x1b[2J\x1b[5;1H\x1b[0;37m\xa4\x1b[0;33m\xa4\x1b[24;80H';

// 閃爍相位每秒 toggle 一次，量之前先自己把 blink--active 掛上／拿掉，否則量到的是
// 隨機相位（cursor_shape.offline.spec.js 也是這樣處理）。
async function colorsWithBlink(page, active) {
  return page.evaluate((active) => {
    document.body.classList.toggle('blink--active', active);
    const el = document.querySelector('#mainContainer .qq2');
    if (!el) return null;
    return {
      text: getComputedStyle(el).color,
      overlay: getComputedStyle(el, '::after').color,
    };
  }, active);
}

const TRANSPARENT = 'rgba(0, 0, 0, 0)';

test.describe('二色 DBCS 的閃爍（離線）', () => {
  test('頭尾屬性不同且有一格在閃 → 閃爍相位時整個字消失，背景留著', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableEasyReadingList: false,
    });

    await feedRaw(page, TWO_COLOR_BLINK_CHAR);
    await page.waitForTimeout(400); // term_buf 的 30ms notify debounce + render flush

    const on = await colorsWithBlink(page, true);
    expect(on).not.toBeNull(); // 沒掛上 qq2 就是渲染鏈沒走到 twoColorWord
    expect(on.text).toBe(TRANSPARENT);
    // ::after 是頭色那半的複製字，不一起關掉的話左半會留著不閃
    expect(on.overlay).toBe(TRANSPARENT);

    // 亮相位：字回來（修好前這一格恆等於這個狀態，整個字從不消失）
    const off = await colorsWithBlink(page, false);
    expect(off.text).not.toBe(TRANSPARENT);
  });

  test('兩格都沒在閃 → 不掛 qq2，字永遠看得見', async ({ page }) => {
    test.setTimeout(90000);
    await bootOffline(page, ptt);
    await ptt.applyPrefs(page, {
      enableEasyReading: false,
      enableEasyReadingList: false,
    });

    await feedRaw(page, TWO_COLOR_PLAIN_CHAR);
    await page.waitForTimeout(400);

    expect(await colorsWithBlink(page, true)).toBeNull();
    // 對照組本身要真的有走到二色路徑，否則這條測試什麼都沒守到
    const twoColor = await page.evaluate(
      () => !!document.querySelector('#mainContainer span.o[data-text]')
    );
    expect(twoColor).toBe(true);
  });
});
