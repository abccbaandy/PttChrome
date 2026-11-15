// 本專案自己的 lint 規則（tools/lint/pttchrome_rules.mjs）的守護自證，以及「設定沒被關掉」。
// 真正掃 src 的是 `yarn lint`（CI test-unit job）；這裡只證明規則抓得到該抓的、不誤判該放的，
// 並鎖住設定檔：規則對整個 src 開著、豁免只有列出的那幾個檔。
import fs from "node:fs";
import path from "node:path";
import { RuleTester } from "oxlint/plugins-dev";
import plugin from "../../tools/lint/pttchrome_rules.mjs";

const tester = new RuleTester({ languageOptions: { sourceType: "module" } });
const bad = (code, n = 1) => ({ code, errors: n });

describe("pttchrome/no-magic-page-state", () => {
  tester.run("no-magic-page-state", plugin.rules["no-magic-page-state"], {
    valid: [
      "if (pageState === PAGE_STATE.READING) {}",
      "// pageState === 3 這種寫法會被擋",
      "const s = 'pageState == 3';",
      "const pageStateOverride = 5;",
      "if (a.pageState == b.pageState) {}",
      "switch (pageState) { case PAGE_STATE.MENU: break; }",
      "switch (kind) { case 3: break; }",
      "x.rows === 24;",
    ],
    invalid: [
      bad("if (this.buf.pageState == 3) {}"),
      bad("buf?.pageState === 2 && go();"),
      bad("if (3 === pageState) x();"),
      bad("this.prevPageState = 0;"),
      bad("settledPageState !== 1;"),
      bad("let lastPageState = -1;"),
      bad("class A { pageState = 0; }"),
      bad("if (buf['pageState'] > 4) {}"),
      // regex 版抓不到的：switch 的 case。
      bad("switch (o.pageState) { case 2: case 4: break; case PAGE_STATE.MENU: break; }", 2),
    ],
  });
});

describe("pttchrome/no-direct-conn-send", () => {
  tester.run("no-direct-conn-send", plugin.rules["no-direct-conn-send"], {
    valid: [
      "this.view._send('x');",
      "sendBytes(conn, WIRE_SOURCE.KEY, 'x');",
      "socket.send(data);",
      "this.connection.send('x');",
      "conn.close();",
      "const s = 'this.conn.send(x)';",
      "// conn.send(x)",
    ],
    invalid: [
      bad('this.conn.send("x");'),
      bad("pttchrome.conn.convSend(t);"),
      bad("conn.sendNaws(1, 2);"),
      bad("this.conn.sendUserKey(d);"),
      bad("this._conn?.sendTimingMark();"),
      bad("core.conn.convSendUserKey(k);"),
      bad("conn.sendWillNaws();"),
      // regex 版抓不到的寫法。
      bad("conn['send']('x');"),
      bad("this.conn.send.call(this.conn, 'x');"),
      bad("conn.send.apply(conn, args);"),
    ],
  });
});

describe("pttchrome/no-modal-shown-assign", () => {
  tester.run("no-modal-shown-assign", plugin.rules["no-modal-shown-assign"], {
    valid: [
      "if (app.modalShown) {}",
      "const shown = this.modalShown;",
      "app.setModalOpen('pref', true);",
      "let modalShown = false;", // 區域變數不是 App 的狀態
    ],
    invalid: [
      bad("this.modalShown = true;"),
      bad("pttchrome.modalShown = false;"),
      bad("app['modalShown'] = !!x;"),
      bad("core.modalShown ||= true;"),
    ],
  });
});

describe(".oxlintrc.json 有開這些規則", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".oxlintrc.json"), "utf8"));
  const RULES = Object.keys(plugin.rules).map((r) => `pttchrome/${r}`);

  test("plugin 有載入、三條規則對整個 src 是 error", () => {
    expect(cfg.jsPlugins).toContain("./tools/lint/pttchrome_rules.mjs");
    const src = cfg.overrides.find((o) => o.files.length === 1 && o.files[0] === "src/**");
    expect(src, "overrides 要有一段 files: [\"src/**\"]").toBeTruthy();
    for (const r of RULES) expect(src.rules[r], r).toBe("error");
  });

  test("豁免只有定義處與傳輸層（新增豁免要在這裡說理由）", () => {
    const offs = {};
    for (const o of cfg.overrides)
      for (const [r, v] of Object.entries(o.rules || {}))
        if (r.startsWith("pttchrome/") && v === "off") (offs[r] ||= []).push(...o.files);
    expect(offs).toEqual({
      // PAGE_STATE 常數本身。
      "pttchrome/no-magic-page-state": ["src/js/screen_model.js"],
      // 出口本身、定義送出方法的傳輸層。
      "pttchrome/no-direct-conn-send": [
        "src/js/wire_send.js",
        "src/js/telnet.js",
        "src/js/websocket.js",
        "src/js/ssh/ssh_transport.js",
      ],
    });
  });

  test("modalShown 的 disable 註解只有 setModalOpen 那兩行（初值＋唯一寫入點）", () => {
    const code = fs.readFileSync(path.join(process.cwd(), "src/js/pttchrome.jsx"), "utf8");
    expect(code.match(/oxlint-disable[\w-]*\s+pttchrome\/no-modal-shown-assign/g)).toHaveLength(2);
  });
});
