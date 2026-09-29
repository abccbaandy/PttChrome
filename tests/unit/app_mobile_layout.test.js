import { App } from '../../src/js/pttchrome';

// App 的手機模式接線（applyMobileLayout／toggleSoftKeyboard，docs/mobile.md）。
// 症狀：手機上 tap 畫面會同時觸發滑鼠瀏覽點擊與叫出軟鍵盤。修法是 #t 的
// inputmode="none"——焦點照舊（十幾個 setInputAreaFocus 呼叫點不動），但 focus
// 不叫鍵盤；軟鍵盤只由按鍵列的鍵盤鈕叫出。
describe('App 手機模式', () => {
  let input;
  const makeApp = ({ mode = 'on' } = {}) => {
    const app = Object.create(App.prototype);
    app.mobileLayoutMode = mode;
    app.mobile = false;
    app.softKeyboard = false;
    app.modalShown = false;
    app._mobileListeners = new Set();
    app.inputArea = input;
    return app;
  };

  beforeEach(() => {
    input = document.createElement('input');
    document.body.appendChild(input);
  });
  afterEach(() => {
    input.remove();
    document.body.classList.remove('mobile-layout');
  });

  test('手機：#t inputmode=none、body 掛 mobile-layout、通知訂閱者', () => {
    const app = makeApp({ mode: 'on' });
    const seen = [];
    app.onMobileChange((m) => seen.push(m));
    app.applyMobileLayout();
    expect(app.mobile).toBe(true);
    expect(input.getAttribute('inputmode')).toBe('none');
    expect(document.body.classList.contains('mobile-layout')).toBe(true);
    expect(seen).toEqual([true]);
    // 沒變化不重複通知
    app.applyMobileLayout();
    expect(seen).toEqual([true]);
  });

  test('非手機：不留 inputmode（桌機零改動）', () => {
    const app = makeApp({ mode: 'off' });
    input.setAttribute('inputmode', 'none');
    app.applyMobileLayout();
    expect(app.mobile).toBe(false);
    expect(input.hasAttribute('inputmode')).toBe(false);
    expect(document.body.classList.contains('mobile-layout')).toBe(false);
  });

  test('鍵盤鈕：切成 text 並重新 focus，再按一次切回 none', () => {
    const app = makeApp({ mode: 'on' });
    app.applyMobileLayout();
    expect(app.toggleSoftKeyboard()).toBe(true);
    expect(input.getAttribute('inputmode')).toBe('text');
    expect(document.activeElement).toBe(input);
    expect(app.toggleSoftKeyboard()).toBe(false);
    expect(input.getAttribute('inputmode')).toBe('none');
    expect(document.activeElement).toBe(input);
  });

  test('modal 開著時鍵盤鈕無效（終端機不收鍵）', () => {
    const app = makeApp({ mode: 'on' });
    app.applyMobileLayout();
    app.modalShown = true;
    expect(app.toggleSoftKeyboard()).toBe(false);
    expect(input.getAttribute('inputmode')).toBe('none');
  });

  test('離開手機模式時軟鍵盤狀態一併歸零', () => {
    const app = makeApp({ mode: 'on' });
    app.applyMobileLayout();
    app.toggleSoftKeyboard();
    app.mobileLayoutMode = 'off';
    app.applyMobileLayout();
    expect(app.softKeyboard).toBe(false);
    expect(input.hasAttribute('inputmode')).toBe(false);
  });

  test('pref mobileLayout 經 onPrefChange 生效', () => {
    const app = makeApp({ mode: 'auto' });
    app.onPrefChange('mobileLayout', 'on');
    expect(app.mobileLayoutMode).toBe('on');
    expect(app.mobile).toBe(true);
  });
});

