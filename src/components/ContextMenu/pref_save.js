// 設定頁（PrefModal）關閉時的副作用套用 —— 抽成純邏輯模組是為了能在 tests/unit 守護
// 「副作用失敗也一定關得掉」這條不變量（tests/unit/pref_save_close.test.js）。
//
// 為什麼要 try/catch：X／點空白處／Esc 全部匯流到同一個 onClose，若這裡任何一步 throw，
// 呼叫端的 update({ showsSettings:false }) 就不會執行 → 對話框永遠關不掉。實例：連線
// 從未成功時 view.conn 是 undefined，switchToEasyReadingMode 曾在此 TypeError。
// （根因已修，但關閉路徑不該再依賴任何副作用成功。）
//
// 注意這裡**不碰** pttchrome.modalShown / setInputAreaFocus：那由 ContextMenu 依 render
// state 推導後呼叫 App.setModalOpen 統一負責，見 ./index.jsx。
export const onPrefSaveImpl = (pttchrome, values) => {
  try {
    pttchrome.onValuesPrefChange(values);
    pttchrome.switchToEasyReadingMode(pttchrome.view.useEasyReadingMode);
  } catch (e) {
    console.error("onPrefSave: 套用偏好時出錯（設定頁仍會關閉）", e);
  }

  return {
    showsSettings: false,
  };
};
