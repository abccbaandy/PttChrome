// @unit-env browser
// real-input: tests/e2e/offline/easy_reading_reverse.offline.spec.js
//   （真滾輪放手（反向期間停在 head 讀的人）；本檔手捏事件只測分支邏輯，見 tests/unit/e2e_real_input.test.js）
// 好讀按 End 之後黏在文末（src/js/bottom_stick.js）。真瀏覽器的症狀守在 offline
// easy_reading_reverse.offline.spec.js「文末有圖」；這裡鎖放手條件。
import { createBottomStick } from '../../src/js/bottom_stick';

let observers;
class FakeRO {
  constructor(cb) { this.cb = cb; this.targets = []; observers.push(this); }
  observe(t) { this.targets.push(t); }
  disconnect() { this.targets = []; this.disconnected = true; }
}

// 真版面（unit-browser）：視窗 100px、內容一開始 1000px ⇒ 底部＝scrollTop 900。
// ResizeObserver 仍用替身：真的 RO 在下一幀才回呼，測試要同步控制「長高」那一刻。
const VIEW = 100;
function setup() {
  const scroller = document.createElement('div');
  scroller.style.cssText = `height: ${VIEW}px; overflow-y: auto`;
  const content = document.createElement('div');
  scroller.appendChild(content);
  document.body.appendChild(scroller);
  let h = 1000;
  content.style.height = h + 'px';
  const stick = createBottomStick({ scroller, content });
  const grow = (dh) => {
    h += dh;
    content.style.height = h + 'px';
    observers.forEach((o) => o.targets.length && o.cb([]));
  };
  return { scroller, stick, grow };
}
const bottom = (h) => h - VIEW;

beforeEach(() => {
  observers = [];
  vi.stubGlobal('ResizeObserver', FakeRO);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

test('engage 捲到底；內容之後長高仍貼底', () => {
  const { scroller, stick, grow } = setup();
  stick.engage();
  expect(scroller.scrollTop).toBe(bottom(1000));
  grow(500);
  expect(scroller.scrollTop).toBe(bottom(1500));
});

test.each(['wheel', 'pointerdown', 'touchstart'])('讀者輸入（%s）放手，之後長高不再拉回', (type) => {
  const { scroller, stick, grow } = setup();
  stick.engage();
  scroller.dispatchEvent(new Event(type));
  expect(stick.engaged).toBe(false);
  scroller.scrollTop = 200;
  grow(500);
  expect(scroller.scrollTop).toBe(200);
  expect(observers.every((o) => o.disconnected)).toBe(true);
});

test('scroll 事件不放手（程式自己的捲動、anchoring 補償也會發 scroll）', () => {
  const { scroller, stick, grow } = setup();
  stick.engage();
  scroller.scrollTop = 10;
  scroller.dispatchEvent(new Event('scroll'));
  expect(stick.engaged).toBe(true);
  grow(300);
  expect(scroller.scrollTop).toBe(bottom(1300));
});

test('重複 engage 不疊 observer', () => {
  const { stick } = setup();
  stick.engage();
  stick.engage();
  expect(observers.length).toBe(1);
});
