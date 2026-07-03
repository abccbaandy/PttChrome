// Load the real Big5<->Unicode tables into window.lib for unit tests that push
// raw cassette bytes through the real TermBuf/AnsiParser. string_util.b2u/u2b
// read the bare global `lib` (= window.lib in jsdom), exactly like the browser
// bootstrap in src/js/main.js#loadResources — TermBuf.setPageState calls
// getRowText -> b2u on every notify, so feeding real bytes without the tables
// throws. Reads the same .bin files the app fetches, synchronously from disk.
import fs from "fs";
import path from "path";

export function loadBig5Tables() {
  window.lib = window.lib || {};
  if (window.lib.b2uArray) return;
  const dir = path.join(__dirname, "..", "..", "..", "src", "conv");
  window.lib.b2uArray = new Uint8Array(
    fs.readFileSync(path.join(dir, "b2u_table.bin"))
  );
  window.lib.u2bArray = new Uint8Array(
    fs.readFileSync(path.join(dir, "u2b_table.bin"))
  );
}

// Decode a cassette step's recv (base64 of latin1 bytes) into the string form
// AnsiParser.feed expects (one char per byte).
export function decodeRecv(recv) {
  return Buffer.from(recv, "base64").toString("latin1");
}
