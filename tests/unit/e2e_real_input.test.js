// 「瀏覽器負責的輸入一律要有真輸入測試」的靜態守護（2026-10）。
//
// `new XxxEvent(...)`＋`dispatchEvent` 測的是「**如果**瀏覽器送這種事件，我們會怎樣」。
// 事件的形狀（pointerType／buttons／isTrusted／clipboardData）與順序是瀏覽器決定的，
// 手捏等於把我們的假設寫進測試，用假設驗證假設。2026-10 全面改寫時實際抓到的例子：
//   - 對 InputHelper 標題列的 SVG 手捏 mousedown —— 真滑鼠在那裡根本不發 mousedown
//     （標題列 pointerdown preventDefault），測的是走不到的路徑；
//   - 手捏 drop 不經過 dragover ⇒ 拿掉 dragover 的 preventDefault（真拖放就整個壞掉）照樣綠；
//   - 手捏 blur＋立刻滾輪 ⇒ 滾輪的 e.buttons 自癒蓋掉 blur reset，那一層拿掉照樣綠。
//
// 規則：
//   e2e（tests/e2e/**/*.js）：不准 `new XxxEvent(`、`.dispatchEvent(`、直接呼叫
//     `.onKeyDown(`；送輸入一律走 page.mouse／keyboard／touchscreen 或 CDP Input.*
//     （共用 helper：tests/e2e/helpers/real_input.js）。真的做不到的寫進 E2E_EXEMPT。
//   unit（tests/unit/**）：可以手捏（用來測分支邏輯），但只要用到「瀏覽器負責」的事件
//     類型，檔案裡就必須有 `// real-input: tests/e2e/...` 指向對應的真輸入 e2e。
// 範圍界線：我們自己畫的按鈕被 fireEvent.click、鍵盤（unit 有大量純物件測試）、
// WebSocket 的 data／close 都不在範圍內。細節與對照表見 tests/e2e/README.md「真輸入」。
//
// 純靜態掃描，不連網、不開瀏覽器（比照 tests/unit/e2e_layout_settle.test.js）。
import fs from "fs";
import path from "path";

const ROOT = path.join(__dirname, "..", "..");
const E2E_DIR = path.join(ROOT, "tests", "e2e");
const UNIT_DIR = path.join(ROOT, "tests", "unit");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
    return [p];
  });
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

// 只掃**程式碼**：規範本身（含這支檔案的說明）就在談 dispatchEvent。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

// ---------------------------------------------------------------------------
// e2e
// ---------------------------------------------------------------------------

