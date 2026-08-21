// UI 行為型 offline e2e —— 框架無關、跨 bootstrap 3→5 / react-bootstrap 0.31→2 遷移存活。
//
// 目的（見 docs/handoff/bootstrap-upgrade-research.md「測試策略」）：bootstrap 升級時
// class 名會變、樣式會脫落，但「行為」（選單出現/分頁切換/按鈕反應/alert 開關）不該變。
// 故這裡只斷言「元素出現/消失/可見/值寫入」，不碰 class 名或顏色。
// 取代被刪的 bootstrap_css_guard.offline.spec.js（那是版本釘樁，遷移後必紅且無意義）。
//
// 不需任何 cassette：stub WebSocket 离线 boot 後直接操作 UI。
const { test, expect } = require('@playwright/test');
const ptt = require('../helpers/ptt');
const { installReplay, waitConnected, feedRaw } = require('../helpers/replay');

// locale 無關的 label 查詢（dev build 暴露 window.__i18n）。
const label = (page, key) => page.evaluate(k => window.__i18n(k), key);

// 右鍵叫出 context menu（無選取 → normalEnabled 路徑）。
async function openContextMenu(page) {
  await feedRaw(page, '\x1b[2J\x1b[H  CONTEXT MENU TEST LINE  ');
  await page.waitForTimeout(200);
  await page.locator('#BBSWindow').click({ button: 'right', position: { x: 40, y: 20 } });
}

// 輸入小幫手**預設不顯示**在右鍵選單（pref enableInputHelper，見 pref_storage.js）：
// 要測它就得先把開關打開。它仍刻意不算 modal（終端機照收鍵盤），下面幾條「非 modal
// 浮層」的測試就是靠這個性質。
async function openInputHelper(page) {
  await ptt.applyPrefs(page, { enableInputHelper: true });
  await openContextMenu(page);
  await page.locator('.DropdownMenu').first()
    .getByText(await label(page, 'cmenu_showInputHelper'), { exact: true }).click();
  await expect(page.locator('.InputHelperModal__ColorList')).toBeVisible();
}

