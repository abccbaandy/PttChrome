// 迴歸守護：`yarn kill:dev` 在 Windows 靜默失效 → dev server 殘留佔著 8080。
//
// 根因：Vite 在本機只綁 IPv6 loopback（`TCP [::1]:8080 … LISTENING <pid>`），
// 而舊版腳本用 `netstat -ano -p tcp`——該旗標**只列 IPv4**，IPv6 的 listener 完全
// 不在輸出裡 → 找不到 PID → 什麼都沒殺，且因為腳本永遠 exit 0 而毫無錯誤訊息。
//
// 這裡把「netstat 輸出 → PID 清單」抽成純函式守護，兩種位址族都必須抓得到。

import { parseListeningPids } from "../../scripts/kill-dev-server.js";

const PORT = 8080;

describe("kill-dev-server：netstat 輸出解析", () => {
  test("IPv6-only listener（Vite 本機常態）也要抓到 PID", () => {
    const out = [
      "  TCP    [::1]:8080             [::]:0                 LISTENING       8440",
    ].join("\n");
    expect(parseListeningPids(out, PORT)).toEqual(["8440"]);
  });

  test("IPv4 listener 照舊抓得到", () => {
    const out = [
      "  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       1234",
    ].join("\n");
    expect(parseListeningPids(out, PORT)).toEqual(["1234"]);
  });

  test("同時 IPv4/IPv6 → 去重", () => {
    const out = [
      "  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       777",
      "  TCP    [::1]:8080             [::]:0                 LISTENING       777",
    ].join("\n");
    expect(parseListeningPids(out, PORT)).toEqual(["777"]);
  });

  test("非 LISTENING、他埠、以 8080 為來源埠的連線都不算", () => {
    const out = [
      "  TCP    127.0.0.1:8080         127.0.0.1:5566         ESTABLISHED     42",
      "  TCP    0.0.0.0:18080          0.0.0.0:0              LISTENING       43",
      "  TCP    0.0.0.0:80800          0.0.0.0:0              LISTENING       44",
      "  TCP    127.0.0.1:5566         127.0.0.1:8080         ESTABLISHED     45",
    ].join("\n");
    expect(parseListeningPids(out, PORT)).toEqual([]);
  });

  test("PID 0（Idle）不回傳", () => {
    const out = "  TCP    [::]:8080              [::]:0                 LISTENING       0";
    expect(parseListeningPids(out, PORT)).toEqual([]);
  });

  test("lsof 風格（非 Windows）：一行一個 PID", () => {
    expect(parseListeningPids("911\n912\n", PORT, { lsof: true })).toEqual([
      "911",
      "912",
    ]);
  });
});