// CustomEvent 不算（那是我們自己的事件）；其餘一律算，含裸的 `new Event('blur')`。
const E2E_CTOR =
  /new\s+(?:window\.)?(?:Pointer|Mouse|Wheel|Keyboard|Clipboard|Composition|Drag|Touch|Focus|Input|UI)?Event\(\s*(['"`])([\w-]*)\1/g;

// 回傳該檔案的違規清單：{ kind, event }。event 是事件型別（或 '?' ＝看不出型別）。
export function scanE2E(src) {
  const code = stripComments(src);
  const out = [];
  for (const m of code.matchAll(E2E_CTOR)) out.push({ kind: "ctor", event: m[2] });
  const dispatches = (code.match(/\.dispatchEvent\(/g) || []).length;
  // 每一次 dispatch 都要對得上一個看得出型別的建構子；多出來的（派發變數、
  // 派發別處建好的事件）型別不明 ⇒ 一律算違規。
  const ctorCount = out.length;
  for (let i = ctorCount; i < dispatches; ++i) out.push({ kind: "dispatch", event: "?" });
  for (const _ of code.matchAll(/\.onKeyDown\(/g)) out.push({ kind: "onKeyDown", event: "keydown" });
  return out;
}

// 具名豁免：**必須寫理由**，理由要是「真輸入管線做不出這個事件」，不是「改起來麻煩」。
const TOUCH_LONG_PRESS =
  "觸控長按：桌機 Chromium 的 CDP 長按（synthesizeTapGesture duration 900／dispatchTouchEvent 按住）" +
  "不發 contextmenu（CONFIRMED，docs/mobile.md「長按選單與選取模式」），只能在 Android emulator 驗";
const E2E_EXEMPT = [
  { file: "tests/e2e/offline/mobile_reflow.offline.spec.js", event: "contextmenu", reason: TOUCH_LONG_PRESS },
  { file: "tests/e2e/offline/mobile_list_cards.offline.spec.js", event: "contextmenu", reason: TOUCH_LONG_PRESS },
];

const e2eFiles = walk(E2E_DIR).filter((p) => /\.js$/.test(p));

// ---------------------------------------------------------------------------
// unit
// ---------------------------------------------------------------------------

// 「瀏覽器負責形狀或順序」的事件型別（右鍵、觸控、滑鼠移動／按下、滾輪、捲動、拖放、
// 剪貼簿、IME、焦點、全螢幕、圖片 load/error）。鍵盤刻意不列：unit 有大量以純物件
// 驅動 TermKeyboard 的測試，事件形狀不是它們的重點。
const UNIT_TYPES = [
  "contextmenu", "wheel", "scroll", "scrollend",
  "paste", "copy", "cut",
  "compositionstart", "compositionupdate", "compositionend",
  "dragenter", "dragover", "dragleave", "drop",
  "fullscreenchange", "load", "error",
  "pointerdown", "pointermove", "pointerup", "pointercancel",
  "touchstart", "touchmove", "touchend",
  "mousemove", "mouseover", "mouseout", "mousedown", "mouseup",
  "blur", "focus", "focusin", "focusout",
];
const UNIT_CTOR = new RegExp(
  `new\\s+(?:window\\.)?\\w*Event\\(\\s*(['"\`])(${UNIT_TYPES.join("|")})\\1`,
  "g",
);
const FIRE_NAMES = {
  contextMenu: "contextmenu", wheel: "wheel", scroll: "scroll",
  paste: "paste", copy: "copy", cut: "cut",
  compositionStart: "compositionstart", compositionUpdate: "compositionupdate",
  compositionEnd: "compositionend",
  dragEnter: "dragenter", dragOver: "dragover", dragLeave: "dragleave", drop: "drop",
  load: "load", error: "error",
  pointerDown: "pointerdown", pointerMove: "pointermove", pointerUp: "pointerup",
  touchStart: "touchstart", touchMove: "touchmove", touchEnd: "touchend",
  mouseMove: "mousemove", mouseOver: "mouseover", mouseOut: "mouseout",
  mouseDown: "mousedown", mouseUp: "mouseup",
  blur: "blur", focus: "focus", focusIn: "focusin", focusOut: "focusout",
};
const UNIT_FIRE = new RegExp(`fireEvent\\.(${Object.keys(FIRE_NAMES).join("|")})\\(`, "g");

export function scanUnit(src) {
  const code = stripComments(src);
  const found = new Set();
  for (const m of code.matchAll(UNIT_CTOR)) found.add(m[2]);
  for (const m of code.matchAll(UNIT_FIRE)) found.add(FIRE_NAMES[m[1]]);
  return [...found].sort();
}

export function realInputPointers(src) {
  return Array.from(src.matchAll(/\/\/\s*real-input:\s*(\S+)/g)).map((m) => m[1]);
}

// unit 的豁免：真輸入 e2e 做不到，或該事件的形狀對結果毫無影響（同「自己畫的按鈕」）。
const UNIT_EXEMPT = {
  "tests/unit/inline_video_fullscreen.test.jsx":
    "全螢幕鈕在 <video> 的 UA shadow DOM 控制列裡，Playwright 點不到；cassette 也沒有原生 <video>",
  "tests/unit/pref_modal_autologin_tab.test.jsx":
    "blur 只當「欄位編輯結束」的時機，欄位是我們自己畫的輸入框，事件形狀不影響結果",
};

const unitFiles = walk(UNIT_DIR).filter((p) => /\.test\.jsx?$/.test(p));

// ---------------------------------------------------------------------------

describe("e2e 只走真輸入管線", () => {
  test("掃描範圍不是空的（目錄結構改了要在這裡發現，不能靜默通過）", () => {
    expect(e2eFiles.length).toBeGreaterThanOrEqual(50);
    expect(e2eFiles.map(rel)).toContain("tests/e2e/helpers/real_input.js");
  });

  test("沒有手捏事件、dispatchEvent 或直呼 onKeyDown（豁免名單除外）", () => {
    const offenders = [];
    for (const f of e2eFiles) {
      const file = rel(f);
      const allowed = new Set(E2E_EXEMPT.filter((e) => e.file === file).map((e) => e.event));
      const hits = scanE2E(fs.readFileSync(f, "utf8"));
      // 豁免是「該檔＋該事件型別」：dispatch 只有在同檔所有建構子都被豁免時才算數。
      const ctorAllExempt = hits.filter((h) => h.kind === "ctor").every((h) => allowed.has(h.event));
      for (const h of hits) {
        if (h.kind === "ctor" && allowed.has(h.event)) continue;
        if (h.kind === "dispatch" && allowed.size && ctorAllExempt) continue;
        offenders.push(`${file}: ${h.kind} ${h.event}`);
      }
    }
    expect(offenders, "改用 tests/e2e/helpers/real_input.js；真的做不到就寫進 E2E_EXEMPT 並附理由").toEqual([]);
  });

  test("豁免名單沒有過期（每一條都還對得上一個手捏事件）", () => {
    for (const e of E2E_EXEMPT) {
      const p = path.join(ROOT, e.file);
      expect(fs.existsSync(p), `豁免名單指到不存在的檔案：${e.file}`).toBe(true);
      const hits = scanE2E(fs.readFileSync(p, "utf8"));
      expect(
        hits.some((h) => h.kind === "ctor" && h.event === e.event),
        `${e.file} 已經不手捏 ${e.event} 了，把這條豁免拿掉`,
      ).toBe(true);
      expect(e.reason.length).toBeGreaterThan(10);
    }
  });
});

describe("unit 的手捏瀏覽器事件要指向真輸入 e2e", () => {
  test("用到瀏覽器負責的事件 ⇒ 有 // real-input: 指向存在的 e2e 檔（或在豁免名單）", () => {
    const offenders = [];
    for (const f of unitFiles) {
      const file = rel(f);
      if (file === "tests/unit/e2e_real_input.test.js") continue; // 自己的自測字串
      const src = fs.readFileSync(f, "utf8");
      const types = scanUnit(src);
      if (!types.length || UNIT_EXEMPT[file]) continue;
      const ptrs = realInputPointers(src);
      if (!ptrs.length) {
        offenders.push(`${file}（${types.join(",")}）缺 // real-input: tests/e2e/...`);
        continue;
      }
      for (const p of ptrs) {
        if (!p.startsWith("tests/e2e/") || !fs.existsSync(path.join(ROOT, p))) {
          offenders.push(`${file}：real-input 指到不存在的 e2e 檔 ${p}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("unit 豁免名單沒有過期", () => {
    for (const [file, reason] of Object.entries(UNIT_EXEMPT)) {
      const p = path.join(ROOT, file);
      expect(fs.existsSync(p), `豁免名單指到不存在的檔案：${file}`).toBe(true);
      expect(scanUnit(fs.readFileSync(p, "utf8")).length, `${file} 已不用瀏覽器事件，拿掉豁免`).toBeGreaterThan(0);
      expect(reason.length).toBeGreaterThan(10);
    }
  });
});

// 掃描器壞掉（regex 寫錯、strip 吃太多）時上面那幾條會一直綠 ⇒ 用違規字串自測。
describe("掃描器自測", () => {
  test("e2e：各種手捏寫法都抓得到", () => {
    const kinds = (s) => scanE2E(s).map((h) => `${h.kind}:${h.event}`);
    expect(kinds("el.dispatchEvent(new MouseEvent('contextmenu', {}));")).toEqual([
      "ctor:contextmenu",
    ]);
    expect(kinds("w.dispatchEvent(new window.WheelEvent(\"wheel\", { deltaY: 1 }));")).toEqual([
      "ctor:wheel",
    ]);
    expect(kinds("window.dispatchEvent(new Event('blur'));")).toEqual(["ctor:blur"]);
    expect(kinds("const ev = makeIt(); el.dispatchEvent(ev);")).toEqual(["dispatch:?"]);
    expect(kinds("a.view.onKeyDown(x);")).toEqual(["onKeyDown:keydown"]);
    expect(kinds("t.dispatchEvent(new CompositionEvent('compositionend', {}));")).toEqual([
      "ctor:compositionend",
    ]);
    expect(kinds("x.dispatchEvent(new DragEvent('drop', {}));")).toEqual(["ctor:drop"]);
  });

  test("e2e：註解與 CustomEvent 不算", () => {
    expect(scanE2E("// el.dispatchEvent(new MouseEvent('click'))\n")).toEqual([]);
    expect(scanE2E("/* el.dispatchEvent(new MouseEvent('click')) */\n")).toEqual([]);
    expect(scanE2E("new CustomEvent('x-ours')")).toEqual([]);
    expect(scanE2E("await page.mouse.click(1, 2, { button: 'right' });")).toEqual([]);
  });

  test("unit：建構子與 fireEvent 兩種寫法都抓得到，自畫按鈕的 click 不算", () => {
    expect(scanUnit("main.dispatchEvent(new window.Event(\"scroll\"));")).toEqual(["scroll"]);
    expect(scanUnit("fireEvent.paste(textarea(), {});")).toEqual(["paste"]);
    expect(scanUnit("fireEvent.pointerDown(el); fireEvent.mouseMove(el);")).toEqual([
      "mousemove",
      "pointerdown",
    ]);
    expect(scanUnit("fireEvent.click(button);")).toEqual([]);
    expect(scanUnit("fireEvent.keyDown(box, { key: 'Enter' });")).toEqual([]);
  });

  test("real-input 註解解析", () => {
    expect(
      realInputPointers("// real-input: tests/e2e/offline/a.offline.spec.js\n// real-input: tests/e2e/b.spec.js"),
    ).toEqual(["tests/e2e/offline/a.offline.spec.js", "tests/e2e/b.spec.js"]);
  });
});
