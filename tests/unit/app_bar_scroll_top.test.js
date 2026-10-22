// @unit-env browser
// 手機 App Bar 點標題捲回頂端：捲對容器、已在頂端不動、列表一律走 screen.scrollListTo。
// 真 CSS／真 tap 的整條路徑在 tests/e2e/offline/mobile_app_bar.offline.spec.js。
import { scrollContentToTop } from '../../src/js/app_bar_scroll_top';
import { HOME_DASHBOARD_ID } from '../../src/js/home_dashboard';

// 真的可以捲的盒子：給高度＋overflow，內容比它高。
function scroller(id) {
  const el = document.createElement('div');
  if (id) el.id = id;
  el.style.cssText = 'height:100px;overflow-y:auto';
  const inner = document.createElement('div');
  inner.style.height = '1000px';
  el.appendChild(inner);
  document.body.appendChild(el);
  return el;
}

function fakeListScreen(top) {
  return {
    hasListViewport: () => true,
    getListScrollTop: () => top,
    scrollListTo: vi.fn(),
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('scrollContentToTop', () => {
  test('首頁儀表板開著 ⇒ 捲它自己的容器，不碰列表與 mainDisplay', () => {
    const home = scroller(HOME_DASHBOARD_ID);
    // 真的面板是 position:fixed（offsetParent 恆為 null），曾被誤判成「沒開」。
    Object.assign(home.style, { position: 'fixed', top: '0', left: '0', width: '200px' });
    home.scrollTop = 300;
    const main = scroller();
    main.scrollTop = 200;
    const screen = fakeListScreen(500);
    const r = scrollContentToTop({
      doc: document,
      view: { componentScreen: screen, mainDisplay: main },
      reducedMotion: true,
    });
    expect(r).toBe('home');
    expect(home.scrollTop).toBe(0);
    expect(main.scrollTop).toBe(200);
    expect(screen.scrollListTo).not.toHaveBeenCalled();
  });

  test('首頁收起（display:none）⇒ 不算；列表視口在 ⇒ scrollListTo(0)', () => {
    const home = scroller(HOME_DASHBOARD_ID);
    home.style.display = 'none';
    const screen = fakeListScreen(480);
    const main = scroller();
    main.scrollTop = 50;
    expect(
      scrollContentToTop({
        doc: document,
        view: { componentScreen: screen, mainDisplay: main },
        reducedMotion: false,
      })
    ).toBe('list');
    expect(screen.scrollListTo).toHaveBeenCalledWith(0, 'smooth');
    expect(main.scrollTop).toBe(50);
  });

  test('reduced-motion ⇒ 列表直接跳（不帶 smooth）', () => {
    const screen = fakeListScreen(480);
    scrollContentToTop({ doc: document, view: { componentScreen: screen }, reducedMotion: true });
    expect(screen.scrollListTo).toHaveBeenCalledWith(0, undefined);
  });

  test('列表已在頂端 ⇒ 什麼都不做（不會誤捲到 mainDisplay）', () => {
    const screen = fakeListScreen(0);
    const main = scroller();
    main.scrollTop = 120;
    expect(
      scrollContentToTop({
        doc: document,
        view: { componentScreen: screen, mainDisplay: main },
        reducedMotion: true,
      })
    ).toBe(null);
    expect(screen.scrollListTo).not.toHaveBeenCalled();
    expect(main.scrollTop).toBe(120);
  });

  test('列表視口不在 DOM（在文章裡）⇒ 捲 mainDisplay', () => {
    const screen = { ...fakeListScreen(300), hasListViewport: () => false };
    const main = scroller();
    main.scrollTop = 400;
    expect(
      scrollContentToTop({
        doc: document,
        view: { componentScreen: screen, mainDisplay: main },
        reducedMotion: true,
      })
    ).toBe('main');
    expect(main.scrollTop).toBe(0);
    expect(screen.scrollListTo).not.toHaveBeenCalled();
  });

  test('沒有可捲的東西 ⇒ null，不丟例外', () => {
    expect(scrollContentToTop({ doc: document, view: null, reducedMotion: true })).toBe(null);
    const main = scroller();
    expect(scrollContentToTop({ doc: document, view: { mainDisplay: main }, reducedMotion: true })).toBe(null);
  });
});
