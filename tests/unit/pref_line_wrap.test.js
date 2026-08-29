import { App } from '../../src/js/pttchrome';
import { normalizePasteText } from '../../src/js/string_util';

// 「自動斷行」(lineWrap) 這個 pref 從設定頁到消費端的接線。
//
// 為什麼要守：onPrefChange 曾經把值寫進 `this.conn.lineWrap`，但那個欄位**沒有任何
// 讀取點** —— 真正會讀的是 term_view.onTextInput 的 `this.lineWrap` 與
// list_session.onPaste 的 `this._view.lineWrap`。⇒ 設定頁怎麼改都沒作用，永遠停在
// term_view.js 建構時硬寫的 78；而且 conn 每次重連都會被換掉，寫進去的值本來就留不住。
// onPrefChange 整個包在 `try { ... } catch { /* eats all errors */ }` 裡，所以這種
// 接錯線不會有任何錯誤訊息，只能靠測試釘住。
describe('lineWrap pref → 消費端', () => {
  const makeApp = () => {
    const app = Object.create(App.prototype);
    app.view = { lineWrap: 78 };
    // 接錯線的年代寫的是這個物件；留著才驗得出「沒有再被寫」。
    app.conn = {};
    return app;
  };

  test('onPrefChange 把值送到 view.lineWrap（term_view/list_session 的讀取點）', () => {
    const app = makeApp();
    app.onPrefChange('lineWrap', 40);
    expect(app.view.lineWrap).toBe(40);
  });

  test('不寫進 conn —— 那裡沒有讀取點，且重連就沒了', () => {
    const app = makeApp();
    app.onPrefChange('lineWrap', 40);
    expect(app.conn.lineWrap).toBeUndefined();
  });

  test('接對線之後，貼上折行寬度真的跟著 pref 走', () => {
    const app = makeApp();
    app.onPrefChange('lineWrap', 5);
    // wrapText 不切開單字，斷點落在字組邊界
    expect(normalizePasteText('ab cd ef', app.view.lineWrap)).toBe('ab \rcd ef');
  });
});
