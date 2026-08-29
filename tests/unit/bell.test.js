import {
  ringBell,
  setBellEnabled,
  isBellEnabled,
  shouldRing,
  __resetBellForTest,
} from "../../src/js/bell";
// **檔案層級 import，不要改回 test 內 `await import()`**：載入 App 會拖進整條主程式
// 依賴鏈，冷載入（這支檔名排序靠前，整批跑時往往由它付這筆成本）在機器忙時超過
// vitest 預設的 5000ms testTimeout ⇒ 該 case 偶發紅，單獨重跑又全綠（2026-08-29 實錄）。
// 放檔案層級，載入成本就不算進任何一條 case 的預算裡。
import { App } from "../../src/js/pttchrome";

// 終端機提示音（PTT 的 ^G）。jsdom 沒有 Web Audio，所以 AudioContext 用可注入的
// 假工廠；真正要守的是三件事：pref 關著就不出聲、連發只響一次、任何情況下都不 throw
// （呼叫點在 term_buf.puts() 的逐字元迴圈裡，丟例外等於整個畫面解析中斷）。
function fakeAudio() {
  const started = [];
  const nodes = { oscillators: [], gains: [] };
  const param = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  });
  const ctx = {
    state: "running",
    currentTime: 0,
    resume: vi.fn(),
    destination: { id: "destination" },
    createOscillator() {
      const o = {
        type: "",
        frequency: param(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn((t) => started.push(t)),
        stop: vi.fn(),
      };
      nodes.oscillators.push(o);
      return o;
    },
    createGain() {
      const g = { gain: param(), connect: vi.fn(), disconnect: vi.fn() };
      nodes.gains.push(g);
      return g;
    },
  };
  return { ctx, nodes, started };
}

describe("終端機提示音", () => {
  describe("shouldRing（純決策）", () => {
    test("pref 關著就不響", () => {
      expect(shouldRing(1000, { enabled: false, lastRingAt: -Infinity })).toBe(
        false
      );
    });

    test("第一次一定響", () => {
      expect(shouldRing(1000, { enabled: true, lastRingAt: -Infinity })).toBe(
        true
      );
    });

    test("最小間隔內的第二次被吃掉（水球／棋類會連發 ^G）", () => {
      expect(
        shouldRing(1100, { enabled: true, lastRingAt: 1000, minIntervalMs: 150 })
      ).toBe(false);
      expect(
        shouldRing(1150, { enabled: true, lastRingAt: 1000, minIntervalMs: 150 })
      ).toBe(true);
    });
  });

  // pref → 模組狀態的接線。onPrefChange 把所有錯誤都吃掉（`catch { return }`），
  // 少接一條 case 不會有任何徵兆，只能靠測試釘住。
  describe("接到 pref", () => {
    test("onPrefChange('enableBell') 會轉成模組狀態", () => {
      const app = Object.create(App.prototype);
      __resetBellForTest(() => ({}));

      app.onPrefChange("enableBell", true);
      expect(isBellEnabled()).toBe(true);
      app.onPrefChange("enableBell", false);
      expect(isBellEnabled()).toBe(false);
    });
  });

  describe("ringBell", () => {

    test("pref 關著：完全不碰 AudioContext", () => {
      const factory = vi.fn(() => fakeAudio().ctx);
      __resetBellForTest(factory);
      expect(ringBell(1000)).toBe(false);
      expect(factory).not.toHaveBeenCalled();
    });

    test("開啟後響一聲：接上 oscillator→gain→destination 並排好起停", () => {
      const audio = fakeAudio();
      __resetBellForTest(() => audio.ctx);
      setBellEnabled(true);

      expect(ringBell(1000)).toBe(true);
      expect(audio.nodes.oscillators).toHaveLength(1);
      const osc = audio.nodes.oscillators[0];
      const gain = audio.nodes.gains[0];
      expect(osc.connect).toHaveBeenCalledWith(gain);
      expect(gain.connect).toHaveBeenCalledWith(audio.ctx.destination);
      expect(osc.start).toHaveBeenCalled();
      expect(osc.stop).toHaveBeenCalled();
    });

    test("連發：最小間隔內不會再生出第二組節點", () => {
      const audio = fakeAudio();
      __resetBellForTest(() => audio.ctx);
      setBellEnabled(true);

      expect(ringBell(1000)).toBe(true);
      expect(ringBell(1010)).toBe(false);
      expect(ringBell(1149)).toBe(false);
      expect(ringBell(1150)).toBe(true);
      expect(audio.nodes.oscillators).toHaveLength(2);
    });

    test("AudioContext 只建一次（每聲都新建會很快撞到瀏覽器上限）", () => {
      const audio = fakeAudio();
      const factory = vi.fn(() => audio.ctx);
      __resetBellForTest(factory);
      setBellEnabled(true);

      ringBell(1000);
      ringBell(2000);
      expect(factory).toHaveBeenCalledTimes(1);
    });

    test("播完把節點拆掉，不留在 destination 上", () => {
      const audio = fakeAudio();
      __resetBellForTest(() => audio.ctx);
      setBellEnabled(true);
      ringBell(1000);

      const osc = audio.nodes.oscillators[0];
      const gain = audio.nodes.gains[0];
      osc.onended();
      expect(osc.disconnect).toHaveBeenCalled();
      expect(gain.disconnect).toHaveBeenCalled();
    });

    test("suspended 的 context 會被 resume（autoplay 政策）", () => {
      const audio = fakeAudio();
      audio.ctx.state = "suspended";
      __resetBellForTest(() => audio.ctx);
      setBellEnabled(true);
      ringBell(1000);
      expect(audio.ctx.resume).toHaveBeenCalled();
    });

    test("環境不支援（工廠直接爆）也不能 throw —— 呼叫點在 puts() 熱路徑上", () => {
      __resetBellForTest(() => {
        throw new Error("AudioContext is not defined");
      });
      setBellEnabled(true);
      expect(() => ringBell(1000)).not.toThrow();
      expect(ringBell(2000)).toBe(false);
    });
  });
});
