/** @jest-environment jsdom */
// Guards the hammerjs → Pointer Events replacement (src/js/touch_controller.js):
// tap vs pan discrimination and the "ignore non-touch pointers" rule. Uses a
// fake app + fake BBSWin that just records addEventListener handlers, so no real
// PointerEvent / gesture library is needed.
import { TouchController } from '../../src/js/touch_controller';

function makeApp() {
  const listeners = {};
  const BBSWin = {
    style: { cursor: '' },
    addEventListener: (type, fn) => {
      (listeners[type] = listeners[type] || []).push(fn);
    }
  };
  const app = {
    BBSWin,
    inputArea: { blur: jest.fn(), focus: jest.fn() },
    // pageState 2 = list-highlight state (where pan/tap act).
    buf: { pageState: 2, highlightCursor: false, nowHighlight: -1 },
    onMouse_move: jest.fn(),
    onMouse_click: jest.fn()
  };
  return { app, listeners };
}

const ptr = (o) =>
  Object.assign({ pointerType: 'touch', pointerId: 1, preventDefault() {} }, o);

const fire = (listeners, type, ev) =>
  (listeners[type] || []).forEach((fn) => fn(ev));

test('tap：短距離短時間觸控 → onMouse_click 選取該點並 focus 回輸入區', () => {
  const { app, listeners } = makeApp();
  new TouchController(app);
  fire(listeners, 'pointerdown', ptr({ clientX: 10, clientY: 10 }));
  fire(listeners, 'pointerup', ptr({ clientX: 11, clientY: 11 }));
  expect(app.onMouse_click).toHaveBeenCalledWith(11, 11);
  expect(app.inputArea.focus).toHaveBeenCalled();
});

test('pan：拖曳超過閾值 → onMouse_move 更新位置，pointerup 不當成 tap click', () => {
  const { app, listeners } = makeApp();
  new TouchController(app);
  fire(listeners, 'pointerdown', ptr({ clientX: 10, clientY: 10 }));
  fire(listeners, 'pointermove', ptr({ clientX: 40, clientY: 10 }));
  expect(app.onMouse_move).toHaveBeenCalledWith(40, 10);
  fire(listeners, 'pointerup', ptr({ clientX: 40, clientY: 10 }));
  expect(app.onMouse_click).not.toHaveBeenCalled();
});

test('非 touch pointer（滑鼠）被忽略，交給桌面 mouse handler', () => {
  const { app, listeners } = makeApp();
  new TouchController(app);
  fire(listeners, 'pointerdown', ptr({ pointerType: 'mouse', clientX: 10, clientY: 10 }));
  fire(listeners, 'pointerup', ptr({ pointerType: 'mouse', clientX: 10, clientY: 10 }));
  expect(app.onMouse_click).not.toHaveBeenCalled();
  expect(app.onMouse_move).not.toHaveBeenCalled();
});
