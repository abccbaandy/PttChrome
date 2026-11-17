// 手機列表卡片的文摘標示（P97，src/js/search_status.js#statusKind、components/SearchStatus）。
// 手機列表卡片把標題列右段「文摘《板》」與底列「文摘列表」都收掉了 ⇒ 切進文摘後跟完整列表長得一樣。
// unit（search_status.test.js）釘死認法與開關；這裡守 unit 碰不到的那半段：真按鍵進文摘 →
// 列表卡片上真的浮出標示；點「完整列表」送出去的真的是 Tab，PTT 切回完整列表就收起。
// 畫面是 upstream pttbbs 產的（tests/unit/fixtures/ptt_src_screens/digest.json）。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const rp = require('../helpers/replay');
const fx = require('../../unit/fixtures/ptt_src_screens/digest.json');

const b64 = (s) => Buffer.from(s, 'latin1').toString('base64');
const frame = (n) => fx.frames.find((f) => f.name === n).bytes;

// 列表 →（Tab）文摘 →（Tab）完整列表。第二個 Tab 只有「完整列表」鈕真的送了才會回畫面。
const CASSETTE = {
  meta: { mode: 'scenario', scenario: 'digest', prefs: {} },
  cols: fx.cols,
  rows: fx.rows,
  steps: [
    { on: 'start', recv: b64(frame('list')) },
    { on: 'raw', send: b64('\t'), recv: b64(frame('digest')) },
    { on: 'raw', send: b64('\t'), recv: b64(frame('plain')) },
  ],
};

async function boot(page, prefs) {
  await rp.bootOffline(page, ptt, { searchStatus: true });
  await ptt.applyPrefs(page, Object.assign({ enableEasyReading: true, enableEasyReadingList: true }, prefs || {}));
  await rp.replayListCassette(page, CASSETTE);
  await rp.waitScreenSettled(page);
  await expect(page.locator('#mainContainer .listCard').first()).toBeVisible();
}

// Tab 是原生操作：PTT 畫出文摘的那一幀先走原生鏡像，列表好讀做完才重新接手畫回卡片
// （不一定伴隨新的一幀）⇒ 等到卡片版面真的回來（view.listCards）才算進了文摘。
async function enterDigest(page) {
  await page.keyboard.press('Tab');
  await rp.waitFed(page, 2);
  await rp.waitScreenSettled(page);
  await page.waitForFunction(() => window.__app.view.listCards === true);
}

const pill = (page) => page.locator('#searchStatus[data-search-status-kind="digest"]');
const i18n = (page, key) => page.evaluate((k) => window.__i18n(k), key);

test.describe('手機文摘標示（P97）', () => {
  test('進文摘 ⇒ 列表卡片上浮出文摘標示；點「完整列表」送 Tab，回完整列表就收起', async ({ page }) => {
    await boot(page);
    await expect(page.locator('#searchStatus')).toHaveCount(0);
    await enterDigest(page);
    await expect(pill(page)).toBeVisible();
    await expect(pill(page)).toContainText(await i18n(page, 'digestStatus_label'));
    // 標示在 App Bar 下面、不蓋住第一張卡片的點擊區以外的東西：至少整顆在視窗裡。
    const box = await pill(page).boundingBox();
    const vw = page.viewportSize().width;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vw + 0.5);
    await pill(page).locator('[data-search-status="leaveDigest"]').tap();
    await rp.waitFed(page, 3);
    await rp.waitScreenSettled(page);
    await expect(page.locator('#searchStatus')).toHaveCount(0);
  });

  test('開關關掉 ⇒ 進文摘也不出現', async ({ page }) => {
    await boot(page, { mobileDigestStatus: false });
    await enterDigest(page);
    await expect(page.locator('#searchStatus')).toHaveCount(0);
  });
});
