// 連線失敗診斷：直連 PTT 從未 open 時，判斷是不是被 Origin 白名單擋掉。
//
// 瀏覽器拿不到 WebSocket 握手被拒的 HTTP 403（一律只給 close 1006），頁面無從得知
// 「是 Origin 不對」還是「PTT 根本連不上」。所以主動探測：另開一條 WS 經 proxy 試連
// （open 就立刻關、不登入 ⇒ 不計入 pttbbs utmpd 的登入頻率）。決策表見
// diagnoseConnectFailure；UI 在 components/ConnectionAlert.jsx。
// 守護：tests/unit/connection_probe.test.js、connection_alert_diagnosis.test.jsx。

import { parseSite, PROTOCOL_SSH, PROTOCOL_WEBSOCKET } from './transport';

// README「方法一：安裝擴充套件」—— Origin 偽裝的設定教學。
export const ORIGIN_SETUP_URL =
  'https://github.com/abccbaandy/PttChrome#-%E6%96%B9%E6%B3%95%E4%B8%80%E5%AE%89%E8%A3%9D%E6%93%B4%E5%85%85%E5%A5%97%E4%BB%B6%E5%BC%B7%E7%83%88%E6%8E%A8%E8%96%A6%E6%9C%80%E7%A9%A9%E5%AE%9A';

const PROBE_TIMEOUT_MS = 8000;

// 站台 URL（wsstelnet://host/path）→ WebSocket URL。只認 WebSocket 協議的 scheme
//（探測只對 telnet-over-WebSocket 的 proxy 有意義），其他回 null。
export function siteToWsUrl(site) {
  const p = parseSite(site);
  return p && p.protocol === PROTOCOL_WEBSOCKET ? p.wsUrl : null;
}

// 試開一條 WebSocket：open ⇒ true（並立刻關掉）；error／close／逾時 ⇒ false。
export function probeWebSocket(wsUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const WebSocketImpl = opts.WebSocketImpl || globalThis.WebSocket;
  return new Promise(resolve => {
    let ws;
    let done = false;
    let timer;
    const finish = ok => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws && ws.close();
      } catch (e) {}
      resolve(ok);
    };
    try {
      ws = new WebSocketImpl(wsUrl);
    } catch (e) {
      finish(false);
      return;
    }
    ws.addEventListener('open', () => finish(true));
    ws.addEventListener('error', () => finish(false));
    ws.addEventListener('close', () => finish(false));
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

// 回傳值：
//   'disconnected' ⇒ 這次連線 open 過（中途斷線）：Origin 顯然沒問題，不探測
//   null           ⇒ 目前不是預設直連（已走 proxy、或 ?site= 自訂）：Origin 診斷不適用
//   'origin'       ⇒ 直連從未 open、proxy 通：被 Origin 白名單擋
//   'unreachable'  ⇒ 直連與 proxy 都不通：PTT 維護／網路問題
export async function diagnoseConnectFailure({ site, opened, defaultSite, proxySite, probe }) {
  if (opened) return 'disconnected';
  if (site !== defaultSite) return null;
  const wsUrl = siteToWsUrl(proxySite);
  if (!wsUrl) return 'unreachable';
  try {
    return (await probe(wsUrl)) ? 'origin' : 'unreachable';
  } catch (e) {
    return 'unreachable';
  }
}

// ---- 判斷結果＋建議清單（docs/ssh.md「失敗提示」）----
//
// 建議（suggestions）是使用者**手動按**才會生效的動作，不自動切換：
//   'proxy'         開 telnet proxy 並重連（Origin 被擋時）
//   'useSsh'        改用 SSH 協議並重連
//   'useWebsocket'  改用 WebSocket 協議並重連
//   'checkRelay'    提醒檢查設定裡的 SSH relay 位址（不是按鈕）
// 被 PTT 的 BOT 偵測封鎖時呼叫端根本不診斷（ConnectionAlert 不給 diagnose）⇒ 不會出現任何建議：
// 那時換協議也是再登入一次，只會延長封鎖。
//
// SSH 的 verdict 取自載體的斷線原因（ssh/ssh_transport.js）：
//   sshHostKey      host key 不在指紋表（relay 可能被中間人攔截）
//   sshRelay        relay 連不上／拒絕
//   sshUnreachable  relay 通、relay 連不到 PTT 的 SSH（ptt.cc:22）
//   sshUnsupported  瀏覽器不支援（WebCrypto）
//   sshProtocol     SSH 協商／認證失敗
//
// opts：
//   site／opened／closeReason   這次連線（App.connectedUrl）
//   defaultSite／proxySite／probe  見 diagnoseConnectFailure（只對 WebSocket 用）
//   canSwitch      這個環境能不能換協議（網頁：sshSupported()；APK：androidCanSetProtocol()）
//   android        APK：連線是原生本機 proxy，不跑 Origin 探測、也沒有 relay 位址可檢查
export async function adviseConnectFailure(opts) {
  const { site, opened, closeReason, canSwitch, android } = opts;
  const p = parseSite(site);
  const protocol = p ? p.protocol : null;
  if (protocol === PROTOCOL_SSH) {
    if (opened) return { verdict: 'disconnected', suggestions: [] };
    const verdict = sshVerdict(closeReason);
    const suggestions = [];
    if (canSwitch) suggestions.push('useWebsocket');
    if (verdict === 'sshRelay' && !android) suggestions.push('checkRelay');
    return { verdict, suggestions };
  }
  const verdict = android
    ? (opened ? 'disconnected' : null)
    : await diagnoseConnectFailure(opts);
  const suggestions = [];
  if (verdict === 'origin') suggestions.push('proxy');
  if (!opened && canSwitch && protocol === PROTOCOL_WEBSOCKET) suggestions.push('useSsh');
  return { verdict, suggestions };
}

function sshVerdict(reason) {
  switch (reason) {
    case 'hostkey':
      return 'sshHostKey';
    case 'relay':
      return 'sshRelay';
    case 'tcp':
      return 'sshUnreachable';
    case 'unsupported':
      return 'sshUnsupported';
    default:
      return 'sshProtocol';
  }
}
