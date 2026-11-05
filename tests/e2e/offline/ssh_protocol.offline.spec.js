// SSH 協議（docs/ssh.md）的整條 boot／失敗提示／切換路徑，真瀏覽器、零外網。
//
// 用 dev build 的載體注入點 window.__pttTestTransport（src/js/transport.js）：SSH 線路上是加密過的
// bytes，WebSocket stub 餵不了明文 ⇒ 改在「載體」這一層塞假的，telnet 層以上照真的跑。
// 假載體記下每次 connect 的站台（window.__sites），依協議決定開或失敗：
//   opts.fail.websocket / opts.fail.ssh ＝ 該協議從未連上，close detail.reason 帶上給的值。
// 協議選 SSH 時 dev 的站台是 wssh://<頁面 host>/ssh（vite.config.mjs 的 dev /ssh relay）——
// 假載體接走，**不會**真的連到 ptt.cc:22。
// installReplay({ neverOpen }) 另外把 BBS WebSocket（含連線失敗診斷對 proxy 的探測）擋成連不上。
const { test, expect } = require('@playwright/test');
const { installReplay, installOfflineNetwork, loadCassette, waitScreenSettled } = require('../helpers/replay');

const label = async (page, key) => {
  await page.waitForFunction(() => typeof window.__i18n === 'function');
  return page.evaluate((k) => window.__i18n(k), key);
};

const PREF_KEY = 'pttchrome.pref.v1';

async function installFakeTransport(page, { fail = {}, prefs = null } = {}) {
  await page.addInitScript(
    ({ fail, prefs, PREF_KEY }) => {
      if (prefs) {
        try {
          const cur = JSON.parse(window.localStorage.getItem(PREF_KEY) || '{}');
          window.localStorage.setItem(PREF_KEY, JSON.stringify({ values: Object.assign({}, cur.values, prefs) }));
        } catch (e) {}
      }
      window.__sites = [];
      window.__pttTestTransport = (site, opts) => {
        window.__sites.push(site);
        const listeners = {};
        const t = {
          protocol: opts.protocol,
          sent: [],
          addEventListener(type, fn) {
            (listeners[type] = listeners[type] || []).push(fn);
          },
          emit(type, detail) {
            (listeners[type] || []).forEach((fn) => fn({ detail }));
          },
          send(s) {
            t.sent.push(s);
          },
          close() {
            t.emit('close', { reason: 'closed' });
          },
        };
        window.__transport = t;
        setTimeout(() => {
          if (opts.protocol in fail) t.emit('close', { reason: fail[opts.protocol] });
          else t.emit('open');
        }, 0);
        return t;
      };
    },
    { fail, prefs, PREF_KEY }
  );
}

const storedPrefs = (page) =>
  page.evaluate((k) => JSON.parse(window.localStorage.getItem(k) || '{}').values || {}, PREF_KEY);

const connectionAlert = async (page) =>
  page.locator('.PageTopAlert').filter({ hasText: await label(page, 'alert_connectionHeader') });

