// real-input: tests/e2e/offline/mobile_refresh.offline.spec.js
// 手機下拉重整（src/js/pull_refresh.js）：位移→狀態的純函式，以及「原生 pull-to-refresh
// 必須關掉、但只能關 y 軸」這條 CSS 不變量（理由見 pull_refresh.js 檔頭）。
import fs from "node:fs";
import path from "node:path";
import {
  pullState,
  PULL_RESISTANCE,
  PULL_THRESHOLD_PX,
  PULL_MAX_PX,
} from "../../src/js/pull_refresh";

describe("pullState", () => {
  test("slop 內 ⇒ idle（還不決定方向）", () => {
    expect(pullState(2, 5).state).toBe("idle");
  });
  test("往上、或水平主導 ⇒ cancel（不是下拉；不搶捲動與返回手勢）", () => {
    expect(pullState(0, -40).state).toBe("cancel");
    expect(pullState(60, 30).state).toBe("cancel");
  });
  test("往下：未過門檻 pull、過門檻 armed；位移有阻尼與上限", () => {
    const below = (PULL_THRESHOLD_PX / PULL_RESISTANCE) - 2;
    expect(pullState(0, below).state).toBe("pull");
    const r = pullState(0, PULL_THRESHOLD_PX / PULL_RESISTANCE);
    expect(r.state).toBe("armed");
    expect(r.offset).toBe(PULL_THRESHOLD_PX);
    expect(pullState(0, 5000).offset).toBe(PULL_MAX_PX);
  });
});

describe("CSS：手機版面關掉原生 pull-to-refresh（只動 y 軸）", () => {
  const css = fs
    .readFileSync(path.join(process.cwd(), "src/css/main.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  test("html／body 在 mobile-layout 下有 overscroll-behavior-y: contain", () => {
    const m = /html:has\(body\.mobile-layout\),\s*body\.mobile-layout\s*\{([^}]*)\}/.exec(css);
    expect(m).not.toBeNull();
    expect(m[1]).toMatch(/overscroll-behavior-y\s*:\s*contain/);
    // 兩軸簡寫或 x 軸會連瀏覽器返回導航一起關掉（native_gesture_css.test.js）。
    expect(m[1]).not.toMatch(/overscroll-behavior(-x|-inline)?\s*:/);
  });
});
