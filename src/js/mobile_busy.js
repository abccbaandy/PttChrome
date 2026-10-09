// 手機 App Bar 底邊的「等待 PTT 回應」進度條 —— 純狀態機，零 DOM、零計時器
// （計時器在 App._busyEvent）。docs/mobile.md「等待進度條」。
//
// 為什麼要三段事件而不是「按了就亮」：
//   action  我們自己的 UI（底部導覽／按鍵面板／選單大按鈕／列表卡片 tap）剛被按。
//   sent    telnet 的資料出口真的送出 byte（TelnetConnection.onDataSent）。
//           只有 action 之後 BUSY_ACTION_WINDOW_MS 內的 sent 才算 ⇒ 列表好讀的 PgDn
//           是本地捲動、不送 byte，不會誤亮；實體鍵盤／程式化序列沒有 action，也不亮。
//   settled 畫面 settle（buf 的 screenSettled）＝ server 回應了。
// 送出後 BUSY_SHOW_DELAY_MS 才顯示（快速回應不閃一下）；PTT 對不認得的鍵不回應 ⇒
// BUSY_TIMEOUT_MS 後自己收，不會轉到天荒地老。
export const BUSY_ACTION_WINDOW_MS = 500;
export const BUSY_SHOW_DELAY_MS = 300;
export const BUSY_TIMEOUT_MS = 3000;

export const BUSY_IDLE = Object.freeze({ phase: 'idle', since: null, actionAt: null });

export function busyNext(state, ev) {
  const s = state || BUSY_IDLE;
  if (!ev) return s;
  switch (ev.type) {
    case 'action':
      return { ...s, actionAt: ev.t };
    case 'sent':
      if (s.actionAt == null || ev.t - s.actionAt > BUSY_ACTION_WINDOW_MS) return s;
      // 已經在等了（一次 tap 送出好幾段）就不重設起點。
      if (s.phase !== 'idle') return { ...s, actionAt: null };
      return { phase: 'pending', since: ev.t, actionAt: null };
    case 'settled':
      return s.phase === 'idle' ? s : { ...s, phase: 'idle', since: null };
    case 'tick':
      if (s.phase === 'idle') return s;
      if (ev.t - s.since >= BUSY_TIMEOUT_MS) return { ...s, phase: 'idle', since: null };
      if (s.phase === 'pending' && ev.t - s.since >= BUSY_SHOW_DELAY_MS)
        return { ...s, phase: 'shown' };
      return s;
    default:
      return s;
  }
}

export function isBusyShown(state) {
  return !!state && state.phase === 'shown';
}