test.describe('SSH 協議', () => {
  test('WebSocket 連不上 → 「改用 SSH 連線」→ 記住（本機）並立即經 SSH relay 重連', async ({ page }) => {
    await installReplay(page, { neverOpen: true });
    await installOfflineNetwork(page);
    await installFakeTransport(page, { fail: { websocket: null } });
    await page.goto('/');

    const alert = await connectionAlert(page);
    await expect(alert).toBeVisible();
    const useSsh = alert.getByRole('button', { name: await label(page, 'alert_connectionUseSsh') });
    await expect(useSsh).toBeVisible();
    expect(await page.evaluate(() => window.__app.isConnected())).toBe(false);

    await useSsh.click();
    await expect.poll(() => page.evaluate(() => window.__app.isConnected())).toBe(true);
    const sites = await page.evaluate(() => window.__sites);
    expect(sites).toHaveLength(2);
    expect(sites[0]).toMatch(/^wstelnet:\/\/[^/]+\/bbs$/);
    expect(sites[1]).toMatch(/^wssh:\/\/[^/]+\/ssh$/);
    expect((await storedPrefs(page)).connectionProtocol).toBe('ssh');
    await expect(alert).toBeHidden();
  });

  test('SSH host key 不符 → 警告不要登入 → 「改用 WebSocket 連線」', async ({ page }) => {
    await installReplay(page, { neverOpen: true });
    await installOfflineNetwork(page);
    await installFakeTransport(page, { fail: { ssh: 'hostkey' }, prefs: { connectionProtocol: 'ssh' } });
    await page.goto('/');

    const alert = await connectionAlert(page);
    await expect(alert.getByText(await label(page, 'alert_connectionSshHostKey'))).toBeVisible();
    expect(await page.evaluate(() => window.__sites)).toEqual([expect.stringMatching(/^wssh:\/\//)]);

    await alert.getByRole('button', { name: await label(page, 'alert_connectionUseWebsocket') }).click();
    await expect.poll(() => page.evaluate(() => window.__app.isConnected())).toBe(true);
    expect((await page.evaluate(() => window.__sites))[1]).toMatch(/^wstelnet:\/\//);
    expect((await storedPrefs(page)).connectionProtocol).toBe('websocket');
  });

  test('SSH relay 連不上 → 提示檢查 relay 位址', async ({ page }) => {
    await installReplay(page, { neverOpen: true });
    await installOfflineNetwork(page);
    await installFakeTransport(page, { fail: { ssh: 'relay' }, prefs: { connectionProtocol: 'ssh' } });
    await page.goto('/');
    const alert = await connectionAlert(page);
    await expect(alert.getByText(await label(page, 'alert_connectionSshRelay'))).toBeVisible();
    await expect(alert.getByText(await label(page, 'alert_connectionCheckRelay'))).toBeVisible();
  });

  // telnet 層以上不因載體而變：SSH 協議下重放明文 cassette，畫面照常渲染、NAWS 照送，
  // 而且 NAWS 同時觸發載體的 resize（SSH 的 window-change）。
  test('SSH 協議下重放明文：畫面照常、NAWS 也送 window-change', async ({ page }) => {
    const cassette = loadCassette('cchat-caption');
    test.skip(!cassette, 'cassette 不存在');
    await installReplay(page);
    await installOfflineNetwork(page);
    await installFakeTransport(page, { prefs: { connectionProtocol: 'ssh' } });
    await page.addInitScript(() => {
      window.__resizes = [];
      const orig = window.__pttTestTransport;
      window.__pttTestTransport = (site, opts) => {
        const t = orig(site, opts);
        t.resize = (cols, rows) => window.__resizes.push([cols, rows]);
        return t;
      };
    });
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => window.__app && window.__app.isConnected())).toBe(true);
    expect((await page.evaluate(() => window.__sites))[0]).toMatch(/^wssh:\/\//);

    // server 的 IAC DO NAWS → client 回 WILL NAWS＋尺寸，並同時 resize 載體。
    await page.evaluate(() => window.__transport.emit('data', { data: '\xff\xfd\x1f' }));
    await expect.poll(() => page.evaluate(() => window.__resizes.length)).toBe(1);
    const [cols, rows] = await page.evaluate(() => window.__resizes[0]);
    expect([cols, rows]).toEqual(await page.evaluate(() => [window.__app.buf.cols, window.__app.buf.rows]));
    expect(await page.evaluate(() => window.__transport.sent.join(''))).toContain('\xff\xfb\x1f');

    // cassette 的 recv 是 base64；載體的 data 是 latin1 字串（與 WebSocket 載體相同）。
    const latin1 = Buffer.from(cassette.steps[0].recv, 'base64').toString('latin1');
    await page.evaluate((s) => window.__transport.emit('data', { data: s }), latin1);
    await waitScreenSettled(page);
    const text = await page.evaluate(() => {
      const buf = window.__app.buf;
      let all = '';
      for (let r = 0; r < buf.rows; r++) all += buf.getRowText(r, 0, buf.cols) + '\n';
      return all;
    });
    // 列表裡的 ASCII 帳號＝畫面確實照 telnet 層以上的原路渲染出來了。
    const ids = latin1.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ' ').match(/[A-Za-z][A-Za-z0-9]{5,}/g);
    expect(ids.length).toBeGreaterThan(3);
    for (const id of ids.slice(0, 3)) expect(text).toContain(id);
  });
});
