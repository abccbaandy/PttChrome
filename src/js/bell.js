// 終端機提示音：PTT 送 BEL（^G，0x07）時發出一聲短嗶。
//
// PTT 真的會送：pttbbs 的 bell()（mbbsd/term.c）就是 write(1, Ctrl('G'), 1)，
// 被 captcha、象棋／暗棋、水球（ccw.c）、admin 等處呼叫。上游的 term_buf.puts()
// 從第一天起就 `case '\x07': continue`（原地留著一行 "FIXME: beep …"）直接吞掉。
//
// 為什麼用 Web Audio 合成而不是放音源檔：一聲 80 ms 的正弦波用 OscillatorNode +
// GainNode 就夠，零資產檔、零 bundle 成本，也不必處理 <audio> 的載入時序。
//
// autoplay 政策：AudioContext 在頁面取得使用者手勢（sticky activation）之前建立
// 會停在 suspended。這裡**延遲到第一次真的要響才建**——BBS 是打字介面，能收到
// server 的 BEL 就代表使用者早已按過鍵，那時建出來的 context 直接是 running。
// 仍然防禦性呼叫一次 resume()，並且**全程不 throw**：呼叫點在 puts() 的熱路徑上。
//
// 節流：水球與棋類會連發 ^G，密集的嗶聲比沒有聲音更糟，所以最小間隔內只響一次。

const MIN_INTERVAL_MS = 150;
const FREQ_HZ = 880; // A5，落在終端機提示音的傳統音域，又不刺耳
const DURATION_S = 0.08;
const RAMP_S = 0.005; // 淡入淡出，沒有它方波邊緣會爆音（click）
const PEAK_GAIN = 0.08;

let enabled = false;
let ctx = null;
let lastRingAt = -Infinity;
let contextFactory = () => new window.AudioContext();

// 純決策，抽出來讓 unit 測得到（jsdom 沒有 Web Audio）。
export function shouldRing(now, state) {
  if (!state.enabled) return false;
  const interval =
    state.minIntervalMs === undefined ? MIN_INTERVAL_MS : state.minIntervalMs;
  return now - state.lastRingAt >= interval;
}

export function setBellEnabled(on) {
  enabled = !!on;
}

export function isBellEnabled() {
  return enabled;
}

// 回傳「這次到底有沒有響」，讓呼叫端／測試看得出節流有沒有生效。
export function ringBell(now = Date.now()) {
  if (!shouldRing(now, { enabled, lastRingAt })) return false;
  lastRingAt = now;
  try {
    if (!ctx) ctx = contextFactory();
    if (!ctx) return false;
    if (ctx.state === "suspended" && ctx.resume) ctx.resume();

    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = FREQ_HZ;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(PEAK_GAIN, t0 + RAMP_S);
    gain.gain.setValueAtTime(PEAK_GAIN, t0 + DURATION_S - RAMP_S);
    gain.gain.linearRampToValueAtTime(0, t0 + DURATION_S);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.onended = () => {
      // 播完就拆，否則每一聲都留一組節點掛在 destination 上。
      try {
        osc.disconnect();
        gain.disconnect();
      } catch (e) {
        /* 已經拆過就算了 */
      }
    };
    osc.start(t0);
    osc.stop(t0 + DURATION_S);
    return true;
  } catch (e) {
    // 不支援 Web Audio、context 建不出來、分頁被凍結……一律當作沒響。這個函式
    // 在 term_buf.puts() 的逐字元迴圈裡被呼叫，絕不能讓它中斷畫面解析。
    return false;
  }
}

// 測試用：換掉 AudioContext 工廠並重置節流／快取的 context。
export function __resetBellForTest(factory) {
  contextFactory = factory || (() => new window.AudioContext());
  ctx = null;
  lastRingAt = -Infinity;
  enabled = false;
}
