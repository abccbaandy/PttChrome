// @vitest-environment jsdom
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

function setup() {
  const scroller = document.createElement('div');
  const content = document.createElement('div');
  scroller.appendChild(content);
  let h = 1000;
  Object.defineProperty(scroller, 'scrollHeight', { get: () => h });
  const stick = createBottomStick({ scroller, content });
  const grow = (dh) => { h += dh; observers.forEach((o) => o.targets.length && o.cb([])); };
  return { scroller, stick, grow };
}

beforeEach(() => {
  observers = [];
  vi.stubGlobal('ResizeObserver', FakeRO);
});
afterEach(() => vi.unstubAllGlobals());

test('engage 捲到底；內容之後長高仍貼底', () => {
  const { scroller, stick, grow } = setup();
  stick.engage();
  expect(scroller.scrollTop).toBe(1000);
  grow(500);
  expect(scroller.scrollTop).toBe(1500);
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
  expect(scroller.scrollTop).toBe(1300);
});

test('重複 engage 不疊 observer', () => {
  const { stick } = setup();
  stick.engage();
  stick.engage();
  expect(observers.length).toBe(1);
});
