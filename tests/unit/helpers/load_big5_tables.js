// Load the real Big5<->Unicode tables into the global `lib` for unit tests that push
// raw cassette bytes through the real TermBuf/AnsiParser. string_util.b2u/u2b
// read the bare global `lib`; the browser bootstrap (src/js/main.jsx#loadResources)
// sets window.lib, and in the browser globalThis IS window（node 下則直接掛在 globalThis）.
// TermBuf.setPageState calls getRowText -> b2u on every notify, so feeding real
// bytes without the tables throws.
//
// 同一份 helper 給 node project 與 browser project 共用 ⇒ 不能碰 fs／Buffer。
// `?inline` 讓 Vite 把 .bin 內嵌成 base64 data URL（兩邊都走 Vite transform），
// 再用兩邊都有的 atob 解回位元組。
import b2uDataUrl from "../../../src/conv/b2u_table.bin?inline";
import u2bDataUrl from "../../../src/conv/u2b_table.bin?inline";

function dataUrlBytes(url) {
  const bin = atob(url.slice(url.indexOf(",") + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function loadBig5Tables() {
  globalThis.lib = globalThis.lib || {};
  if (globalThis.lib.b2uArray) return;
  globalThis.lib.b2uArray = dataUrlBytes(b2uDataUrl);
  globalThis.lib.u2bArray = dataUrlBytes(u2bDataUrl);
}

// Decode a cassette step's recv (base64 of latin1 bytes) into the string form
// AnsiParser.feed expects (one char per byte). atob 正好回傳 latin1 字串。
export function decodeRecv(recv) {
  return atob(recv);
}