// Phase 2：手機被切掉右半邊的成因是雲端同步把桌機的 fixed-font-size 20px
// （80 欄 ≈ 800px）帶到手機。手機模式必須無視 termSizeMode，而且**不寫回 prefs**。
describe('App 手機模式：終端機尺寸', () => {
  const synced = {
    termSizeMode: 'fixed-font-size',
    fontSize: 20,
    termSize: { cols: 80, rows: 24 },
    fontFitWindowWidth: false
  };
  let input;
  const makeApp = (mode) => {
    const app = Object.create(App.prototype);
    app.mobileLayoutMode = mode;
    app.mobile = false;
    app.softKeyboard = false;
    app.modalShown = false;
    app._mobileListeners = new Set();
    app.inputArea = input;
    app.buf = { cols: 80, rows: 24 };
    app.setTermSize = vi.fn((c, r) => { app.buf.cols = c; app.buf.rows = r; });
    app.view = {
      innerBounds: { width: 390, height: 750 },
      fixedResize: vi.fn(),
      fontResize: vi.fn(),
      redraw: vi.fn(),
      setKeyboardInset: vi.fn(),
      calcTermSizeFromFont: () => ({ cols: 80, rows: 37 }),
      // 這一幀畫的是格線畫面（非好讀長頁）；Phase 3 的 surface 由它推導。
      _gridRender: true,
      mobileSurface: 'grid',
      reflow: false,
      listCards: false,
      reflowWidth: null,
      setMobileSurface: vi.fn(function(s) {
        this.mobileSurface = s;
        this.reflow = s === 'article';
        this.listCards = s === 'list';
      })
    };
    return app;
  };
  beforeEach(() => {
    input = document.createElement('input');
    document.body.appendChild(input);
  });
  afterEach(() => {
    input.remove();
    document.body.classList.remove('mobile-layout');
  });

  test('手機：無視同步來的 fixed-font-size 20px，80 欄塞進 390px', () => {
    const app = makeApp('on');
    app.applyMobileLayout();
    app.onValuesPrefChange(synced);
    const chh = app.view.fixedResize.mock.calls.at(-1)[0];
    expect(chh).not.toBe(20);
    expect((chh / 2) * 80 + 10).toBeLessThanOrEqual(390);
    expect(app.setTermSize).toHaveBeenLastCalledWith(80, expect.any(Number));
  });

  test('手機模式關掉 ⇒ 用同一組 prefs 重套桌機規則（fixed-font-size 20px）', () => {
    const app = makeApp('on');
    app.applyMobileLayout();
    app.onValuesPrefChange(synced);
    app.mobileLayoutMode = 'off';
    app.applyMobileLayout();
    expect(app.view.fixedResize).toHaveBeenLastCalledWith(20);
    expect(app.setTermSize).toHaveBeenLastCalledWith(80, 37);
  });

  test('Phase 3：好讀文章長頁 ⇒ 換行版面（正常字級、寬＝視窗寬），列數不變（不重送 NAWS）', () => {
    const app = makeApp('on');
    app.applyMobileLayout();
    app.onValuesPrefChange(synced);
    const gridChh = app.view.fixedResize.mock.calls.at(-1)[0];
    const rows = app.buf.rows;
    const sizeCalls = app.setTermSize.mock.calls.length;
    expect(app._applyMobileGeometry('article')).toBe(true);
    const artChh = app.view.fixedResize.mock.calls.at(-1)[0];
    expect(app.view.reflow).toBe(true);
    expect(app.view.reflowWidth).toBe(390);
    expect(artChh).toBeGreaterThan(gridChh);
    expect(artChh).toBeLessThanOrEqual(16);
    expect(app.buf.rows).toBe(rows);
    // setTermSize 照呼叫，但尺寸相同 ⇒ 真實 App.setTermSize 早退、不送 NAWS
    expect(app.setTermSize.mock.calls.slice(sizeCalls).every(([c, r]) => c === 80 && r === rows)).toBe(true);
  });

  test('Phase 3–4：手機模式關掉 ⇒ 換行版面／卡片一併收掉', () => {
    const app = makeApp('on');
    app.applyMobileLayout();
    app.onValuesPrefChange(synced);
    app._applyMobileGeometry('list');
    expect(app.view.listCards).toBe(true);
    app.mobileLayoutMode = 'off';
    app.applyMobileLayout();
    expect(app.view.reflow).toBe(false);
    expect(app.view.listCards).toBe(false);
    expect(app.view.reflowWidth).toBe(null);
  });

  test('Phase 4：列表卡片同樣正常字級＋寬＝視窗寬，列數不變', () => {
    const app = makeApp('on');
    app.applyMobileLayout();
    app.onValuesPrefChange(synced);
    const rows = app.buf.rows;
    const gridChh = app.view.fixedResize.mock.calls.at(-1)[0];
    expect(app._applyMobileGeometry('list')).toBe(true);
    expect(app.view.listCards).toBe(true);
    expect(app.view.reflow).toBe(false);
    expect(app.view.reflowWidth).toBe(390);
    expect(app.view.fixedResize.mock.calls.at(-1)[0]).toBeGreaterThan(gridChh);
    expect(app.buf.rows).toBe(rows);
  });

  test('resizer（沒帶 surface）沿用上一次的畫面類型', () => {
    const app = makeApp('on');
    app.applyMobileLayout();
    app.onValuesPrefChange(synced);
    app._applyMobileGeometry('list');
    app.resizer();
    expect(app.view.setMobileSurface).toHaveBeenLastCalledWith('list');
  });

  test('prefs 載入前（建構子階段）切換手機模式不套尺寸', () => {
    const app = makeApp('on');
    app.applyMobileLayout();
    expect(app.view.fixedResize).not.toHaveBeenCalled();
  });

  test('不寫回 prefs（runtime 覆寫，prefs 會同步回桌機）', () => {
    const store = window.localStorage;
    const before = JSON.stringify(Object.entries(store));
    const app = makeApp('on');
    app.applyMobileLayout();
    app.onValuesPrefChange(synced);
    expect(JSON.stringify(Object.entries(store))).toBe(before);
  });
});

