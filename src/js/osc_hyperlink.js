// OSC 8 超連結（`ESC ] 8 ; params ; URI ST`）的純邏輯：解析 payload、把 URI 轉成
// 可以放進 href 的字串。無 DOM／無網路，守護 tests/unit/osc_hyperlink.test.js。
//
// server 端（CONFIRMED @ 3rd_script/pttbbs）：
//   - pfterm.c#fterm_rawurl 只送兩種形狀：開 `ESC]8;;<url>ESC\`、關 `ESC]8;;ESC\`
//     （params 永遠是空的，終止子永遠是 7-bit ST）。
//   - URL 來源是 pmore 的 markdown `[text](url)`（common/sys/string.c
//     #match_markdown_url：只收 http:// / https://，不含空白與 `(`，但**不擋**
//     非 ASCII 位元組與其他控制字元），pmore 自己的 url_buf 上限 1024。
//   - pfterm 以「目前的 url id」逐格標記，換列／游標移動都不會自動關掉連結 ⇒ client
//     必須照 OSC 8 規格做「游標狀態」而不是「成對標籤」。
//
// client 端的安全規則（PTT 公告第 3 點）：只放行 http/https。server 端雖然也擋，
// 但 client 不能假設所有 OSC 8 都來自 pmore。

// payload 的保險絲。解析器只在 OSC 內累積到這個長度為止，超過就把整條當作
// 「無效連結」（等同關閉），但仍然吃到終止子，不把殘渣印到畫面上。
// 取 4096：pmore 上限 1024，放寬四倍仍遠小於任何會拖慢逐 byte 迴圈的量。
export const OSC_PAYLOAD_MAX = 4096;

const SAFE_SCHEME_RE = /^https?:\/\/[^\s]/i;

// OSC payload（`ESC ]` 之後、終止子之前）→
//   null                 ＝不是 OSC 8（例如 `0;title`），呼叫端什麼都不做
//   { uri: '' }          ＝關閉連結
//   { uri: '<raw>' }     ＝開啟連結；raw 是線上的原始位元組（latin1 字串）
export function parseOsc8(payload) {
  if (typeof payload !== 'string' || payload.slice(0, 2) !== '8;') return null;
  const sep = payload.indexOf(';', 2);
  // `8;params` 沒有第二個分號＝格式不對；當成關閉最安全（不會把後面的字連錯）。
  if (sep < 0) return { uri: '' };
  // URI 本身可以含 `;`，所以只切第一刀。
  return { uri: payload.slice(sep + 1) };
}

// 原始 URI（latin1 位元組字串）→ href，不安全或無效時回 ''。
//   decodeBig5：把 Big5 位元組解成 Unicode 的函式（string_util.b2u）；只有 URI 含
//   非 ASCII 位元組時才會呼叫，所以測試純 ASCII 情形可以不給。
export function oscHyperlinkHref(raw, decodeBig5) {
  if (!raw) return '';
  // 控制字元（含 DEL）不可能出現在合法 URI 裡；出現就整條不收，不嘗試「修好」。
  if (/[\x00-\x1f\x7f]/.test(raw)) return '';
  let uri = raw;
  if (/[^\x00-\x7f]/.test(uri)) {
    if (!decodeBig5) return '';
    uri = decodeBig5(uri);
  }
  if (!SAFE_SCHEME_RE.test(uri)) return '';
  // 只把非 ASCII 字元做百分比編碼：整條丟給 encodeURI 會把原本就有的 `%xx`
  // 再編一次（`%` → `%25`）而壞掉。
  return uri.replace(/[^\x00-\x7f]+/g, (s) => encodeURI(s));
}
