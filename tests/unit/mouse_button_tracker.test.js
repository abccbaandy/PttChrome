import { MouseButtonTracker } from '../../src/js/mouse_button_tracker';

describe('MouseButtonTracker', () => {
  let t;
  beforeEach(() => {
    t = new MouseButtonTracker();
  });

  test('初始狀態：左右鍵皆未按下', () => {
    expect(t.left).toBe(false);
    expect(t.right).toBe(false);
  });

  test('右鍵按下→放開的正常狀態流', () => {
    t.onMouseDown(2);
    expect(t.right).toBe(true);
    t.onMouseUp(2);
    expect(t.right).toBe(false);
  });

  test('左鍵按下→放開的正常狀態流', () => {
    t.onMouseDown(0);
    expect(t.left).toBe(true);
    t.onMouseUp(0);
    expect(t.left).toBe(false);
  });

  test('中鍵(1)不影響左右鍵狀態', () => {
    t.onMouseDown(1);
    t.onMouseUp(1);
    expect(t.left).toBe(false);
    expect(t.right).toBe(false);
  });

  test('mouseup 丟失（失焦）後 reset() 復原', () => {
    t.onMouseDown(2);
    t.onMouseDown(0);
    t.reset();
    expect(t.right).toBe(false);
    expect(t.left).toBe(false);
  });

  test('syncFromButtons(0) 自癒卡住的右鍵：滾輪事件回報無按鍵', () => {
    t.onMouseDown(2); // mouseup 丟失，旗標卡在 true
    t.syncFromButtons(0);
    expect(t.right).toBe(false);
  });

  test('syncFromButtons 依 bitmask 同步：右鍵按住(bit1)保持 true', () => {
    t.onMouseDown(2);
    t.syncFromButtons(2); // 右鍵仍按著
    expect(t.right).toBe(true);
    expect(t.left).toBe(false);
  });

  test('syncFromButtons 可補上漏掉的 mousedown：左鍵(bit0)', () => {
    t.syncFromButtons(1);
    expect(t.left).toBe(true);
    expect(t.right).toBe(false);
  });

  test('syncFromButtons(undefined) 不動作（舊 mousewheel 事件無 buttons）', () => {
    t.onMouseDown(2);
    t.syncFromButtons(undefined);
    expect(t.right).toBe(true);
  });
});