describe('App 手機模式：軟鍵盤與 visualViewport', () => {
  let input;
  let vv;
  const setVV = (height) => {
    vv.height = height;
    vv.fire();
  };
  beforeEach(() => {
    input = document.createElement('input');
    document.body.appendChild(input);
    const listeners = [];
    vv = {
      height: document.documentElement.clientHeight,
      offsetTop: 0,
      scale: 1,
      addEventListener: (_t, fn) => listeners.push(fn),
      fire: () => listeners.forEach((fn) => fn())
    };
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
    vv.height = 800;
    vi.stubGlobal('visualViewport', vv);
  });
  afterEach(() => {
    input.remove();
    vi.unstubAllGlobals();
    delete document.documentElement.clientHeight;
    document.documentElement.style.removeProperty('--kb-inset');
  });

  const makeApp = () => {
    const app = Object.create(App.prototype);
    app.mobileLayoutMode = 'on';
    app.mobile = false;
    app.softKeyboard = false;
    app._keyboardSeen = false;
    app.modalShown = false;
    app._mobileListeners = new Set();
    app.inputArea = input;
    app.view = { setKeyboardInset: vi.fn() };
    app.applyMobileLayout();
    vv.addEventListener('resize', () => app._onVisualViewport());
    return app;
  };

  test('鍵盤升起：終端機與按鍵列一起往上推', () => {
    const app = makeApp();
    app.toggleSoftKeyboard();
    setVV(480);
    expect(app.view.setKeyboardInset).toHaveBeenLastCalledWith(320);
    expect(document.documentElement.style.getPropertyValue('--kb-inset')).toBe('320px');
  });

  test('REGRESSION：Android 返回鍵收起鍵盤 ⇒ softKeyboard 歸零、inputmode 回 none、通知按鍵列', () => {
    const app = makeApp();
    const seen = [];
    app.onMobileChange((m, kb) => seen.push(kb));
    app.toggleSoftKeyboard();
    setVV(480); // 鍵盤出現
    setVV(800); // 返回鍵收起
    expect(app.softKeyboard).toBe(false);
    expect(input.getAttribute('inputmode')).toBe('none');
    expect(seen).toEqual([false]);
    expect(app.view.setKeyboardInset).toHaveBeenLastCalledWith(0);
  });

  test('剛按下鍵盤鈕、鍵盤還沒升起（inset 0）不可誤判成已收起', () => {
    const app = makeApp();
    app.toggleSoftKeyboard();
    setVV(800);
    expect(app.softKeyboard).toBe(true);
  });
});

// REGRESSION：開站時 #BBSWindow 還是 display:none，這時量到的滑鼠座標原點
// （view.firstGridOffset，offsetLeft/Top）是 0。顯示後 main.jsx 呼叫 onWindowResize，
// 但有 resizer 的模式（手機模式、桌機 fixed-font-size）會 debounce 500ms 才重量 ⇒
// 開站頭半秒點擊整片偏移（手機實測偏 3px；offline-mobile 的列表點擊測試抓到）。
describe('App.onWindowResize({ immediate })', () => {
  const makeApp = () => {
    const app = Object.create(App.prototype);
    app.mobileLayoutMode = 'off';
    app.mobile = false;
    app._mobileListeners = new Set();
    app.inputArea = document.createElement('input');
    app.view = { bbsViewMargin: 0, fontResize: vi.fn(), setKeyboardInset: vi.fn() };
    app.resizer = vi.fn();
    return app;
  };
  afterEach(() => vi.useRealTimers());

  test('一般 resize：debounce 500ms', () => {
    vi.useFakeTimers();
    const app = makeApp();
    app.onWindowResize();
    expect(app.resizer).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(app.resizer).toHaveBeenCalledTimes(1);
  });

  test('immediate：當場重算，且取消還在等的那一次（不重算兩次）', () => {
    vi.useFakeTimers();
    const app = makeApp();
    app.onWindowResize();
    app.onWindowResize({ immediate: true });
    expect(app.resizer).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(app.resizer).toHaveBeenCalledTimes(1);
  });

  test('main.jsx 顯示終端機後的那一次必須是 immediate', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'js', 'main.jsx'), 'utf8');
    const i = src.indexOf("document.getElementById('BBSWindow').style.display = ''");
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i, i + 200)).toContain('app.onWindowResize({ immediate: true })');
  });
});
