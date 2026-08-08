import { onPrefSaveImpl } from '../../src/components/ContextMenu/pref_save';

// 不變量：設定頁的關閉指令（showsSettings:false）**不得**依賴任何副作用成功。
// 迴歸來源：PTT 連線失敗（view.conn === undefined）時 switchToEasyReadingMode 會 throw，
// 呼叫端的 update({showsSettings:false}) 因此沒跑 → X／點空白處／Esc 都關不掉設定頁。
// 症狀層守護在 tests/e2e/offline/connect_failure.offline.spec.js。
describe('onPrefSaveImpl', () => {
  const makePttchrome = (overrides = {}) => ({
    onValuesPrefChange: vi.fn(),
    switchToEasyReadingMode: vi.fn(),
    view: { useEasyReadingMode: true },
    ...overrides,
  });

  let errSpy;
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  test('正常路徑：兩個副作用都跑，回傳關閉指令', () => {
    const pttchrome = makePttchrome();
    const values = { copyOnSelect: true };

    expect(onPrefSaveImpl(pttchrome, values)).toEqual({ showsSettings: false });
    expect(pttchrome.onValuesPrefChange).toHaveBeenCalledWith(values);
    expect(pttchrome.switchToEasyReadingMode).toHaveBeenCalledWith(true);
    expect(errSpy).not.toHaveBeenCalled();
  });

  test('switchToEasyReadingMode throw（view.conn undefined）仍回傳關閉指令', () => {
    const pttchrome = makePttchrome({
      switchToEasyReadingMode: vi.fn(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'send')");
      }),
    });

    expect(onPrefSaveImpl(pttchrome, {})).toEqual({ showsSettings: false });
    expect(errSpy).toHaveBeenCalled();
  });

  test('onValuesPrefChange throw 仍回傳關閉指令', () => {
    const pttchrome = makePttchrome({
      onValuesPrefChange: vi.fn(() => {
        throw new Error('boom');
      }),
    });

    expect(onPrefSaveImpl(pttchrome, {})).toEqual({ showsSettings: false });
    expect(errSpy).toHaveBeenCalled();
  });

  test('不碰 modalShown／setInputAreaFocus（改由 ContextMenu 依 render state 推導）', () => {
    const setInputAreaFocus = vi.fn();
    const pttchrome = makePttchrome({ modalShown: true, setInputAreaFocus });

    onPrefSaveImpl(pttchrome, {});

    expect(pttchrome.modalShown).toBe(true);
    expect(setInputAreaFocus).not.toHaveBeenCalled();
  });
});
