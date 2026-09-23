// 防閒置（keep-alive）與半開斷線偵測的決策——純函式，App.antiIdle 每秒呼叫一次。
//
// 規格：PTT 站方公告（PttCurrent 2026-09-23「連線保持與防閒置實作建議」）
// - 送 IAC DO TIMING-MARK（TelnetConnection.sendTimingMark），server 回 IAC WONT TM。
// - 使用者有正常輸入就重置計時 ⇒ 計時基準是「最後一次送出」（任何送出都算，
//   probe 本身也是）。
// - 沒收到回應可判定半開斷線 ⇒ probe 後 timeoutMs 內沒收到任何 bytes 就 'dead'。
//
// 回應判定用「probe 之後有收到任何東西」而非比對 WONT TM：畫面資料同樣證明
// 對方活著，而且 server 要是沒吃 TM 也不會誤判。lastRecvAt 必須嚴格大於 probeAt。
//
// 逾時 30 秒：行動網路 RTT 偶爾到秒級、背景分頁的 timer 也會被瀏覽器節流到
// 每秒一次以上，留足餘裕避免把慢網路誤判成斷線（誤判的代價是整條連線被收掉）。
export const KEEP_ALIVE_TIMEOUT_MS = 30000;

export function decideKeepAlive(s) {
  if (!(s.intervalMs > 0)) return { action: null };
  if (s.probeAt != null && !(s.lastRecvAt > s.probeAt)) {
    return { action: s.now - s.probeAt >= s.timeoutMs ? 'dead' : null };
  }
  return { action: s.now - s.lastSendAt >= s.intervalMs ? 'probe' : null };
}