test.describe('UI 行為（offline，跨 bootstrap 版本守門）', () => {
  test('右鍵選單出現 → 點 Settings → PrefModal 開啟', async ({ page }) => {
    await installReplay(page);
    await page.goto('/');
    await waitConnected(page);

    await openContextMenu(page);

    // 右鍵選單改用 Mantine Menu（classNames.dropdown="DropdownMenu"），dropdown 在
    // portal（document.body 下），不再位於 #cmenuReact 內。
    const menu = page.locator('.DropdownMenu').first();
    await expect(menu).toBeVisible();
    // 選單含預期項目（無選取時：Settings 一定在）。
    const settings = await label(page, 'cmenu_settings');
    await expect(menu.getByText(settings, { exact: true })).toBeVisible();

    // 點 Settings → PrefModal 出現（以 general 分頁的 copyOnSelect 欄位為 marker，class 無關）。
    await menu.getByText(settings, { exact: true }).click();
    await expect(page.locator('.PrefModal')).toBeVisible();
    await expect(page.locator('.PrefModal input[name="copyOnSelect"]')).toBeVisible();
  });

  // deep link 交接通知的開關。勾選是全 app 唯一會問通知權限的地方（那裡才有
  // user activation），所以它不能走通用的 onCheckboxChange —— 這條守住接線沒斷。
  test('PrefModal general 分頁：deep link 交接通知開關可勾選', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await installReplay(page);
    await page.goto('/');
    await openSettings(page);

    const box = page.locator('.PrefModal input[name="deepLinkHandoffNotify"]');
    await expect(box).toBeVisible();
    await expect(box).toBeChecked(); // 預設開
    await box.uncheck();
    await expect(box).not.toBeChecked();
    // 勾回去會觸發 Notification.requestPermission —— 沒授權的 context 也不能炸。
    await box.check();
    await expect(box).toBeChecked();
    expect(errors).toEqual([]);
  });

  test('PrefModal 分頁切換：general → connection → enhance → autologin → ai → local → backup → about 內容對應切換', async ({ page }) => {
    await installReplay(page);
    await page.goto('/');
    await waitConnected(page);

    await openContextMenu(page);
    const settings = await label(page, 'cmenu_settings');
    await page.locator('.DropdownMenu').first()
      .getByText(settings, { exact: true }).click();
    await expect(page.locator('.PrefModal')).toBeVisible();

    const nav = page.locator('.PrefModal__Grid__Col--left');
    const copyOnSelect = page.locator('.PrefModal input[name="copyOnSelect"]'); // general only
    const proxyUrl = page.locator('.PrefModal input[name="proxyUrl"]');     // connection only
    const imgurProxyUrl = page.locator('.PrefModal input[name="imgurProxyUrl"]'); // connection only
    const blacklist = page.locator('.PrefModal textarea[name="blacklist"]'); // enhance only
    const autoLoginUser = page.locator('.PrefModal input[name="autoLoginUser"]'); // autologin only
    const autoLoginOtpSecret =
      page.locator('.PrefModal input[name="autoLoginOtpSecret"]');           // autologin only
    const enableAi = page.locator('.PrefModal input[name="enableAi"]');      // ai only
    const exportBtn = page.locator('.PrefModal')                            // backup only
      .getByRole('button', { name: await label(page, 'options_backupExportBtn') });
    const syncSignIn = page.locator('.PrefModal')                           // backup only
      .getByRole('button', { name: await label(page, 'options_syncSignIn') });

    // 起始：general 可見
    await expect(copyOnSelect).toBeVisible();
    await expect(proxyUrl).toBeHidden(); // 連線設定已全數移出一般分頁
    await expect(autoLoginUser).toBeHidden();
    await expect(syncSignIn).toBeHidden(); // 雲端同步已移到設定備份分頁

    // → connection（BBS proxy + imgur 圖片代理，兩組都在這一頁）
    await nav.getByText(await label(page, 'options_connection'), { exact: true }).click();
    await expect(proxyUrl).toBeVisible();
    await expect(imgurProxyUrl).toBeVisible();
    await expect(copyOnSelect).toBeHidden();
    await expect(blacklist).toBeHidden();

    // → enhance
    await nav.getByText(await label(page, 'options_enhance'), { exact: true }).click();
    await expect(blacklist).toBeVisible();
    await expect(proxyUrl).toBeHidden();
    await expect(autoLoginUser).toBeHidden();
    await expect(enableAi).toBeHidden(); // AI 設定已全數移出增強功能分頁

    // → autologin（開關組 + 帳號／密碼／2FA 密鑰，整條登入流程集中在這一頁）
    await nav.getByText(await label(page, 'options_autoLoginTab'), { exact: true }).click();
    await expect(autoLoginUser).toBeVisible();
    await expect(autoLoginOtpSecret).toBeVisible();
    await expect(page.locator('.PrefModal input[name="autoLogin"]')).toBeVisible();
    await expect(blacklist).toBeHidden();

    // → ai（裝置端 AI 總開關 + 細部設定）
    await nav.getByText(await label(page, 'options_ai'), { exact: true }).click();
    await expect(enableAi).toBeVisible();
    await expect(page.locator('.PrefModal input[name="enableCaptionAi"]')).toBeVisible();
    await expect(page.locator('.PrefModal input[name="enableUrlAi"]')).toBeVisible();
    await expect(blacklist).toBeHidden();
    await expect(autoLoginUser).toBeHidden();

    // → local（上班模式所在的本機設定分頁；帳密已移到自動登入分頁）
    await nav.getByText(await label(page, 'options_local'), { exact: true }).click();
    await expect(
      page.locator('.PrefModal input[name="enableWorkMode"]')
    ).toBeVisible();
    await expect(autoLoginUser).toBeHidden();
    await expect(blacklist).toBeHidden();

    // → backup（匯出／匯入檔案 + 雲端同步；雲端同步是從一般分頁搬過來的）
    await nav.getByText(await label(page, 'options_backup'), { exact: true }).click();
    await expect(exportBtn).toBeVisible();
    await expect(
      page.locator('.PrefModal input[name="backupImportFile"]')
    ).toHaveCount(1); // display:none，由按鈕轉發點擊
    await expect(syncSignIn).toBeVisible();
    await expect(copyOnSelect).toBeHidden();
    await expect(autoLoginUser).toBeHidden();

    // → about（含 PttChrome 版本字樣）
    await nav.getByText(await label(page, 'options_about'), { exact: true }).click();
    await expect(page.locator('.PrefModal').getByText('PttChrome').first()).toBeVisible();
    await expect(autoLoginUser).toBeHidden();

    // → 回 general
    await nav.getByText(await label(page, 'options_general'), { exact: true }).click();
    await expect(copyOnSelect).toBeVisible();
    await expect(proxyUrl).toBeHidden();
  });

  // 未支援（其他瀏覽器）／裝置不符：AI 分頁**照常顯示**，但總開關與所有子選項
  // 一律反灰並給出狀態說明——使用者才知道有這功能與為何不能用。
  //
  // 兩種狀態都用 stub 驅動，**不靠 runner 當下的實際能力**：這版 Playwright 的
  // Chromium 在真實 origin 下 availability() 其實回 'downloadable'（不是舊筆記寫的
  // 'unavailable'），依環境斷言會隨 browser 版本漂移。
  for (const [name, state, initScript] of [
    ['unsupported（其他瀏覽器沒有 Prompt API）', 'unsupported',
      () => { delete window.LanguageModel; }],
    ['unavailable（裝置規格不符）', 'unavailable',
      () => {
        window.LanguageModel = {
          availability: () => Promise.resolve('unavailable'),
          create: () => Promise.reject(new Error('should not be called')),
        };
      }],
  ]) {
    test(`PrefModal AI 分頁：${name} → 全部反灰且有狀態說明`, async ({ page }) => {
      await page.addInitScript(initScript);
      await installReplay(page);
      await page.goto('/');
      const nav = await openSettings(page);

      await nav.getByText(await label(page, 'options_ai'), { exact: true }).click();
      const master = page.locator('.PrefModal input[name="enableAi"]');
      await expect(master).toBeVisible(); // 分頁本身照常顯示
      await expect(master).toBeDisabled();
      await expect(page.locator('.PrefModal input[name="enableCaptionAi"]')).toBeDisabled();
      await expect(page.locator('.PrefModal input[name="enableUrlAi"]')).toBeDisabled();

      await expect(
        page.locator('.PrefModal').getByText(await label(page, 'options_aiStatus_' + state))
      ).toBeVisible();
    });
  }

  // 可用但模型還沒下載：分頁能用（總開關可勾），子選項仍等總開關開了才解鎖。
  test('PrefModal AI 分頁：模型可下載時總開關可勾，子選項仍依附總開關', async ({ page }) => {
    await page.addInitScript(() => {
      window.LanguageModel = {
        availability: () => Promise.resolve('downloadable'),
        // 勾選才會呼叫（user activation）；這裡直接給一顆假 session。
        create: () => Promise.resolve({ destroy: () => {} }),
      };
    });
    await installReplay(page);
    await page.goto('/');
    const nav = await openSettings(page);

    await nav.getByText(await label(page, 'options_ai'), { exact: true }).click();
    const master = page.locator('.PrefModal input[name="enableAi"]');
    await expect(master).toBeEnabled();
    // 預設 enableAi=false → 子選項反灰（總閘門）。
    const caption = page.locator('.PrefModal input[name="enableCaptionAi"]');
    await expect(caption).toBeDisabled();

    await page.locator('.PrefModal label[for="pref-check-enableAi"]').click();
    await expect(master).toBeChecked();
    await expect(caption).toBeEnabled();
  });

  test('PrefModal 勾選 + 關閉：值寫入 localStorage 且 modal 消失', async ({ page }) => {
    await installReplay(page);
    await page.goto('/');
    await waitConnected(page);

    await openContextMenu(page);
    const settings = await label(page, 'cmenu_settings');
    await page.locator('.DropdownMenu').first()
      .getByText(settings, { exact: true }).click();
    await expect(page.locator('.PrefModal')).toBeVisible();

    // 到 enhance 分頁，切換 showFloorNumbers 勾選狀態。
    const nav = page.locator('.PrefModal__Grid__Col--left');
    await nav.getByText(await label(page, 'options_enhance'), { exact: true }).click();
    const checkbox = page.locator('.PrefModal input[name="showFloorNumbers"]');
    await expect(checkbox).toBeVisible();
    const before = await checkbox.isChecked();
    // 點 label 文字（非方框）切換 → 守 BS5 Form.Check 的 id/htmlFor 關聯不脫落
    // （無 id 時 label 不關聯 input，點文字無反應；見 PrefModal.js Checkbox adapter）。
    await page
      .locator('.PrefModal label[for="pref-check-showFloorNumbers"]')
      .click();
    await expect(checkbox).toBeChecked({ checked: !before });

    // 用 Mantine Modal 內建關閉鈕（aria-label="Close"）關閉（onClose → onCloseClick
    // → 寫入 + onSave）。
    await page.locator('.PrefModal button[aria-label="Close"]').click();
    await expect(page.locator('.PrefModal')).toBeHidden();

    // localStorage 應持久化新值。
    const saved = await page.evaluate(() => {
      try {
        return JSON.parse(window.localStorage.getItem('pttchrome.pref.v1') || '{}');
      } catch (e) {
        return {};
      }
    });
    expect(saved.values && saved.values.showFloorNumbers).toBe(!before);
  });

  test('上班模式：勾選後 body 掛 work-mode-active、q11 壓灰、打字游標仍看得見、值持久化', async ({ page }) => {
    await installReplay(page);
    await page.goto('/');
    const nav = await openSettings(page);

    await nav.getByText(await label(page, 'options_local'), { exact: true }).click();
    await page
      .locator('.PrefModal label[for="pref-check-enableWorkMode"]')
      .click();
    await page.locator('.PrefModal button[aria-label="Close"]').click();
    await expect(page.locator('.PrefModal')).toBeHidden();

    // 渲染層生效：body class + 亮黃(q11)被 override 成灰階（不再是 #ffff00）。
    await expect(page.locator('body.work-mode-active')).toHaveCount(1);
    const colors = await page.evaluate(() => {
      const probe = (cls) => {
        const el = document.createElement('span');
        el.className = cls;
        document.body.appendChild(el);
        const c = getComputedStyle(el).color;
        el.remove();
        return c;
      };
      return { q11: probe('q11'), floorBadge: probe('floorBadge') };
    });
    expect(colors.q11).not.toBe('rgb(255, 255, 0)');
    // 樓層編號（main.css 寫死 #ffd34d）也要壓灰
    expect(colors.floorBadge).not.toBe('rgb(255, 211, 77)');

    // 打字游標（#cursor）的顏色是 inline style，class 覆寫不到 → 必須由
    // App.onPrefChange 轉給 view.setWorkMode，否則反白輸入列（b7/b15 被壓成
    // #374151）上的游標仍是原生反色 #3F3F3F，對比 ≈1.0 等於隱形。
    // 上班模式下游標與 bg 無關（cursor_color.js 的固定淺灰），故不依賴畫面內容。
    await expect(page.locator('#cursor')).toHaveCSS('color', 'rgb(229, 231, 235)');
    // 游標本體是一條 currentColor 的直線 ＋ 一圈 box-shadow 光暈（main.css #cursor）：
    // 低彩度的上班模式畫面尤其需要，否則細線很難一眼定位。形狀／幾何另在
    // cursor_shape.offline.spec.js 守。
    const cursorPaint = await page.evaluate(() => {
      const cs = getComputedStyle(document.getElementById('cursor'));
      return { bg: cs.backgroundColor, color: cs.color, shadow: cs.boxShadow };
    });
    expect(cursorPaint.bg).toBe(cursorPaint.color);
    expect(cursorPaint.shadow).not.toBe('none');

    // 持久化：重新整理後 class 仍在（onValuesPrefChange 啟動即套用）。
    const saved = await page.evaluate(() =>
      JSON.parse(window.localStorage.getItem('pttchrome.pref.v1')).values.enableWorkMode
    );
    expect(saved).toBe(true);
  });

  test('InputHelper：從選單開啟並完成 render（顏色盤 + 送出鈕）', async ({ page }) => {
    await installReplay(page);
    await page.goto('/');
    await waitConnected(page);

    await openInputHelper(page);

    // InputHelperModal 出現（顏色盤 + 送出 SplitButton 為 marker）。
    // 這些元件（Modal/Tab/Nav/NavDropdown/SplitButton）若遷移後 render 崩潰，
    // modal 根本不會出現 → 這條會紅，即為守門。NavDropdown 內部切換太脆弱不在此測，
    // Tab.Container 行為由 PrefModal 分頁測試承接（同 API）。
    await expect(page.locator('.InputHelperModal__ColorList')).toBeVisible();
    const sendText = await label(page, 'colorHelperSend');
    await expect(
      page.locator('.InputHelperModal__Dialog').getByText(sendText, { exact: true })
    ).toBeVisible();
  });

  // ===== 基本 UI 不變式：換任何 UI 庫／CSS 都該維持，故以行為斷言守門 =====

  // 開啟設定（PrefModal），回傳左欄 nav locator。
  async function openSettings(page) {
    await waitConnected(page);
    await openContextMenu(page);
    await page.locator('.DropdownMenu').first()
      .getByText(await label(page, 'cmenu_settings'), { exact: true }).click();
    await expect(page.locator('.PrefModal')).toBeVisible();
    return page.locator('.PrefModal__Grid__Col--left');
  }

  // 迴歸守護（回報：PTT 維護期間開設定頁，欄位完全打不了字）。
  // ConnectionAlert 原本在 window capture 階段對**所有** keydown 做 preventDefault +
  // stopImmediatePropagation，斷線後只要它掛著，整個網頁的 UI 就都收不到鍵盤；而且在
  // 對話框裡按 Enter 會意外觸發重連。PTT 平常很少斷線，所以一直沒被發現。
  // 純鍵盤界線守在 tests/unit/connection_alert_keys.test.jsx，這裡守症狀。
  //
  // 注意這條是「**先連上再斷線**」（下方有 waitConnected）：view.conn 是已關閉的
  // TelnetConnection，send() 依規範是 no-op。「**從未連上**」（view.conn === undefined）
  // 是另一條路徑、另一組 bug，守在 connect_failure.offline.spec.js —— 別把兩者搞混，
  // 這條綠不代表那條也綠（實例：a37a511 修完這條，那條仍整頁卡死）。
  test('斷線提示掛著時：設定頁仍能打字，Enter 不會意外重連', async ({ page }) => {
    await installReplay(page);
    await page.goto('/');
    await waitConnected(page);

    // 斷線 → ConnectionAlert 出現（stub WS 的 close 會走 App.onClose）。
    await page.evaluate(() => window.__stubWS.close());
    const alert = page.locator('.PageTopAlert')
      .filter({ hasText: await label(page, 'alert_connectionHeader') });
    await expect(alert).toBeVisible();

    // 斷線狀態下開設定頁 → 連線分頁
    await openContextMenu(page);
    await page.locator('.DropdownMenu').first()
      .getByText(await label(page, 'cmenu_settings'), { exact: true }).click();
    await expect(page.locator('.PrefModal')).toBeVisible();
    await page.locator('.PrefModal__Grid__Col--left')
      .getByText(await label(page, 'options_connection'), { exact: true }).click();

    // 逐鍵輸入（fill 不會發 keydown，測不到這個 bug）。
    const url = page.locator('.PrefModal input[name="imgurProxyUrl"]');
    await expect(url).toBeVisible();
    await url.click();
    await url.pressSequentially('my.example.dev');
    await expect(url).toHaveValue('my.example.dev');

    // 在欄位裡按 Enter 不該被當成「重新連線」→ 提示仍在、設定頁沒被踢掉。
    await url.press('Enter');
    await expect(alert).toBeVisible();
    await expect(page.locator('.PrefModal')).toBeVisible();
  });

  const modalWidth = async (page) =>
    Math.round((await page.locator('.PrefModal').boundingBox()).width);

  test('設定頁：切換分頁寬度不變', async ({ page }) => {
    await installReplay(page);
    await page.goto('/');
    const nav = await openSettings(page);

    const wGeneral = await modalWidth(page);
    await nav.getByText(await label(page, 'options_enhance'), { exact: true }).click();
    await expect(page.locator('.PrefModal textarea[name="blacklist"]')).toBeVisible();
    const wEnhance = await modalWidth(page);
    await nav.getByText(await label(page, 'options_about'), { exact: true }).click();
    const wAbout = await modalWidth(page);

    expect(Math.abs(wEnhance - wGeneral)).toBeLessThanOrEqual(1);
    expect(Math.abs(wAbout - wGeneral)).toBeLessThanOrEqual(1);
  });

  test('設定頁：視窗變寬 → 對話框變寬，且有上限', async ({ page }) => {
    await installReplay(page);
    await page.goto('/');
    await page.setViewportSize({ width: 700, height: 800 });
    await openSettings(page);

    const wNarrow = await modalWidth(page);
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.waitForTimeout(100);
    const wWide = await modalWidth(page);

    expect(wWide).toBeGreaterThan(wNarrow); // 空間夠就變寬
    expect(wWide).toBeLessThanOrEqual(920); // 但有上限（size=900px + 邊距餘裕）
  });

  test('設定頁：點空白處（overlay）關閉', async ({ page }) => {
    await installReplay(page);
    await page.goto('/');
    await openSettings(page);

    await page.locator('.mantine-Modal-overlay').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.PrefModal')).toBeHidden();
  });

  // 文字色 ≠ 實際可見底色（往上找第一個非透明祖先）→ 防白底白字／黑底黑字。
  async function expectReadable(locator) {
    const { color, bg } = await locator.evaluate((el) => {
      const transparent = (c) =>
        !c || c === 'transparent' || /^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(c);
      let node = el;
      let bg = 'rgb(0, 0, 0)';
      while (node) {
        const c = getComputedStyle(node).backgroundColor;
        if (!transparent(c)) { bg = c; break; }
        node = node.parentElement;
      }
      return { color: getComputedStyle(el).color, bg };
    });
    expect(color).not.toBe(bg);
  }

  test('UI 文字：輸入小幫手符號格文字色 ≠ 底色（防白底白字）', async ({ page }) => {
    await installReplay(page);
    await page.goto('/');
    await waitConnected(page);

    await openInputHelper(page);
    const dialog = page.locator('.InputHelperModal__Dialog');

    // 開「符號」群組下拉 → 選「一般」→ 出現符號格
    await dialog.getByText(await label(page, 'symTitle'), { exact: true }).click();
    await page.getByText(await label(page, 'symTitle_general'), { exact: true }).click();
    const cell = page.locator('.InputHelperModal__SymbolList > li').first();
    await expect(cell).toBeVisible();
    await expectReadable(cell);
  });

  // 之前的「防白底白字」只查 InputHelper 一個元素、且只在預設「暗色」主題跑 → 抓不到
  // 「淺色主題下純 HTML 繼承 body 白字」這種破法（白字白底只在淺色才現形）。這條補上：
  // 強制淺色主題，逐一檢查 PrefModal 代表性純文字（legend/label/nav/about code）皆可讀。
  test('UI 文字：淺色主題下設定頁文字可讀（防 body 白字 hardcode 繼承）', async ({ page }) => {
    await page.addInitScript(() =>
      window.localStorage.setItem('mantine-color-scheme-value', 'light'),
    );
    await installReplay(page);
    await page.goto('/');
    const nav = await openSettings(page);

    await expectReadable(page.locator('.PrefModal legend').first()); // 區段標題
    await expectReadable(page.locator('.PrefModal label').first()); // 欄位標籤
    await expectReadable(
      nav.getByText(await label(page, 'options_general'), { exact: true }),
    ); // 左欄分頁

    // about 分頁的純 HTML（<li>/<code>）也要可讀
    await nav.getByText(await label(page, 'options_about'), { exact: true }).click();
    await expectReadable(page.locator('.PrefModal__about-selectable li').first());
  });

  // 回歸：Mantine 圖示是 <svg>，其 className 是 SVGAnimatedString（物件），App.mouse_down
  // → checkClass 直接 .indexOf 會 `cn.indexOf is not a function`。mouse_down 綁在 window 且
  // 有 `if (modalShown) return`，故要用「非 modal」的浮層（InputHelper Paper）來觸發。
  test('滑鼠事件：點到 Mantine 圖示(SVG) 不崩潰（checkClass 守門）', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => {
      if (!/ResizeObserver loop/.test(e.message)) errors.push(e.message);
    });
    await installReplay(page);
    await page.goto('/');
    await waitConnected(page);

    await openInputHelper(page);

    // 直接在 SVG 上派發 mousedown（e.target=SVG）→ window mousedown → App.mouse_down
    // → checkClass(SVGAnimatedString)。修正前會 throw（pageerror）。
    await page.evaluate(() => {
      const svg = document.querySelector('.InputHelperModal__Dialog svg');
      if (!svg) throw new Error('InputHelper 內找不到 SVG，測試前提失效');
      svg.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await page.waitForTimeout(50);
    expect(errors, errors.join('\n')).toHaveLength(0);
  });

  // 新功能：主題切換（PrefModal 外觀區 SegmentedControl）實際改變 color scheme。
  test('設定頁：主題切換改變 color scheme（淺/暗）', async ({ page }) => {
    await installReplay(page);
    await page.goto('/');
    const modal = page.locator('.PrefModal');
    await openSettings(page);
    const scheme = () =>
      page.evaluate(() =>
        document.documentElement.getAttribute('data-mantine-color-scheme'),
      );

    await modal.getByText(await label(page, 'options_themeLight'), { exact: true }).click();
    await expect.poll(scheme).toBe('light');
    await modal.getByText(await label(page, 'options_themeDark'), { exact: true }).click();
    await expect.poll(scheme).toBe('dark');
  });

  // 回歸：doCopy 由 execCommand('copy')+DOM copy 事件攔截改為
  // navigator.clipboard.writeText 後，真瀏覽器的「選取 → 右鍵複製 → 系統剪貼簿」
  // 全鏈必須仍通。jsdom 驗不到 Clipboard API 的 secure context/權限行為，只能在此守。
  test('右鍵選單「複製」：選取文字後寫入系統剪貼簿', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await installReplay(page);
    await page.goto('/');
    await waitConnected(page);

    await feedRaw(page, '\x1b[2J\x1b[HCOPYSMOKE');
    await page.waitForTimeout(200);

    // 程式化選取畫面上的字，再直接派發 contextmenu（真滑鼠右鍵的 mousedown 落點
    // 若在選取範圍外會先收合選取，headless 下座標對位太脆）。ContextMenu 的
    // handler 讀的是事件當下的 window.getSelection()，與拖曳選取等價。
    await page.evaluate(() => {
      const walker = document.createTreeWalker(
        document.getElementById('mainContainer'), NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode()); ) {
        const idx = node.textContent.indexOf('COPYSMOKE');
        if (idx < 0) continue;
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + 'COPYSMOKE'.length);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.getElementById('BBSWindow').dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 10 }));
        return;
      }
      throw new Error('COPYSMOKE 未渲染到畫面，測試前提失效');
    });

    const menu = page.locator('.DropdownMenu').first();
    await expect(menu).toBeVisible();
    await menu.getByText(await label(page, 'cmenu_copy'), { exact: true }).click();

    await expect
      .poll(() =>
        page.evaluate(() => navigator.clipboard.readText().catch(() => '')))
      .toContain('COPYSMOKE');
  });
});
